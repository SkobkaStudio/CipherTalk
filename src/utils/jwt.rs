use std::time::Duration;

use chrono::{Duration as ChronoDuration, Utc};
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};

use crate::utils::{AppError, AppResult};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claims {
    /// User id.
    pub sub: i64,
    /// Session id; used for revocation and the Redis session cache.
    pub sid: i64,
    pub username: String,
    pub iss: String,
    pub iat: i64,
    pub exp: i64,
}

pub fn encode_access_token(
    secret: &str,
    issuer: &str,
    ttl: Duration,
    user_id: i64,
    session_id: i64,
    username: &str,
) -> AppResult<(String, i64)> {
    let now = Utc::now();
    let ttl = ChronoDuration::from_std(ttl)
        .map_err(|err| AppError::Internal(anyhow::anyhow!("invalid JWT TTL: {err}")))?;
    let expires_at = now + ttl;

    let claims = Claims {
        sub: user_id,
        sid: session_id,
        username: username.to_owned(),
        iss: issuer.to_owned(),
        iat: now.timestamp(),
        exp: expires_at.timestamp(),
    };

    let token = encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|err| AppError::Internal(anyhow::anyhow!("failed to sign JWT: {err}")))?;

    Ok((token, ttl.num_seconds().max(0)))
}

pub fn decode_access_token(secret: &str, issuer: &str, token: &str) -> AppResult<Claims> {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.set_issuer(&[issuer]);
    validation.validate_exp = true;
    validation.leeway = 5;

    decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &validation,
    )
    .map(|data| data.claims)
    .map_err(|_| AppError::Unauthorized)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_roundtrip_and_issuer_check() {
        let secret = "0123456789abcdef0123456789abcdef";
        let (token, ttl) =
            encode_access_token(secret, "test", Duration::from_secs(600), 7, 9, "alice")
                .expect("encode");
        assert_eq!(ttl, 600);

        let claims = decode_access_token(secret, "test", &token).expect("decode");
        assert_eq!(claims.sub, 7);
        assert_eq!(claims.sid, 9);

        assert!(decode_access_token(secret, "other", &token).is_err());
    }
}
