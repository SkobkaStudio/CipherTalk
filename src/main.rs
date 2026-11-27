//! CipherTalk backend bootstrap.

#![forbid(unsafe_code)]

mod config;
mod controllers;
mod db;
mod middleware;
mod models;
mod services;
mod state;
mod utils;
mod ws;

use std::{net::SocketAddr, sync::Arc, time::Duration};

use anyhow::Context;
use axum::{
    extract::DefaultBodyLimit,
    http::{
        header::{AUTHORIZATION, CONTENT_TYPE},
        HeaderValue, Method,
    },
    middleware as axum_middleware,
    routing::{delete, get, patch, post},
    Router,
};
use config::Config;
use state::AppState;
use tower_http::{
    compression::CompressionLayer,
    cors::{AllowOrigin, CorsLayer},
    services::{ServeDir, ServeFile},
    timeout::TimeoutLayer,
    trace::TraceLayer,
};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();
    init_tracing();

    let cfg = Arc::new(Config::from_env()?);
    services::media::ensure_dirs(&cfg).await?;
    let pool = db::init_postgres(&cfg).await?;
    let redis = db::init_redis(&cfg).await?;
    let redis_client = redis::Client::open(cfg.redis_url.as_str())
        .context("invalid REDIS_URL for Pub/Sub client")?;

    let ws_manager = Arc::new(ws::WsManager::new());
    let hub = ws::RealtimeHub::new(ws_manager.clone(), redis.clone());
    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);

    let state = AppState {
        cfg: cfg.clone(),
        pool,
        redis,
        ws: ws_manager,
        hub,
        shutdown: shutdown_rx,
    };

    let bridge = tokio::spawn(ws::run_redis_bridge(redis_client, state.hub.clone()));

    let app = build_router(state.clone())?;

    let listener = tokio::net::TcpListener::bind((cfg.host, cfg.port))
        .await
        .with_context(|| format!("failed to bind {}:{}", cfg.host, cfg.port))?;

    tracing::info!(
        address = %listener.local_addr().unwrap_or_else(|_| SocketAddr::from(([0, 0, 0, 0], cfg.port))),
        "CipherTalk is listening"
    );

    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        shutdown_signal().await;
        let _ = shutdown_tx.send(true);
    })
    .await
    .context("HTTP server failed")?;

    bridge.abort();
    tracing::info!("CipherTalk stopped");
    Ok(())
}

fn build_router(state: AppState) -> anyhow::Result<Router> {
    let auth_routes = Router::new()
        .route("/auth/register", post(controllers::auth::register))
        .route("/auth/login", post(controllers::auth::login))
        .route("/auth/refresh", post(controllers::auth::refresh))
        .layer(axum_middleware::from_fn_with_state(
            state.clone(),
            middleware::rate_limit::auth_limit,
        ));

    let protected = Router::new()
        .route("/auth/logout", post(controllers::auth::logout))
        .route(
            "/users/me",
            get(controllers::users::me).patch(controllers::users::update_me),
        )
        .route("/users/search", get(controllers::users::search))
        .route(
            "/users/me/avatar",
            post(controllers::media::upload_avatar).delete(controllers::media::delete_avatar),
        )
        .route("/chats", get(controllers::chats::list))
        .route("/chats/private", post(controllers::chats::create_private))
        .route("/chats/group", post(controllers::chats::create_group))
        .route("/chats/:id", get(controllers::chats::details))
        .route("/chats/:id/members", post(controllers::chats::add_members))
        .route(
            "/chats/:id/members/:user_id",
            delete(controllers::chats::remove_member),
        )
        .route(
            "/chats/:id/messages",
            get(controllers::messages::history).post(controllers::messages::send),
        )
        .route("/chats/:id/read", post(controllers::chats::mark_read))
        .route(
            "/chats/:id/attachments",
            post(controllers::media::upload_attachment),
        )
        .route(
            "/messages/:id",
            patch(controllers::messages::edit).delete(controllers::messages::delete),
        )
        .route_layer(axum_middleware::from_fn_with_state(
            state.clone(),
            middleware::auth::require_auth,
        ));

    let media_routes = Router::new()
        .route("/attachments/:id/content", get(controllers::media::content))
        .route(
            "/attachments/:id/thumbnail",
            get(controllers::media::thumbnail),
        );

    let api = Router::new()
        .merge(auth_routes)
        .merge(media_routes)
        .merge(protected)
        .fallback(api_not_found)
        .layer(DefaultBodyLimit::max(
            (state.cfg.max_upload_bytes as usize) + 2 * 1024 * 1024,
        ))
        .layer(TimeoutLayer::new(Duration::from_secs(120)))
        .layer(axum_middleware::from_fn_with_state(
            state.clone(),
            middleware::rate_limit::api_limit,
        ));

    let index = state.cfg.static_dir.join("index.html");
    let static_files = ServeDir::new(&state.cfg.static_dir)
        .append_index_html_on_directories(true)
        .fallback(ServeFile::new(index));
    let avatars = ServeDir::new(state.cfg.upload_dir.join("avatars"));

    let app = Router::new()
        .nest("/api", api)
        .nest_service("/media/avatars", avatars)
        .route("/health/live", get(controllers::health::live))
        .route("/health/ready", get(controllers::health::ready))
        .route("/ws", get(ws::ws_handler))
        .fallback_service(static_files)
        .layer(CompressionLayer::new())
        .layer(cors_layer(&state.cfg)?)
        .layer(TraceLayer::new_for_http().make_span_with(
            |request: &axum::http::Request<axum::body::Body>| {
                // Never log the query string: it may contain a WS token.
                tracing::info_span!(
                    "http_request",
                    method = %request.method(),
                    path = %request.uri().path(),
                )
            },
        ))
        .layer(axum_middleware::from_fn_with_state(
            state.clone(),
            middleware::security::security_headers,
        ));

    Ok(app.with_state(state))
}

async fn api_not_found() -> utils::AppError {
    utils::AppError::NotFound("Маршрут API не найден".into())
}

fn cors_layer(cfg: &Config) -> anyhow::Result<CorsLayer> {
    if cfg.cors_allowed_origins.is_empty() {
        // Same-origin deployment: no cross-origin headers are needed.
        return Ok(CorsLayer::new());
    }

    let origins = cfg
        .cors_allowed_origins
        .iter()
        .map(|origin| {
            HeaderValue::from_str(origin).with_context(|| format!("invalid CORS origin '{origin}'"))
        })
        .collect::<anyhow::Result<Vec<_>>>()?;

    Ok(CorsLayer::new()
        .allow_origin(AllowOrigin::list(origins))
        .allow_credentials(true)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([AUTHORIZATION, CONTENT_TYPE])
        .max_age(Duration::from_secs(3600)))
}

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("ciphertalk=info,tower_http=info,sqlx=warn"));

    let result = tracing_subscriber::registry()
        .with(filter)
        .with(tracing_subscriber::fmt::layer().with_target(false))
        .try_init();

    if let Err(err) = result {
        eprintln!("failed to initialise tracing: {err}");
    }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        if let Err(err) = tokio::signal::ctrl_c().await {
            tracing::error!(error = %err, "failed to install Ctrl+C handler");
        }
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(err) => tracing::error!(error = %err, "failed to install SIGTERM handler"),
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }

    tracing::info!("shutdown signal received");
}
