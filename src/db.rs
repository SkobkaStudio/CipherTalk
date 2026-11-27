use std::time::Duration;

use anyhow::{anyhow, Context};
use redis::aio::ConnectionManager;
use sqlx::{postgres::PgPoolOptions, PgPool};

use crate::config::Config;

/// Connect to PostgreSQL, optionally apply embedded migrations, and return a
/// tuned pool. Migrations are compiled into the binary (`sqlx::migrate!`), so
/// no external tool is needed at runtime.
pub async fn init_postgres(cfg: &Config) -> anyhow::Result<PgPool> {
    let pool = PgPoolOptions::new()
        .max_connections(cfg.database_max_connections)
        .min_connections(1)
        .acquire_timeout(Duration::from_secs(5))
        .test_before_acquire(true)
        .connect(&cfg.database_url)
        .await
        .context("failed to connect to PostgreSQL")?;

    if cfg.run_migrations {
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .context("failed to apply database migrations")?;
        tracing::info!("database migrations are up to date");
    }

    Ok(pool)
}

/// Redis is retried on startup because docker-compose may bring the app up
/// before Redis is ready to accept connections.
pub async fn init_redis(cfg: &Config) -> anyhow::Result<ConnectionManager> {
    let client = redis::Client::open(cfg.redis_url.as_str()).context("invalid REDIS_URL")?;

    let mut last_error: Option<redis::RedisError> = None;
    for attempt in 1..=15u32 {
        match ConnectionManager::new(client.clone()).await {
            Ok(manager) => {
                tracing::info!(attempt, "connected to Redis");
                return Ok(manager);
            }
            Err(err) => {
                tracing::warn!(attempt, error = %err, "Redis is not ready yet");
                last_error = Some(err);
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
    }

    Err(anyhow!(
        "failed to connect to Redis: {}",
        last_error
            .map(|e| e.to_string())
            .unwrap_or_else(|| "unknown error".to_owned())
    ))
}
