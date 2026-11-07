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
use crate::middleware::rate_limit::RateLimiter;
use crate::ws::AppState;
use axum::routing::{get, post};
use axum::Router;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};
use tracing_subscriber::fmt::time::FormatTime;

/// Проверка живости: GET /healthz -> "ok"
async fn healthz() -> &'static str {
    "ok"
}

/// Время в логах — локальное время процесса (часовой пояс сервера, например
/// +07:00), а не UTC: стандартный форматтер tracing-subscriber печатает UTC,
/// из-за чего логи «отстают» на смещение пояса.
struct LocalTimer;

impl FormatTime for LocalTimer {
    fn format_time(&self, w: &mut tracing_subscriber::fmt::format::Writer<'_>) -> std::fmt::Result {
        write!(w, "{}", chrono::Local::now().format("%Y-%m-%dT%H:%M:%S%.6f%:z"))
    }
}

#[tokio::main]
async fn main() {
    // Логирование через tracing-subscriber
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .with_timer(LocalTimer)
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
        ws_tickets: Arc::new(Mutex::new(HashMap::new())),
        auth_limiter: Arc::new(RateLimiter::new(cfg.auth_rate_limit, Duration::from_secs(60))),
    });
    let _ = _rx_stub; // сам канал живёт в AppState

    // Публичная часть API (без JWT): авторизация v2 по телефону.
    // На шаги, где можно перебирать код/пароль, навешен лимит по IP: без него
    // счётчик попыток на номер обходится простым перебором номеров.
    let sensitive_auth = Router::new()
        .route("/auth/start", post(controllers::auth::start))
        .route("/auth/verify", post(controllers::auth::verify))
        .route("/auth/finish", post(controllers::auth::finish))
        .route("/auth/login", post(controllers::auth::login))
        .route_layer(axum::middleware::from_fn_with_state(
            state.clone(),
            middleware::rate_limit::auth_rate_limit,
        ));

    let public = Router::new()
        .route("/auth/check-username", get(controllers::auth::check_username))
        .merge(sensitive_auth);

    // Защищённая часть API: мидлварь require_auth проверяет Bearer JWT
    // и кладёт Claims в request.extensions — контроллеры читают их через Extension<Claims>.
    let protected = Router::new()
        .route("/me", get(controllers::auth::me))
        // Одноразовый тикет для /ws — чтобы JWT не попадал в URL сокета
        .route("/ws-ticket", get(controllers::auth::ws_ticket))
        .route("/chats", get(controllers::chats::list).post(controllers::chats::create))
        .route("/chats/dm", post(controllers::chats::dm))
        .route("/chats/group", post(controllers::chats::group))
        .route("/chats/by-id/:server_id", get(controllers::chats::by_server_id))
        .route("/users/:server_id", get(controllers::chats::user_by_server_id))
        .route("/chats/:id/join", post(controllers::chats::join))
        .route(
            "/chats/:id/messages",
            get(controllers::messages::list).post(controllers::messages::send),
        )
        .route_layer(axum::middleware::from_fn_with_state(
            state.clone(),
            middleware::require_auth,
        ));

    // Статика фронтенда: неизвестные пути отдают index.html (SPA-роутинг)
    let static_files = ServeDir::new("web").not_found_service(ServeFile::new("web/index.html"));

    let app = Router::new()
        .route("/healthz", get(healthz))
        .route("/ws", get(ws::ws_handler))
        .nest("/api", Router::new().merge(public).merge(protected))
        .fallback_service(static_files)
        // CORS: разрешаем всё — фронтенд может открываться с file:// или другого порта
        .layer(CorsLayer::permissive())
        .with_state(state.clone())
        // Заголовки безопасности — на все ответы, включая статику
        .layer(axum::middleware::from_fn(middleware::security_headers));

    let addr = SocketAddr::from(([0, 0, 0, 0], cfg.port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("не удалось привязаться к порту");
    tracing::info!("HTTP сервер запущен на http://{} (порт {})", addr, cfg.port);
    // ConnectInfo нужен rate-limit'у, чтобы знать IP клиента
    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
        .await
        .expect("сервер завершился с ошибкой");
}
