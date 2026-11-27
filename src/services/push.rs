//! Web Push (RFC 8030/8291/8292) for background notifications.
//!
//! Encryption is implemented with `ring` so the deploy target does not need
//! OpenSSL bindings. Delivery uses the system `curl`, which is already a
//! runtime dependency of the Docker image and armbian host.

use std::time::Duration;

use anyhow::{anyhow, Context};
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE, URL_SAFE_NO_PAD},
    Engine as _,
};
use chrono::Utc;
use hkdf::Hkdf;
use ring::{
    aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_128_GCM},
    agreement,
    rand::{SecureRandom, SystemRandom},
    signature::{EcdsaKeyPair, KeyPair, ECDSA_P256_SHA256_ASN1_SIGNING},
};
use serde_json::{json, Value};
use sha2::Sha256;
use sqlx::PgPool;
use std::process::Stdio;

use tokio::{io::AsyncWriteExt, process::Command, time};

use crate::{config::Config, models::message::MessageDto, state::AppState};

const VAPID_TTL_SECS: i64 = 12 * 60 * 60;

#[derive(Debug, sqlx::FromRow)]
struct PushRow {
    endpoint: String,
    p256dh: String,
    auth: String,
}

enum PushOutcome {
    Delivered,
    Stale,
}

pub struct PushService {
    key: EcdsaKeyPair,
    public_key_b64: String,
    subject: String,
    rng: SystemRandom,
}

impl PushService {
    pub fn from_config(cfg: &Config) -> anyhow::Result<Option<Self>> {
        let Some(encoded) = cfg.vapid_private_key.as_deref() else {
            return Ok(None);
        };
        let der = STANDARD
            .decode(encoded)
            .or_else(|_| URL_SAFE.decode(encoded))
            .context("VAPID_PRIVATE_KEY must be base64(DER PKCS#8)")?;
        let rng = SystemRandom::new();
        let key = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, &der, &rng)
            .map_err(|err| anyhow!("invalid VAPID_PRIVATE_KEY: {err}"))?;
        let public_key = key.public_key().as_ref().to_vec();
        if public_key.len() != 65 || public_key.first() != Some(&4) {
            return Err(anyhow!("VAPID public key is not uncompressed P-256"));
        }
        let public_key_b64 = URL_SAFE_NO_PAD.encode(&public_key);
        Ok(Some(Self {
            key,
            public_key_b64,
            subject: cfg.vapid_subject.clone(),
            rng,
        }))
    }

    pub fn public_key(&self) -> &str {
        &self.public_key_b64
    }

    pub async fn notify_message(
        &self,
        state: &AppState,
        chat_id: i64,
        sender_id: i64,
        message: &MessageDto,
    ) -> anyhow::Result<usize> {
        let context = sqlx::query!(
            r#"
            SELECT c.kind, c.title,
                   u.display_name AS sender_name,
                   u.avatar_url AS sender_avatar
            FROM chats c
            JOIN users u ON u.id = $2
            WHERE c.id = $1
            "#,
            chat_id,
            sender_id
        )
        .fetch_optional(&state.pool)
        .await?;
        let Some(context) = context else {
            return Ok(0);
        };

        let recipients = sqlx::query_scalar!(
            "SELECT user_id FROM chat_members WHERE chat_id = $1 AND user_id <> $2",
            chat_id,
            sender_id
        )
        .fetch_all(&state.pool)
        .await?;
        if recipients.is_empty() {
            return Ok(0);
        }

        let subscriptions = sqlx::query_as!(
            PushRow,
            "SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ANY($1)",
            &recipients
        )
        .fetch_all(&state.pool)
        .await?;
        if subscriptions.is_empty() {
            return Ok(0);
        }

        let body = message_body(message);
        let title = if context.kind == "group" {
            format!(
                "{} — {}",
                context.sender_name,
                context.title.unwrap_or_else(|| "Группа".to_owned())
            )
        } else {
            context.sender_name.clone()
        };
        let payload = json!({
            "title": title,
            "body": body,
            "chat_id": chat_id,
            "icon": context.sender_avatar.unwrap_or_default(),
            "tag": format!("chat-{chat_id}"),
            "url": format!("/?chat={chat_id}"),
        });

        let mut sent = 0usize;
        for subscription in subscriptions {
            match self.send_one(&subscription, &payload).await {
                Ok(PushOutcome::Delivered) => {
                    sent += 1;
                }
                Ok(PushOutcome::Stale) => {
                    let _ = sqlx::query!(
                        "DELETE FROM push_subscriptions WHERE endpoint = $1",
                        subscription.endpoint
                    )
                    .execute(&state.pool)
                    .await;
                }
                Err(err) => {
                    tracing::debug!(error = %err, endpoint = %short_endpoint(&subscription.endpoint), "push delivery failed");
                }
            }
        }
        Ok(sent)
    }

    pub async fn test_user(&self, pool: &PgPool, user_id: i64) -> anyhow::Result<usize> {
        let subscriptions = sqlx::query_as!(
            PushRow,
            "SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1",
            user_id
        )
        .fetch_all(pool)
        .await?;
        let payload = json!({
            "title": "CipherTalk",
            "body": "Фоновые уведомления работают",
            "tag": "test",
        });
        let mut sent = 0;
        for subscription in subscriptions {
            if matches!(
                self.send_one(&subscription, &payload).await,
                Ok(PushOutcome::Delivered)
            ) {
                sent += 1;
            }
        }
        Ok(sent)
    }

    async fn send_one(
        &self,
        subscription: &PushRow,
        payload: &Value,
    ) -> anyhow::Result<PushOutcome> {
        let endpoint = subscription.endpoint.trim();
        if !endpoint.starts_with("https://") || endpoint.len() > 2048 {
            return Err(anyhow!("invalid push endpoint"));
        }
        let audience = endpoint_origin(endpoint)?;
        let jwt = self.vapid_jwt(&audience)?;
        let payload_json = payload.to_string();
        let body = encrypt_payload(
            &subscription.p256dh,
            &subscription.auth,
            payload_json.as_bytes(),
        )?;

        let mut command = Command::new("curl");
        command
            .arg("-sS")
            .arg("--max-time")
            .arg("12")
            .arg("-o")
            .arg("/dev/null")
            .arg("-w")
            .arg("%{http_code}")
            .arg("-X")
            .arg("POST")
            .arg("-H")
            .arg("TTL: 86400")
            .arg("-H")
            .arg("Urgency: normal")
            .arg("-H")
            .arg("Content-Encoding: aes128gcm")
            .arg("-H")
            .arg("Content-Type: application/octet-stream")
            .arg("-H")
            .arg(format!(
                "Authorization: vapid t={jwt}, k={}",
                self.public_key_b64
            ))
            .arg("--data-binary")
            .arg("@-")
            .arg(endpoint)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn().context("failed to spawn curl for push")?;
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(&body)
                .await
                .context("failed to write push body")?;
        }
        let output = time::timeout(Duration::from_secs(15), child.wait_with_output())
            .await
            .map_err(|_| anyhow!("push delivery timed out"))??;
        if !output.status.success() {
            return Err(anyhow!(
                "curl failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        let code = String::from_utf8_lossy(&output.stdout)
            .trim()
            .parse::<u16>()
            .unwrap_or(0);
        match code {
            200..=299 => Ok(PushOutcome::Delivered),
            404 | 410 => Ok(PushOutcome::Stale),
            other => Err(anyhow!("push endpoint returned HTTP {other}")),
        }
    }

    fn vapid_jwt(&self, audience: &str) -> anyhow::Result<String> {
        let header = URL_SAFE_NO_PAD.encode(br#"{"typ":"JWT","alg":"ES256"}"#);
        let claims = URL_SAFE_NO_PAD.encode(
            json!({
                "aud": audience,
                "exp": Utc::now().timestamp() + VAPID_TTL_SECS,
                "sub": self.subject,
            })
            .to_string(),
        );
        let signing_input = format!("{header}.{claims}");
        let signature = self
            .key
            .sign(&self.rng, signing_input.as_bytes())
            .map_err(|_| anyhow!("VAPID signing failed"))?;
        let raw = der_signature_to_raw(signature.as_ref())?;
        Ok(format!("{signing_input}.{}", URL_SAFE_NO_PAD.encode(raw)))
    }
}

fn short_endpoint(endpoint: &str) -> String {
    endpoint.chars().take(48).collect()
}

fn endpoint_origin(endpoint: &str) -> anyhow::Result<String> {
    let rest = endpoint
        .strip_prefix("https://")
        .ok_or_else(|| anyhow!("push endpoint must be HTTPS"))?;
    let host = rest
        .split('/')
        .next()
        .filter(|host| !host.is_empty())
        .ok_or_else(|| anyhow!("push endpoint has no host"))?;
    Ok(format!("https://{host}"))
}

fn message_body(message: &MessageDto) -> String {
    if !message.content.trim().is_empty() {
        return message.content.chars().take(180).collect();
    }
    match message.attachment.as_ref().map(|a| a.kind.as_str()) {
        Some("photo") => "Фото".to_owned(),
        Some("video") => "Видео".to_owned(),
        Some("voice") => "Голосовое сообщение".to_owned(),
        Some("sticker") => "Стикер".to_owned(),
        _ => "Новое сообщение".to_owned(),
    }
}

fn decode_b64(value: &str) -> anyhow::Result<Vec<u8>> {
    let value = value.trim();
    URL_SAFE_NO_PAD
        .decode(value)
        .or_else(|_| URL_SAFE.decode(value))
        .or_else(|_| STANDARD.decode(value))
        .map_err(|_| anyhow!("invalid base64 key"))
}

fn encrypt_payload(p256dh: &str, auth: &str, payload: &[u8]) -> anyhow::Result<Vec<u8>> {
    let ua_public = decode_b64(p256dh)?;
    if ua_public.len() != 65 || ua_public.first() != Some(&4) {
        return Err(anyhow!("invalid p256dh subscription key"));
    }
    let auth_secret = decode_b64(auth)?;
    if auth_secret.len() != 16 {
        return Err(anyhow!("invalid auth subscription secret"));
    }

    let rng = SystemRandom::new();
    let ephemeral = agreement::EphemeralPrivateKey::generate(&agreement::ECDH_P256, &rng)
        .map_err(|_| anyhow!("failed to generate ephemeral EC key"))?;
    let as_public = ephemeral
        .compute_public_key()
        .map_err(|_| anyhow!("failed to compute ephemeral public key"))?
        .as_ref()
        .to_vec();
    let peer = agreement::UnparsedPublicKey::new(&agreement::ECDH_P256, &ua_public);
    let shared = agreement::agree_ephemeral(ephemeral, &peer, |secret| secret.to_vec())
        .map_err(|_| anyhow!("ECDH key agreement failed"))?;

    let mut info = Vec::with_capacity(6 + ua_public.len() + as_public.len());
    info.extend_from_slice(b"WebPush: info\0");
    info.extend_from_slice(&ua_public);
    info.extend_from_slice(&as_public);

    let hkdf = Hkdf::<Sha256>::new(Some(&auth_secret), &shared);
    let mut ikm = [0u8; 32];
    hkdf.expand(&info, &mut ikm)
        .map_err(|_| anyhow!("HKDF expand failed"))?;

    let mut salt = [0u8; 16];
    rng.fill(&mut salt)
        .map_err(|_| anyhow!("failed to generate push salt"))?;
    let content_hkdf = Hkdf::<Sha256>::new(Some(&salt), &ikm);
    let mut cek = [0u8; 16];
    content_hkdf
        .expand(b"Content-Encoding: aes128gcm\0", &mut cek)
        .map_err(|_| anyhow!("HKDF content key failed"))?;
    let mut nonce_bytes = [0u8; 12];
    content_hkdf
        .expand(b"Content-Encoding: nonce\0", &mut nonce_bytes)
        .map_err(|_| anyhow!("HKDF nonce failed"))?;

    if payload.len() + 1 > 4095 {
        return Err(anyhow!("push payload is too large"));
    }
    let mut ciphertext = Vec::with_capacity(payload.len() + 1 + 16);
    ciphertext.extend_from_slice(payload);
    ciphertext.push(2);

    let key = LessSafeKey::new(
        UnboundKey::new(&AES_128_GCM, &cek).map_err(|_| anyhow!("invalid AES key"))?,
    );
    let nonce = Nonce::assume_unique_for_key(nonce_bytes);
    key.seal_in_place_append_tag(nonce, Aad::empty(), &mut ciphertext)
        .map_err(|_| anyhow!("AES-GCM encryption failed"))?;

    let mut body = Vec::with_capacity(16 + 4 + 1 + as_public.len() + ciphertext.len());
    body.extend_from_slice(&salt);
    body.extend_from_slice(&4096u32.to_be_bytes());
    body.push(as_public.len() as u8);
    body.extend_from_slice(&as_public);
    body.extend_from_slice(&ciphertext);
    Ok(body)
}

fn der_signature_to_raw(der: &[u8]) -> anyhow::Result<[u8; 64]> {
    if der.len() < 8 || der[0] != 0x30 {
        return Err(anyhow!("invalid DER signature"));
    }
    let (_, mut offset) = der_read_len(der, 1)?;
    if der.get(offset) != Some(&0x02) {
        return Err(anyhow!("invalid DER R integer"));
    }
    let (r_len, r_start) = der_read_len(der, offset + 1)?;
    let r = der
        .get(r_start..r_start + r_len)
        .ok_or_else(|| anyhow!("truncated DER R"))?;
    offset = r_start + r_len;
    if der.get(offset) != Some(&0x02) {
        return Err(anyhow!("invalid DER S integer"));
    }
    let (s_len, s_start) = der_read_len(der, offset + 1)?;
    let s = der
        .get(s_start..s_start + s_len)
        .ok_or_else(|| anyhow!("truncated DER S"))?;

    let mut raw = [0u8; 64];
    copy_der_int(r, &mut raw[..32])?;
    copy_der_int(s, &mut raw[32..])?;
    Ok(raw)
}

fn der_read_len(der: &[u8], offset: usize) -> anyhow::Result<(usize, usize)> {
    let first = *der
        .get(offset)
        .ok_or_else(|| anyhow!("truncated DER length"))?;
    if first & 0x80 == 0 {
        return Ok((first as usize, offset + 1));
    }
    let count = (first & 0x7f) as usize;
    if count == 0 || count > 2 {
        return Err(anyhow!("unsupported DER length"));
    }
    let bytes = der
        .get(offset + 1..offset + 1 + count)
        .ok_or_else(|| anyhow!("truncated DER length bytes"))?;
    let mut value = 0usize;
    for byte in bytes {
        value = (value << 8) | *byte as usize;
    }
    Ok((value, offset + 1 + count))
}

fn copy_der_int(source: &[u8], target: &mut [u8]) -> anyhow::Result<()> {
    let mut source = source;
    while source.len() > 1 && source[0] == 0 {
        source = &source[1..];
    }
    if source.len() > target.len() {
        return Err(anyhow!("DER integer is too large"));
    }
    let start = target.len() - source.len();
    target[start..].copy_from_slice(source);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypted_payload_roundtrips_with_subscription_key() {
        let rng = SystemRandom::new();
        let ua_private =
            agreement::EphemeralPrivateKey::generate(&agreement::ECDH_P256, &rng).unwrap();
        let ua_public = ua_private.compute_public_key().unwrap().as_ref().to_vec();
        let auth = [7u8; 16];
        let payload = br#"{"title":"test"}"#;
        let body = encrypt_payload(
            &URL_SAFE_NO_PAD.encode(&ua_public),
            &URL_SAFE_NO_PAD.encode(auth),
            payload,
        )
        .unwrap();

        assert_eq!(&body[16..20], &4096u32.to_be_bytes());
        assert_eq!(body[20], 65);
        let as_public = &body[21..86];
        let ciphertext = &body[86..];
        let peer = agreement::UnparsedPublicKey::new(&agreement::ECDH_P256, as_public);
        let shared =
            agreement::agree_ephemeral(ua_private, &peer, |secret| secret.to_vec()).unwrap();

        let mut info = Vec::new();
        info.extend_from_slice(b"WebPush: info\0");
        info.extend_from_slice(&ua_public);
        info.extend_from_slice(as_public);
        let hkdf = Hkdf::<Sha256>::new(Some(&auth), &shared);
        let mut ikm = [0u8; 32];
        hkdf.expand(&info, &mut ikm).unwrap();
        let content_hkdf = Hkdf::<Sha256>::new(Some(&body[..16]), &ikm);
        let mut cek = [0u8; 16];
        content_hkdf
            .expand(b"Content-Encoding: aes128gcm\0", &mut cek)
            .unwrap();
        let mut nonce = [0u8; 12];
        content_hkdf
            .expand(b"Content-Encoding: nonce\0", &mut nonce)
            .unwrap();

        let key = LessSafeKey::new(UnboundKey::new(&AES_128_GCM, &cek).unwrap());
        let mut encrypted = ciphertext.to_vec();
        let plain = key
            .open_in_place(
                Nonce::assume_unique_for_key(nonce),
                Aad::empty(),
                &mut encrypted,
            )
            .unwrap();
        assert_eq!(plain, b"{\"title\":\"test\"}\x02");
    }

    #[test]
    fn origin_is_extracted() {
        assert_eq!(
            endpoint_origin("https://fcm.googleapis.com/wp/abc").unwrap(),
            "https://fcm.googleapis.com"
        );
    }

    #[test]
    fn der_ints_are_right_aligned() {
        let mut target = [0u8; 4];
        copy_der_int(&[0, 1, 2], &mut target).unwrap();
        assert_eq!(target, [0, 0, 1, 2]);
        copy_der_int(&[1, 2], &mut target).unwrap();
        assert_eq!(target, [0, 0, 1, 2]);
    }
}
