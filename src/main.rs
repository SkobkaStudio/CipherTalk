//! Точка входа мессенджера: конфиг, подключение к rqlite, миграции,
//! сборка роутера axum (API + JWT-мидлварь + WebSocket + статика) и запуск.

mod config;
mod controllers;
mod db;
mod middleware;
mod models;
mod services;
mod utils;
mod ws;

use crate::config::Config;
use crate::db::Db;
use crate::ws::AppState;
use axum::routing::{get, post};
use axum::Router;
use std::net::SocketAddr;
use std::sync::Arc;
use tower_http::cors::CorsLayer;
use tower_http::services::ServeDir;

/// Проверка живости: GET /healthz -> "ok"
async fn healthz() -> &'static str {
    "ok"
}

#[tokio::main]
async fn main() {
    // Логирование через tracing-subscriber
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    let cfg = Config::from_env();
    println!(
        "Конфигурация: PORT={}, RQLITE_URL={}",
        cfg.port, cfg.rqlite_url
    );

    // Подключение к rqlite: без него приложение бессмысленно — падаем с подсказкой
    let db = Db::new(cfg.rqlite_url.clone());
    if let Err(e) = db.check_connection().await {
        eprintln!("ОШИБКА: {e}");
        std::process::exit(1);
    }
    if let Err(e) = db.migrate().await {
        eprintln!("ОШИБКА миграций: {e}");
        std::process::exit(1);
    }
    tracing::info!("Схема rqlite готова");

    // Broadcast-канал для WS-событий (буфер 1024 сообщения)
    let (tx, _rx_stub) = tokio::sync::broadcast::channel::<crate::models::message::Message>(1024);
    let state = Arc::new(AppState {
        db,
        jwt_secret: cfg.jwt_secret.clone(),
        tx: Arc::new(tx),
    });
    let _ = _rx_stub; // сам канал живёт в AppState

    // Публичная часть API (без JWT)
    let public = Router::new()
        .route("/api/register", post(controllers::auth::register))
        .route("/api/login", post(controllers::auth::login));

    // Защищённая часть API: мидлварь require_auth проверяет Bearer JWT
    let protected = Router::new()
        .route("/api/chats", get(controllers::chats::list).post(controllers::chats::create))
        .route("/api/chats/:id/join", post(controllers::chats::join))
        .route(
            "/api/chats/:id/messages",
            get(controllers::messages::list).post(controllers::messages::send),
        )
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            middleware::require_auth,
        ));

    let app = Router::new()
        .route("/healthz", get(healthz))
        .route("/ws", get(ws::ws_handler))
        .merge(public)
        .merge(protected)
        // Статика фронтенда из web/ (index.html, app.js, style.css)
        .fallback_service(ServeDir::new("web"))
        // CORS: разрешаем всё — фронтенд может открываться с file:// или другого порта
        .layer(CorsLayer::permissive())
        .with_state(state.clone());

    let addr = SocketAddr::from(([0, 0, 0, 0], cfg.port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("не удалось привязаться к порту");
    tracing::info!("HTTP сервер запущен на http://{} (порт {})", addr, cfg.port);
    axum::serve(listener, app).await.expect("сервер завершился с ошибкой");
}
