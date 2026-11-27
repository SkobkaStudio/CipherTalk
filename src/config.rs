use std::{env, net::IpAddr, path::PathBuf, time::Duration};

use anyhow::{bail, Context};

/// Typed, validated application configuration.
///
/// Everything is read exactly once at startup. Secrets are never logged and
/// the struct intentionally does not implement `Debug`.
#[derive(Clone)]
pub struct Config {
    pub database_url: String,
    pub database_max_connections: u32,
    pub run_migrations: bool,

    pub redis_url: String,

    pub jwt_secret: String,
    pub jwt_issuer: String,
    pub access_token_ttl: Duration,
    pub refresh_token_ttl: Duration,
    pub media_token_ttl: Duration,
    pub cookie_secure: bool,

    pub host: IpAddr,
    pub port: u16,
    pub static_dir: PathBuf,
    pub cors_allowed_origins: Vec<String>,
    pub trust_proxy: bool,

    pub max_message_len: usize,
    pub max_group_members: i64,
    pub upload_dir: PathBuf,
    pub max_upload_bytes: u64,
    pub max_avatar_bytes: u64,
    pub rate_limit_auth_per_minute: u32,
    pub rate_limit_api_per_minute: u32,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let database_url =
            env::var("DATABASE_URL").context("DATABASE_URL is required (see .env.example)")?;
        let redis_url =
            env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6379/0".to_owned());

        let jwt_secret = env::var("JWT_SECRET")
            .context("JWT_SECRET is required (generate at least 32 random bytes)")?;
        if jwt_secret.len() < 32 {
            bail!("JWT_SECRET must be at least 32 bytes long");
        }
        if jwt_secret == "replace-me-with-at-least-32-random-bytes" {
            bail!("JWT_SECRET still contains the example value; generate a real secret");
        }

        let access_token_ttl = Duration::from_secs(parse_u64("ACCESS_TOKEN_TTL_SECS", 900)?);
        let refresh_token_ttl =
            Duration::from_secs(parse_u64("REFRESH_TOKEN_TTL_SECS", 2_592_000)?);
        if !(60..=86_400).contains(&access_token_ttl.as_secs()) {
            bail!("ACCESS_TOKEN_TTL_SECS must be between 60 and 86400");
        }
        if refresh_token_ttl.as_secs() < access_token_ttl.as_secs()
            || refresh_token_ttl.as_secs() > 365 * 24 * 3600
        {
            bail!("REFRESH_TOKEN_TTL_SECS must be >= access TTL and <= 365 days");
        }

        let host = env::var("HOST")
            .unwrap_or_else(|_| "0.0.0.0".to_owned())
            .parse::<IpAddr>()
            .context("HOST must be a valid IP address")?;
        let port = parse_u64("PORT", 8080)?;
        if port == 0 || port > u16::MAX as u64 {
            bail!("PORT must be between 1 and 65535");
        }

        let static_dir = PathBuf::from(env::var("STATIC_DIR").unwrap_or_else(|_| "web".to_owned()));
        if !static_dir.is_dir() {
            bail!("STATIC_DIR '{}' does not exist", static_dir.display());
        }

        let mut cors_allowed_origins = env::var("CORS_ALLOWED_ORIGINS")
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>();
        if cors_allowed_origins.iter().any(|o| o == "*") {
            bail!("CORS_ALLOWED_ORIGINS cannot contain '*' together with credentials");
        }
        // Normalise trailing slashes; browsers send origins without them.
        for origin in &mut cors_allowed_origins {
            while origin.ends_with('/') {
                origin.pop();
            }
        }

        let max_message_len = parse_u64("MAX_MESSAGE_LEN", 4096)? as usize;
        if !(1..=4096).contains(&max_message_len) {
            bail!("MAX_MESSAGE_LEN must be between 1 and 4096 (database constraint)");
        }
        let max_group_members = parse_u64("MAX_GROUP_MEMBERS", 500)? as i64;
        if !(2..=5000).contains(&max_group_members) {
            bail!("MAX_GROUP_MEMBERS must be between 2 and 5000");
        }

        let auth_rate = parse_u64("RATE_LIMIT_AUTH_PER_MINUTE", 20)?;
        let api_rate = parse_u64("RATE_LIMIT_API_PER_MINUTE", 600)?;
        if !(1..=1_000_000).contains(&auth_rate) || !(1..=1_000_000).contains(&api_rate) {
            bail!("rate limits must be between 1 and 1000000");
        }

        let database_max_connections = parse_u64("DATABASE_MAX_CONNECTIONS", 10)?;
        if !(1..=100).contains(&database_max_connections) {
            bail!("DATABASE_MAX_CONNECTIONS must be between 1 and 100");
        }

        let jwt_issuer = env::var("JWT_ISSUER").unwrap_or_else(|_| "ciphertalk".to_owned());
        if jwt_issuer.trim().is_empty() {
            bail!("JWT_ISSUER cannot be empty");
        }

        let upload_dir =
            PathBuf::from(env::var("UPLOAD_DIR").unwrap_or_else(|_| "uploads".to_owned()));
        let max_upload_mb = parse_u64("MAX_UPLOAD_MB", 50)?;
        if !(1..=100).contains(&max_upload_mb) {
            bail!("MAX_UPLOAD_MB must be between 1 and 100");
        }
        let max_avatar_mb = parse_u64("MAX_AVATAR_MB", 8)?;
        if !(1..=32).contains(&max_avatar_mb) {
            bail!("MAX_AVATAR_MB must be between 1 and 32");
        }
        let media_token_ttl = Duration::from_secs(parse_u64("MEDIA_TOKEN_TTL_SECS", 86_400)?);
        if !(300..=2_592_000).contains(&media_token_ttl.as_secs()) {
            bail!("MEDIA_TOKEN_TTL_SECS must be between 300 and 2592000");
        }

        Ok(Self {
            database_url,
            database_max_connections: database_max_connections as u32,
            run_migrations: parse_bool("RUN_MIGRATIONS", true)?,
            redis_url,
            jwt_secret,
            jwt_issuer,
            access_token_ttl,
            refresh_token_ttl,
            media_token_ttl,
            cookie_secure: parse_bool("COOKIE_SECURE", false)?,
            host,
            port: port as u16,
            static_dir,
            cors_allowed_origins,
            trust_proxy: parse_bool("TRUST_PROXY", false)?,
            max_message_len,
            max_group_members,
            upload_dir,
            max_upload_bytes: max_upload_mb * 1024 * 1024,
            max_avatar_bytes: max_avatar_mb * 1024 * 1024,
            rate_limit_auth_per_minute: auth_rate as u32,
            rate_limit_api_per_minute: api_rate as u32,
        })
    }
}

fn parse_u64(key: &str, default: u64) -> anyhow::Result<u64> {
    match env::var(key) {
        Ok(raw) => raw
            .trim()
            .parse::<u64>()
            .with_context(|| format!("{key} must be an unsigned integer, got '{raw}'")),
        Err(_) => Ok(default),
    }
}

fn parse_bool(key: &str, default: bool) -> anyhow::Result<bool> {
    match env::var(key) {
        Ok(raw) => match raw.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => Ok(true),
            "0" | "false" | "no" | "off" => Ok(false),
            other => bail!("{key} must be a boolean (true/false), got '{other}'"),
        },
        Err(_) => Ok(default),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn example_secret_is_long_enough() {
        assert!("replace-me-with-at-least-32-random-bytes".len() >= 32);
    }
}
