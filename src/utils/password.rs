use anyhow::anyhow;
use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};

use crate::utils::{AppError, AppResult};

/// Argon2id with the defaults recommended by the RustCrypto crate
/// (19 MiB, t=2, p=1) and a per-user random salt.
pub fn hash_password(password: &str) -> AppResult<String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|err| AppError::Internal(anyhow!("argon2 hash failed: {err}")))
}

/// Constant-time password verification. A malformed stored hash is an
/// internal error; a simple mismatch is `Ok(false)`.
pub fn verify_password(hash: &str, password: &str) -> AppResult<bool> {
    let parsed = PasswordHash::new(hash)
        .map_err(|err| AppError::Internal(anyhow!("invalid password hash in database: {err}")))?;
    Ok(Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_and_verify_roundtrip() {
        let hash = hash_password("correct horse battery staple").expect("hash");
        assert!(verify_password(&hash, "correct horse battery staple").expect("verify"));
        assert!(!verify_password(&hash, "wrong password").expect("verify"));
    }
}
