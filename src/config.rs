//! Конфигурация приложения: чтение переменных окружения с дефолтами.

use std::env;

/// Итоговая конфигурация, собираемая при старте сервера.
#[derive(Clone, Debug)]
pub struct Config {
    /// Порт HTTP-сервера
    pub port: u16,
    /// Базовый URL rqlite (например http://localhost:4001)
    pub rqlite_url: String,
    /// Секрет для подписи JWT (HS256)
    pub jwt_secret: String,
}

impl Config {
    /// Читает PORT, RQLITE_URL, JWT_SECRET из окружения.
    /// Если JWT_SECRET не задан — генерирует случайный и печатает WARN в лог.
    pub fn from_env() -> Self {
        let port = env::var("PORT")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(3000);
        let rqlite_url =
            env::var("RQLITE_URL").unwrap_or_else(|_| "http://localhost:4001".to_string());
        // Удаём завершающий слэш, чтобы не получать //db/execute
        let rqlite_url = rqlite_url.trim_end_matches('/').to_string();

        let jwt_secret = match env::var("JWT_SECRET") {
            Ok(s) if !s.is_empty() => s,
            _ => {
                // Случайный секрет на 32 байта, base64 — чтобы переживать перезапуск безопасно
                use rand::Rng;
                let mut rng = rand::thread_rng();
                let bytes: [u8; 32] = rng.gen();
                use base64::Engine;
                let secret = base64::engine::general_purpose::STANDARD.encode(bytes);
                tracing::warn!(
                    "JWT_SECRET не задан — сгенерирован случайный секрет. \
                     Все выданные токены будут недействительны после перезапуска сервера."
                );
                secret
            }
        };

        Config { port, rqlite_url, jwt_secret }
    }
}
