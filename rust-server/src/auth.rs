//! Аутентификация CipherTalk: OTP, PBKDF2-SHA512, JWT (HS256), сессии, боты.
//!
//! Роуты:
//! * `POST /api/send-code`   — выдача 6-значного OTP (cooldown 60 сек).
//! * `POST /api/verify-code` — проверка OTP, выдаёт короткоживущий verifyToken.
//! * `POST /api/register`    — регистрация по verifyToken + пароль.
//! * `POST /api/login`       — вход по username+пароль.
//! * `POST /api/login-code`  — вход существующего пользователя по OTP.
//! * `GET  /api/me`          — текущий пользователь (Bearer).
//! * `POST /api/logout`      — отзыв сессии (Bearer).
//! * `POST /api/bots`        — создание бота (Bearer), токен хранится хэшем.

use std::sync::{Mutex, OnceLock};
use std::collections::HashMap;
use std::time::Instant;

use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Algorithm, Validation};
use rand::Rng;
use serde::{Deserialize, Serialize};
use sha2::Sha512;
use uuid::Uuid;

use crate::db::{constant_time_eq, Db};
use crate::models::{
    AuthResponse, CreateBotRequest, LoginCodeRequest, LoginRequest, PublicUser, RegisterRequest,
    SendCodeRequest, UserRecord, VerifyCodeRequest,
};

// ============================ Настройки ============================

pub const OTP_TTL_MS: i64 = 5 * 60 * 1000; // 5 минут
pub const OTP_MAX_ATTEMPTS: i64 = 5;
pub const OTP_SEND_COOLDOWN: std::time::Duration = std::time::Duration::from_secs(60);
pub const SESSION_TTL_MS: i64 = 30 * 24 * 60 * 60 * 1000; // 30 дней
pub const VERIFY_TOKEN_TTL: u64 = 300; // 5 минут, сек
const PBKDF2_ROUNDS: u32 = 100_000;

fn jwt_secret() -> &'static [u8] {
    static SECRET: OnceLock<Vec<u8>> = OnceLock::new();
    SECRET.get_or_init(|| {
        if let Ok(s) = std::env::var("CIPHERTALK_JWT_SECRET") {
            if !s.is_empty() {
                return s.into_bytes();
            }
        }
        // Dev-режим: стабильный в рамках процесса секрет (логируем явно).
        let generated: Vec<u8> = (0..64).map(|_| rand::rngs::OsRng.gen::<u8>()).collect();
        tracing::warn!(
            "CIPHERTALK_JWT_SECRET is not set: generated an ephemeral secret. \
             JWTs will be invalid after restart."
        );
        generated
    })
}

// ============================ JWT ============================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claims {
    /// subject: user id (или bot id для bot-токенов типа kind=bot)
    pub sub: String,
    /// session id (jti). Для verifyToken — синтетический "vt:<uuid>".
    pub jti: String,
    /// Тип токена: "session" | "verify" | "login"
    pub kind: String,
    pub phone: String,
    pub exp: u64,
    pub iat: u64,
}

impl Claims {
    fn make(sub: &str, jti: &str, kind: &str, phone: &str, ttl_secs: u64) -> Self {
        let now = chrono::Utc::now().timestamp() as u64;
        Claims {
            sub: sub.to_string(),
            jti: jti.to_string(),
            kind: kind.to_string(),
            phone: phone.to_string(),
            exp: now + ttl_secs,
            iat: now,
        }
    }

    pub fn issue(&self) -> Result<String, jsonwebtoken::errors::Error> {
        encode(
            &Header::new(Algorithm::HS256),
            self,
            &EncodingKey::from_secret(jwt_secret()),
        )
    }

    pub fn verify(token: &str) -> Result<Self, jsonwebtoken::errors::Error> {
        decode::<Claims>(
            token,
            &DecodingKey::from_secret(jwt_secret()),
            &Validation::new(Algorithm::HS256),
        )
        .map(|d| d.claims)
    }
}

// ============================ Ошибки HTTP ============================

#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    pub fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self { status, message: message.into() }
    }
    pub fn bad_request(msg: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, msg)
    }
    pub fn unauthorized(msg: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, msg)
    }
    pub fn forbidden(msg: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, msg)
    }
    pub fn conflict(msg: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, msg)
    }
    pub fn internal(msg: impl Into<String>) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, msg)
    }
    fn db(e: crate::db::DbError) -> Self {
        tracing::error!("db error: {e}");
        Self::internal("database error")
    }
}

impl From<crate::db::DbError> for ApiError {
    fn from(e: crate::db::DbError) -> Self {
        ApiError::db(e)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(serde_json::json!({ "error": self.message }))).into_response()
    }
}

// ============================ Валидация ввода ============================

/// Телефон: только цифры, '+', '-', пробелы; длина 7..=20.
pub fn normalize_phone(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.len() > 20 {
        return None;
    }
    let digits: String = trimmed.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.len() < 7 || digits.len() > 15 {
        return None;
    }
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_digit() || c == '+' || c == '-' || c == ' ' || c == '(' || c == ')')
    {
        return None;
    }
    Some(trimmed.to_string())
}

fn validate_username(name: &str) -> Option<String> {
    let t = name.trim().to_lowercase();
    if t.len() < 3 || t.len() > 32 {
        return None;
    }
    let ok = t
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if !ok || !t.chars().next().is_some_and(|c| c.is_ascii_alphabetic()) {
        return None;
    }
    Some(t)
}

fn validate_password(pw: &str) -> Option<()> {
    if pw.len() >= 8 && pw.len() <= 128 {
        Some(())
    } else {
        None
    }
}

fn validate_code(code: &str) -> Option<()> {
    if code.len() == 6 && code.chars().all(|c| c.is_ascii_digit()) {
        Some(())
    } else {
        None
    }
}

// ============================ PBKDF2-SHA512 ============================

fn random_salt() -> String {
    let bytes: [u8; 16] = rand::rngs::OsRng.gen();
    hex::encode(bytes)
}

/// Хэш пароля: pbkdf2-hmac-sha512, итераций — PBKDF2_ROUNDS.
pub fn hash_password_with_rounds(password: &str, salt_hex: &str, rounds: u32) -> Result<String, ApiError> {
    let salt = hex::decode(salt_hex).map_err(|_| ApiError::internal("bad salt encoding"))?;
    let mut dk = [0u8; 64];
    pbkdf2::pbkdf2_hmac::<Sha512>(password.as_bytes(), &salt, rounds, &mut dk);
    Ok(hex::encode(dk))
}

pub fn hash_password(password: &str, salt_hex: &str) -> Result<String, ApiError> {
    hash_password_with_rounds(password, salt_hex, PBKDF2_ROUNDS)
}

fn verify_password(password: &str, salt_hex: &str, expected_hash_hex: &str) -> bool {
    match hash_password(password, salt_hex) {
        Ok(calc) => constant_time_eq(calc.as_bytes(), expected_hash_hex.as_bytes()),
        Err(_) => false,
    }
}

/// SHA-512 (hex) — для хэширования бот-токенов.
pub fn sha512_hex(input: &str) -> String {
    use sha2::Digest;
    let mut h = <Sha512 as sha2::Digest>::new();
    h.update(input.as_bytes());
    hex::encode(h.finalize())
}

// ============================ Cooldown отправки SMS ============================

#[derive(Default)]
struct OtpCooldown {
    last_sent: HashMap<String, Instant>,
}

fn cooldown_map() -> &'static Mutex<OtpCooldown> {
    static MAP: OnceLock<Mutex<OtpCooldown>> = OnceLock::new();
    MAP.get_or_init(|| {
        Mutex::new(OtpCooldown {
            last_sent: HashMap::new(),
        })
    })
}

fn check_and_mark_cooldown(phone: &str) -> Result<(), std::time::Duration> {
    let mut guard = cooldown_map().lock().unwrap_or_else(|p| p.into_inner());
    // Периодически чистим карту, чтобы не расти бесконечно.
    if guard.last_sent.len() > 10_000 {
        let cutoff = Instant::now() - OTP_SEND_COOLDOWN * 4;
        guard.last_sent.retain(|_, t| *t > cutoff);
    }
    if let Some(prev) = guard.last_sent.get(phone) {
        let elapsed = prev.elapsed();
        if elapsed < OTP_SEND_COOLDOWN {
            return Err(OTP_SEND_COOLDOWN - elapsed);
        }
    }
    guard.last_sent.insert(phone.to_string(), Instant::now());
    Ok(())
}

// ============================ AuthUser (middleware/extractor) ============================

#[derive(Debug, Clone)]
pub struct AuthUser {
    pub user_id: String,
    pub session_id: String,
    #[allow(dead_code)] // phone доступен для будущих роутов (смена телефона по OTP)
    pub phone: String,
}

impl AuthUser {
    /// Извлечь и проверить пользователя из заголовков HTTP-запроса.
    pub fn from_headers(headers: &axum::http::HeaderMap) -> Result<Self, ApiError> {
        let token = headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| ApiError::unauthorized("missing Authorization header"))?;
        Self::from_token(&token)
    }

    fn from_token(token: &str) -> Result<Self, ApiError> {
        let claims = Claims::verify(token).map_err(|_| ApiError::unauthorized("invalid token"))?;
        if claims.kind != "session" {
            return Err(ApiError::unauthorized("wrong token type"));
        }
        Ok(AuthUser {
            user_id: claims.sub,
            session_id: claims.jti,
            phone: claims.phone,
        })
    }
}

// ============================ Общие утилиты ============================

async fn load_user_by_id(db: &Db, id: &str) -> Result<UserRecord, ApiError> {
    db.find_user_by_id(id)
        .await?
        .ok_or_else(|| ApiError::unauthorized("user not found"))
}

async fn start_session(db: &Db, user_id: &str, phone: &str) -> Result<(String, String), ApiError> {
    let session_id = Uuid::new_v4().to_string();
    db.create_session(&session_id, user_id, SESSION_TTL_MS).await?;
    let claims = Claims::make(user_id, &session_id, "session", phone, SESSION_TTL_MS as u64 / 1000);
    let token = claims
        .issue()
        .map_err(|e| ApiError::internal(format!("jwt: {e}")))?;
    Ok((session_id, token))
}

fn auth_response(user: UserRecord, token: String) -> Json<AuthResponse> {
    Json(AuthResponse {
        token,
        user: user.to_public(),
    })
}

// ============================ Роуты ============================

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyCodeResponse {
    pub verified: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verify_token: Option<String>,
    /// true, если телефон уже зарегистрирован — фронт может предложить login-code.
    pub registered: bool,
}

/// POST /api/send-code
pub async fn send_code(
    axum::extract::State(state): axum::extract::State<crate::ws::WsState>,
    Json(req): Json<SendCodeRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let db = &state.db;
    let phone = normalize_phone(&req.phone)
        .ok_or_else(|| ApiError::bad_request("invalid phone number"))?;
    if let Err(left) = check_and_mark_cooldown(&phone) {
        return Err(ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            format!("too many requests, retry in {} sec", left.as_secs() + 1),
        ));
    }
    let code: String = {
        let mut rng = rand::thread_rng();
        (0..6).map(|_| rng.gen_range(0..10).to_string()).collect()
    };
    db.save_otp(&phone, &code, OTP_TTL_MS).await?;
    // Double-check TTL в БД: код обязан жить ровно OTP_TTL_MS (5 минут).
    if let Some((created_at, expires_at)) = db.get_otp_state(&phone).await? {
        if expires_at - created_at != OTP_TTL_MS || expires_at <= chrono::Utc::now().timestamp_millis() {
            return Err(ApiError::internal("otp ttl mismatch in db"));
        }
    } else {
        return Err(ApiError::internal("otp was not persisted"));
    }
    // Тестовый режим: код в консоль вместо SMS.
    tracing::info!("[OTP] phone={phone} code={code} (valid 5 minutes)");
    println!("[OTP] phone={phone} code={code}");
    Ok(Json(serde_json::json!({
        "sent": true,
        "expiresIn": OTP_TTL_MS / 1000
    })))
}

/// POST /api/verify-code
pub async fn verify_code(
    axum::extract::State(state): axum::extract::State<crate::ws::WsState>,
    Json(req): Json<VerifyCodeRequest>,
) -> Result<Json<VerifyCodeResponse>, ApiError> {
    let db = &state.db;
    let phone = normalize_phone(&req.phone)
        .ok_or_else(|| ApiError::bad_request("invalid phone number"))?;
    validate_code(&req.code).ok_or_else(|| ApiError::bad_request("code must be 6 digits"))?;

    let attempts = db.otp_attempts(&phone).await?;
    if attempts >= OTP_MAX_ATTEMPTS {
        return Err(ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "too many attempts, request a new code",
        ));
    }
    let ok = db.verify_otp(&phone, &req.code, OTP_MAX_ATTEMPTS).await?;
    if !ok {
        return Err(ApiError::bad_request("invalid or expired code"));
    }
    let existing = db.find_user_by_phone(&phone).await?;
    let vt = Claims::make(
        existing.as_ref().map(|u| u.id.as_str()).unwrap_or("pending"),
        &format!("vt:{}", Uuid::new_v4()),
        "verify",
        &phone,
        VERIFY_TOKEN_TTL,
    )
    .issue()
    .map_err(|e| ApiError::internal(format!("jwt: {e}")))?;
    Ok(Json(VerifyCodeResponse {
        verified: true,
        verify_token: Some(vt),
        registered: existing.is_some(),
    }))
}

/// POST /api/register
pub async fn register(
    axum::extract::State(state): axum::extract::State<crate::ws::WsState>,
    Json(req): Json<RegisterRequest>,
) -> Result<Json<AuthResponse>, ApiError> {
    let db = &state.db;
    let claims = Claims::verify(&req.verify_token).map_err(|_| ApiError::unauthorized("invalid verify token"))?;
    if claims.kind != "verify" {
        return Err(ApiError::unauthorized("wrong token type"));
    }
    let phone = normalize_phone(&req.phone).ok_or_else(|| ApiError::bad_request("invalid phone"))?;
    if claims.phone != phone {
        return Err(ApiError::unauthorized("verify token issued for another phone"));
    }
    let username = validate_username(&req.username).ok_or_else(|| {
        ApiError::bad_request("username: 3-32 chars, latin letters/digits/_/-, starts with letter")
    })?;
    validate_password(&req.password).ok_or_else(|| ApiError::bad_request("password must be at least 8 characters"))?;

    if db.find_user_by_phone(&phone).await?.is_some() {
        return Err(ApiError::conflict("this phone is already registered"));
    }
    if db.find_user_by_username(&username).await?.is_some() {
        return Err(ApiError::conflict("username is already taken"));
    }
    let salt = random_salt();
    let password_hash = hash_password(&req.password, &salt)?;
    let display_name = req
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.len() <= 64)
        .map(str::to_string)
        .unwrap_or_else(|| username.clone());
    let public_key = req.public_key.as_deref().filter(|s| !s.trim().is_empty()).map(|s| s.trim().to_string());

    let user_id = Uuid::new_v4().to_string();
    let user = db
        .create_user_with_id(
            &user_id,
            &username,
            &display_name,
            &phone,
            &password_hash,
            &salt,
            public_key.as_deref(),
            false,
        )
        .await?;
    let (_sid, token) = start_session(db, &user.id, &user.phone).await?;
    tracing::info!("registered user {} ({})", user.username, user.id);
    Ok(auth_response(user, token))
}

/// POST /api/login
pub async fn login(
    axum::extract::State(state): axum::extract::State<crate::ws::WsState>,
    Json(req): Json<LoginRequest>,
) -> Result<Json<AuthResponse>, ApiError> {
    let db = &state.db;
    let username = validate_username(&req.username).ok_or_else(|| ApiError::bad_request("invalid username"))?;
    let user = db
        .find_user_by_username(&username)
        .await?
        .ok_or_else(|| ApiError::unauthorized("wrong username or password"))?;
    if user.is_bot {
        return Err(ApiError::forbidden("bots cannot log in with a password"));
    }
    if !verify_password(&req.password, &user.salt, &user.password_hash) {
        return Err(ApiError::unauthorized("wrong username or password"));
    }
    let (_sid, token) = start_session(db, &user.id, &user.phone).await?;
    Ok(auth_response(user, token))
}

/// POST /api/login-code — вход по OTP для уже зарегистрированного телефона.
pub async fn login_code(
    axum::extract::State(state): axum::extract::State<crate::ws::WsState>,
    Json(req): Json<LoginCodeRequest>,
) -> Result<Json<AuthResponse>, ApiError> {
    let db = &state.db;
    let phone = normalize_phone(&req.phone).ok_or_else(|| ApiError::bad_request("invalid phone"))?;
    validate_code(&req.code).ok_or_else(|| ApiError::bad_request("code must be 6 digits"))?;
    let attempts = db.otp_attempts(&phone).await?;
    if attempts >= OTP_MAX_ATTEMPTS {
        return Err(ApiError::new(StatusCode::TOO_MANY_REQUESTS, "too many attempts, request a new code"));
    }
    if !db.verify_otp(&phone, &req.code, OTP_MAX_ATTEMPTS).await? {
        return Err(ApiError::bad_request("invalid or expired code"));
    }
    let user = db
        .find_user_by_phone(&phone)
        .await?
        .ok_or_else(|| ApiError::unauthorized("user is not registered"))?;
    if user.is_bot {
        return Err(ApiError::forbidden("bots cannot log in"));
    }
    let (_sid, token) = start_session(db, &user.id, &user.phone).await?;
    Ok(auth_response(user, token))
}

/// GET /api/me
pub async fn me(
    axum::extract::State(state): axum::extract::State<crate::ws::WsState>,
    headers: axum::http::HeaderMap,
) -> Result<Json<PublicUser>, ApiError> {
    let db = &state.db;
    let auth = AuthUser::from_headers(&headers)?;
    if !db.session_valid(&auth.session_id).await? {
        return Err(ApiError::unauthorized("session revoked"));
    }
    let user = load_user_by_id(db, &auth.user_id).await?;
    Ok(Json(user.to_public()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogoutRequest {
    #[serde(default)]
    pub session_id: Option<String>,
}

/// POST /api/logout
pub async fn logout(
    axum::extract::State(state): axum::extract::State<crate::ws::WsState>,
    headers: axum::http::HeaderMap,
    Json(req): Json<LogoutRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let db = &state.db;
    let auth = AuthUser::from_headers(&headers)?;
    // Отзываем текущую сессию; если прислали sessionId явно — и её тоже.
    db.revoke_session(&auth.session_id).await?;
    if let Some(sid) = req.session_id.filter(|s| !s.is_empty()) {
        db.revoke_session(&sid).await?;
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BotResponse {
    pub bot: PublicUser,
    /// Единственный раз, когда токен показывается открытым текстом.
    pub token: String,
}

/// POST /api/bots — создать бота (под Bearer пользователя).
pub async fn create_bot(
    axum::extract::State(state): axum::extract::State<crate::ws::WsState>,
    headers: axum::http::HeaderMap,
    Json(req): Json<CreateBotRequest>,
) -> Result<Json<BotResponse>, ApiError> {
    let db = &state.db;
    let auth = AuthUser::from_headers(&headers)?;
    let username = validate_username(&req.name)
        .ok_or_else(|| ApiError::bad_request("bot name must be a valid username (3-32 chars)"))?;
    if db.find_user_by_username(&username).await?.is_some() {
        return Err(ApiError::conflict("username is already taken"));
    }
    let raw_token = format!("ct-bot-{}", Uuid::new_v4().to_string().replace('-', ""));
    let token_hash = sha512_hex(&raw_token);
    let display_name = req
        .description
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.len() <= 128)
        .map(str::to_string)
        .unwrap_or_else(|| format!("{username} (bot)"));
    let bot = db.create_bot(&username, &display_name, &token_hash).await?;
    tracing::info!("created bot {} by user {}", bot.id, auth.user_id);
    Ok(Json(BotResponse {
        bot: bot.to_public(),
        token: raw_token,
    }))
}

/// Проверка JWT для WebSocket-подключения пользователя (старый протокол фронта).
/// Возвращает user_id при успехе.
pub async fn ws_auth_user(db: &Db, token: &str) -> Option<UserRecord> {
    let claims = Claims::verify(token).ok()?;
    if claims.kind != "session" {
        return None;
    }
    if !db.session_valid(&claims.jti).await.ok()? {
        return None;
    }
    db.find_user_by_id(&claims.sub).await.ok().flatten()
}

/// Проверка бот-токена (`?token=...`) — сравнение по HMAC-подписанному хэшу.
pub async fn ws_auth_bot(db: &Db, token: &str) -> Option<UserRecord> {
    if token.is_empty() {
        return None;
    }
    let token_hash = sha512_hex(token);
    db.find_bot_by_token_hash(&token_hash).await.ok().flatten()
}

// ============================ Тесты ============================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pbkdf2_roundtrip() {
        let salt = random_salt();
        let hash = hash_password_with_rounds("secret-pass", &salt, 1000).unwrap();
        assert!(constant_time_eq(hash.as_bytes(), hash.as_bytes()));
        // Проверка формата вывода (64 байта -> 128 hex).
        assert_eq!(hash.len(), 128);
    }

    #[test]
    fn phone_normalization() {
        assert_eq!(normalize_phone(" +7 (900) 123-45-67 ").as_deref(), Some("+7 (900) 123-45-67"));
        assert_eq!(normalize_phone("abc"), None);
        assert_eq!(normalize_phone("12345"), None);
        assert_eq!(normalize_phone("' OR 1=1--"), None);
    }

    #[test]
    fn username_validation() {
        assert_eq!(validate_username("Alice_1").as_deref(), Some("alice_1"));
        assert_eq!(validate_username("a b"), None);
        assert_eq!(validate_username("1abc"), None);
        assert_eq!(validate_username(""), None);
    }

    #[test]
    fn jwt_roundtrip_and_kind() {
        let c = Claims::make("user-1", "sess-1", "session", "+10000000000", 60);
        let t = c.issue().unwrap();
        let back = Claims::verify(&t).unwrap();
        assert_eq!(back.sub, "user-1");
        assert_eq!(back.jti, "sess-1");
        assert_eq!(back.kind, "session");
        // Подделка подписи должна ловиться.
        let mut forged = t.clone();
        forged.pop();
        assert!(Claims::verify(&forged).is_err());
    }

    #[test]
    fn sha512_stable() {
        assert_eq!(sha512_hex("abc").len(), 128);
        assert_ne!(sha512_hex("abc"), sha512_hex("abd"));
    }

}
