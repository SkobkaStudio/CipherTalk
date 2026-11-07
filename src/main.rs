//! Точка входа CipherTalk.
//!
//! Собирает приложение по MVC-слоям, проверяет доступность rqlite, применяет
//! миграции, поднимает HTTP + WebSocket на порту из конфигурации и раздаёт
//! статику из `web/`.

mod config;
mod controllers;
mod db;
mod middleware;
mod models;
mod services;
mod utils;
mod ws;

use axum::routing::{any, get, post};
use axum::Router;
use config::Config;
use db::Db;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::sync::broadcast;
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;
use ws::AppState;

#[tokio::main]
async fn main() {
    init_tracing();

    let config = Config::from_env();

    // 1. Проверяем rqlite ещё до старта сервера: без БД приложение бесполезно.
    let db = Db::new(&config.rqlite_url);
    if let Err(error) = db.ensure_ready().await {
        eprintln!("❌ {error}");
        eprintln!("   Подсказка: запусти rqlite, например:");
        eprintln!("     rqlited -node-id 1 ./data");
        eprintln!("   или:");
        eprintln!("     docker run -d -p 4001:4001 rqlite/rqlite");
        std::process::exit(1);
    }

    if let Err(error) = db.init_schema().await {
        eprintln!("❌ Не удалось применить схему БД: {error}");
        std::process::exit(1);
    }

    // 2. Общий broadcast-канал: сюда контроллеры кладут новые сообщения,
    //    а WS-соединения читают их и фильтруют по подпискам.
    let (tx, _rx) = broadcast::channel::<models::message::Message>(1024);

    let state = AppState {
        db,
        jwt_secret: Arc::new(config.jwt_secret.clone()),
        tx,
    };

    let app = build_router(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], config.port));
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("❌ Не удалось занять порт {}: {error}", config.port);
            std::process::exit(1);
        }
    };

    tracing::info!("CipherTalk запущен: http://localhost:{}", config.port);
    tracing::info!("rqlite: {}", config.rqlite_url);

    if let Err(error) = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
    {
        eprintln!("❌ HTTP-сервер завершился с ошибкой: {error}");
        std::process::exit(1);
    }
}

/// Собирает роутер: публичные роуты, защищённые через route_layer, статика.
fn build_router(state: AppState) -> Router {
    // Защищённые маршруты: мидлварь применяется только к ним, register/login
    // остаются публичными.
    let protected = Router::new()
        .route(
            "/api/chats",
            get(controllers::chats::list).post(controllers::chats::create),
        )
        .route("/api/chats/:id/join", post(controllers::chats::join))
        .route(
            "/api/chats/:id/messages",
            get(controllers::messages::list).post(controllers::messages::send),
        )
        .route_layer(axum::middleware::from_fn_with_state(
            state.clone(),
            middleware::require_auth,
        ));

    // SPA-статика: если файла нет — отдаём index.html (fallback).
    let static_files = ServeDir::new("web").not_found_service(ServeFile::new("web/index.html"));

    Router::new()
        .route("/healthz", get(healthz))
        .route("/ws", get(ws::ws_handler))
        .route("/api/register", post(controllers::auth::register))
        .route("/api/login", post(controllers::auth::login))
        .merge(protected)
        // Неизвестный /api/* должен отвечать JSON-ошибкой, а не index.html.
        .route("/api/*path", any(api_not_found))
        .fallback_service(static_files)
        .layer(TraceLayer::new_for_http())
        .layer(CorsLayer::permissive())
        .with_state(state)
}

/// GET /healthz — простая проверка живости.
async fn healthz() -> &'static str {
    "ok"
}

/// JSON 404 для неизвестных API-маршрутов.
async fn api_not_found() -> utils::error::AppError {
    utils::error::AppError::NotFound("Маршрут API не найден".into())
}

/// Инициализация логов; уровень управляется через RUST_LOG.
fn init_tracing() {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,tower_http=warn"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .compact()
        .init();
}

/// Ждёт Ctrl+C или SIGTERM для корректной остановки.
async fn shutdown_signal() {
    let ctrl_c = async {
        if let Err(error) = tokio::signal::ctrl_c().await {
            tracing::warn!("не удалось повесить обработчик Ctrl+C: {error}");
        }
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(error) => {
                tracing::warn!("не удалось повесить обработчик SIGTERM: {error}");
                std::future::pending::<()>().await;
            }
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }

    tracing::info!("получен сигнал остановки, завершаюсь…");
}
