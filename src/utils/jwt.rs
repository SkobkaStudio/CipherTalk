//! Создание и проверка JWT (HS256).
//!
//! В токене лежат `sub` (id пользователя), `username`, время выпуска `iat`
//! и истечения `exp`. Секрет берётся из конфигурации (`JWT_SECRET`).

use crate::utils::error::{AppError, AppResult};
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

/// Срок жизни access-токена: 7 дней.
const TOKEN_TTL_SECONDS: u64 = 7 * 24 * 60 * 60;

/// Полезная нагрузка JWT.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claims {
    /// id пользователя (стандартное поле subject).
    pub sub: i64,
    /// Имя пользователя на момент выпуска токена.
    pub username: String,
    /// Время выпуска (Unix seconds).
    pub iat: usize,
    /// Время истечения (Unix seconds).
    pub exp: usize,
}

/// Текущее время в секундах с Unix epoch.
pub fn now_ts() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

/// Выпускает подписанный JWT для пользователя.
pub fn create_token(user_id: i64, username: &str, secret: &str) -> AppResult<String> {
    let issued_at = now_ts().max(0) as usize;
    let claims = Claims {
        sub: user_id,
        username: username.to_string(),
        iat: issued_at,
        exp: issued_at + TOKEN_TTL_SECONDS as usize,
    };

    encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|error| AppError::Internal(format!("не удалось выпустить JWT: {error}")))
}

/// Проверяет подпись и срок действия JWT.
pub fn decode_token(token: &str, secret: &str) -> AppResult<Claims> {
    let mut validation = Validation::new(Algorithm::HS256);
    // `exp` обязателен и проверяется автоматически. `sub` здесь не указываем:
    // jsonwebtoken 9 парсит required-claim `sub` только как строку, а у нас
    // числовой id пользователя — иначе любой выпущенный токен отвергался бы.
    validation.set_required_spec_claims(&["exp"]);

    decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &validation,
    )
    .map(|data| data.claims)
    .map_err(|_| AppError::Unauthorized("Недействительный или истёкший токен".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_roundtrip_with_numeric_subject() {
        let token = create_token(42, "alice", "test-secret").expect("token");
        let claims = decode_token(&token, "test-secret").expect("claims");
        assert_eq!(claims.sub, 42);
        assert_eq!(claims.username, "alice");
        assert!(claims.exp > claims.iat);
    }

    #[test]
    fn token_with_wrong_secret_is_rejected() {
        let token = create_token(1, "alice", "right-secret").expect("token");
        assert!(decode_token(&token, "wrong-secret").is_err());
    }
}
