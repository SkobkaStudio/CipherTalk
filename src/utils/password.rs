//! Хеширование и проверка паролей через argon2 (с случайной солью внутри хеша).

use crate::utils::error::{AppError, AppResult};
use argon2::password_hash::{rand_core::OsRng, PasswordHasher, PasswordVerifier, SaltString};
use argon2::{Argon2, PasswordHash};

/// Хешует пароль argon2id; соль генерируется автоматически и хранится в хеше.
pub fn hash_password(password: &str) -> AppResult<String> {
    let salt = SaltString::generate(&mut OsRng);
    let ph = Argon2::default();
    let hash = ph
        .hash_password(password.as_bytes(), &salt)
        .map_err(|e| AppError::Internal(format!("argon2 hash failed: {e}")))?
        .to_string();
    Ok(hash)
}

/// Проверяет пароль против сохранённого argon2-хеша.
pub fn verify_password(password: &str, hash: &str) -> bool {
    match PasswordHash::new(hash) {
        Ok(parsed) => Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok(),
        Err(_) => false,
    }
}
