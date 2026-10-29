//! Подпись и проверка JWT (HS256).

use crate::utils::error::{AppError, AppResult};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

/// Полезная нагрузка токена: id пользователя, имя и срок действия.
#[derive(Debug, Serialize, Deserialize)]
#[derive(Clone)]
pub struct Claims {
    pub sub: i64,       // user_id
    pub name: String,   // username
    pub exp: usize,     // unix-time истечения
}

const TOKEN_TTL_SECS: usize = 7 * 24 * 3600; // неделя

/// Выдаёт подписанный JWT на неделю.
pub fn issue_token(secret: &str, user_id: i64, username: &str) -> AppResult<String> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| AppError::Internal(e.to_string()))?
        .as_secs() as usize;
    let claims = Claims { sub: user_id, name: username.to_string(), exp: now + TOKEN_TTL_SECS };
    let token = encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|e| AppError::Internal(format!("jwt encode: {e}")))?;
    Ok(token)
}

/// Проверяет подпись и срок действия, возвращает claims.
pub fn verify_token(secret: &str, token: &str) -> AppResult<Claims> {
    decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &Validation::default(),
    )
    .map(|d| d.claims)
    .map_err(|_| AppError::Unauthorized("Недействительный или истёкший токен".into()))
}
