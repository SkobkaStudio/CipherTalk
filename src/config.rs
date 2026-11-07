//! Конфигурация приложения.
//!
//! Все параметры читаются из переменных окружения. Если `JWT_SECRET` пуст
//! или не задан — генерируется случайный секрет, а в лог пишется WARN:
//! после перезапуска такие токены станут недействительными.

use rand::RngCore;

/// Настройки, необходимые для запуска сервера.
#[derive(Clone, Debug)]
pub struct Config {
    /// Порт HTTP-сервера (по умолчанию 3000).
    pub port: u16,
    /// Базовый URL rqlite (по умолчанию http://localhost:4001).
    pub rqlite_url: String,
    /// Секрет для подписи JWT (HS256).
    pub jwt_secret: String,
}

impl Config {
    /// Читает конфигурацию из окружения и подставляет безопасные дефолты.
    pub fn from_env() -> Self {
        let port = std::env::var("PORT")
            .ok()
            .and_then(|v| v.parse::<u16>().ok())
            .unwrap_or(3000);

        // Убираем завершающий слэш, чтобы не получить `//db/query`.
        let rqlite_url = std::env::var("RQLITE_URL")
            .ok()
            .map(|v| v.trim().trim_end_matches('/').to_string())
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| "http://localhost:4001".to_string());

        let jwt_secret = match std::env::var("JWT_SECRET") {
            Ok(value) if !value.trim().is_empty() => value,
            _ => {
                let generated = random_secret();
                tracing::warn!(
                    "JWT_SECRET не задан — сгенерирован случайный секрет. \
                     Токены перестанут действовать после перезапуска сервера."
                );
                generated
            }
        };

        Self {
            port,
            rqlite_url,
            jwt_secret,
        }
    }
}

/// Генерирует случайный 256-битный секрет в hex-виде.
fn random_secret() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let mut secret = String::with_capacity(64);
    for byte in bytes {
        use std::fmt::Write as _;
        // `write!` в String не может завершиться ошибкой.
        let _ = write!(secret, "{byte:02x}");
    }
    secret
}
