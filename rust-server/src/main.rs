//! CipherTalk backend (Rust + rqlite).
//!
//! Точка входа: Axum-сервер на 0.0.0.0:8080, REST + WebSocket + статика фронта.

mod auth;
mod chat;
mod db;
mod models;
mod ws;

use std::time::Duration;

use axum::routing::{get, post};
use axum::Router;
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};

#[tokio::main]
async fn main() {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| "info,ciphertalk_server=info".into());
    tracing_subscriber::fmt().with_env_filter(filter).init();

    dotenvy::dotenv().ok();

    let rqlite_url =
        std::env::var("RQLITE_URL").unwrap_or_else(|_| "http://localhost:4001".to_string());
    let bind_addr = std::env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".to_string());

    // Жёсткое требование: без rqlite сервер не работает.
    let database = match db::Db::connect(&rqlite_url).await {
        Ok(d) => d,
        Err(e) => {
            eprintln!("FATAL: cannot connect to rqlite at {rqlite_url}: {e}");
            std::process::exit(1);
        }
    };
    if let Err(e) = database.init_schema().await {
        eprintln!("FATAL: schema initialization failed: {e}");
        std::process::exit(1);
    }
    tracing::info!("schema ready");

    let registry = ws::WsRegistry::default();
    let app_state = ws::AppState {
        db: database.clone(),
        registry: registry.clone(),
    };

    // Фоновый сборщик «зависших» сокетов.
    {
        let reg = registry.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(60)).await;
                let n = reg.reap_stale(Duration::from_secs(300)).await;
                if n > 0 {
                    tracing::info!("reaped {n} stale websocket connections");
                }
            }
        });
    }

    let public_dir = std::env::var("PUBLIC_DIR")
        .unwrap_or_else(|_| "../ciphertalk-server/public".to_string());
    let index_path = format!("{public_dir}/index.html");

    let api = Router::new()
        .route("/send-code", post(auth::send_code))
        .route("/verify-code", post(auth::verify_code))
        .route("/register", post(auth::register))
        .route("/login", post(auth::login))
        .route("/login-code", post(auth::login_code))
        .route("/me", get(auth::me))
        .route("/logout", post(auth::logout))
        .route("/bots", post(auth::create_bot))
        .route("/chats", get(chat::list_chats).post(chat::create_chat))
        .route("/chats/{id}/messages", get(chat::chat_messages))
        .route("/users/search", get(chat::search_users))
        .route("/users/{id}", get(chat::get_user))
        .with_state(app_state.clone());

    let app = Router::new()
        .nest("/api", api)
        .route("/ws", get(ws::ws_handler).with_state(app_state.clone()))
        .route("/health", get(|| async { "ok" }))
        .fallback_service(ServeDir::new(public_dir).fallback(ServeFile::new(index_path)))
        .layer(CorsLayer::permissive());

    let listener = match tokio::net::TcpListener::bind(&bind_addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("FATAL: cannot bind {bind_addr}: {e}");
            std::process::exit(1);
        }
    };
    tracing::info!("CipherTalk server listening on http://{bind_addr}");
    if let Err(e) = axum::serve(listener, app).await {
        eprintln!("FATAL: server error: {e}");
        std::process::exit(1);
    }
}
