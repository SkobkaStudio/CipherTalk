//! Хеширование и проверка паролей через argon2id.
//!
//! Пароли никогда не хранятся в открытом виде: в БД попадает только
//! PHC-строка вида `$argon2id$v=19$m=19456,t=2,p=1$...`.

use crate::utils::error::{AppError, AppResult};
use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;

/// Хеширует пароль случайной солью.
pub fn hash_password(password: &str) -> AppResult<String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|error| AppError::Internal(format!("не удалось захешировать пароль: {error}")))
}

/// Проверяет пароль против сохранённого хеша.
///
/// Любая проблема с форматом хеша считается «пароль не подошёл», а не
/// внутренней ошибкой: так проще не раскрывать детали клиенту.
pub fn verify_password(password: &str, hash: &str) -> bool {
    let Ok(parsed) = PasswordHash::new(hash) else {
        return false;
    };
    Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_is_argon2_and_password_verifies() {
        let hash = hash_password("secret123").expect("hash");
        assert!(hash.starts_with("$argon2id$"));
        assert!(verify_password("secret123", &hash));
        assert!(!verify_password("wrong-password", &hash));
    }
}
