use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use anyhow::anyhow;
use rand::{rngs::OsRng, RngCore};
use sqlx::PgPool;
use tokio::{io::AsyncReadExt, process::Command, time::timeout};

use crate::{
    models::media::AttachmentDto,
    state::AppState,
    utils::error::{AppError, AppResult},
};

pub const KIND_PHOTO: &str = "photo";
pub const KIND_VIDEO: &str = "video";
pub const KIND_VOICE: &str = "voice";
pub const KIND_FILE: &str = "file";
pub const KIND_STICKER: &str = "sticker";
const STICKER_MAX_SECONDS: f64 = 5.2;
const STICKER_MAX_BYTES: u64 = 20 * 1024 * 1024;

#[derive(Debug)]
pub struct NewUpload {
    pub kind: String,
    pub file_name: String,
    pub mime_type: String,
    pub temp_path: PathBuf,
    pub size_bytes: i64,
    pub thumbnail_temp: Option<PathBuf>,
    pub width: Option<i32>,
    pub height: Option<i32>,
    pub duration_ms: Option<i32>,
}

#[derive(Debug, sqlx::FromRow)]
pub struct StoredAttachment {
    pub storage_key: String,
    pub thumbnail_key: Option<String>,
    pub mime_type: String,
    pub file_name: String,
    pub kind: String,
}

pub async fn ensure_dirs(cfg: &crate::config::Config) -> anyhow::Result<()> {
    tokio::fs::create_dir_all(&cfg.upload_dir)
        .await
        .map_err(|err| anyhow!("cannot create upload dir: {err}"))?;
    tokio::fs::create_dir_all(cfg.upload_dir.join("avatars"))
        .await
        .map_err(|err| anyhow!("cannot create avatar dir: {err}"))?;
    tokio::fs::create_dir_all(cfg.upload_dir.join("tmp"))
        .await
        .map_err(|err| anyhow!("cannot create upload tmp dir: {err}"))?;
    Ok(())
}

pub fn random_key() -> String {
    let mut bytes = [0u8; 16];
    OsRng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}

pub fn temp_path(cfg: &crate::config::Config) -> PathBuf {
    cfg.upload_dir
        .join("tmp")
        .join(format!("{}.part", random_key()))
}

pub fn normalize_mime(raw: &str) -> String {
    raw.split(';')
        .next()
        .unwrap_or(raw)
        .trim()
        .to_ascii_lowercase()
}

pub fn resolve_kind(requested: Option<&str>, mime: &str) -> AppResult<String> {
    let kind = match requested.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => value.to_ascii_lowercase(),
        None if mime.starts_with("image/") => KIND_PHOTO.into(),
        None if mime.starts_with("video/") => KIND_VIDEO.into(),
        None if mime.starts_with("audio/") => KIND_VOICE.into(),
        None => KIND_FILE.into(),
    };

    if !matches!(
        kind.as_str(),
        KIND_PHOTO | KIND_VIDEO | KIND_VOICE | KIND_FILE | KIND_STICKER
    ) {
        return Err(AppError::Validation("Неизвестный тип вложения".into()));
    }
    Ok(kind)
}

pub fn validate_kind_mime(kind: &str, mime: &str, file_name: &str) -> AppResult<()> {
    let allowed = match kind {
        KIND_PHOTO => matches!(
            mime,
            "image/jpeg" | "image/png" | "image/webp" | "image/gif"
        ),
        KIND_VIDEO => matches!(mime, "video/mp4" | "video/webm" | "video/quicktime"),
        KIND_VOICE => matches!(
            mime,
            "audio/webm" | "audio/ogg" | "audio/mpeg" | "audio/mp4" | "audio/wav" | "audio/x-wav"
        ),
        KIND_STICKER => matches!(
            mime,
            "image/jpeg"
                | "image/png"
                | "image/webp"
                | "image/gif"
                | "video/mp4"
                | "video/webm"
                | "video/quicktime"
        ),
        KIND_FILE => !file_name.trim().is_empty(),
        _ => false,
    };

    if !allowed {
        return Err(AppError::Validation(format!(
            "Недопустимый тип файла для {kind}: {mime}"
        )));
    }
    Ok(())
}

pub async fn store_attachment(
    state: &AppState,
    uploader_id: i64,
    chat_id: i64,
    upload: NewUpload,
) -> AppResult<AttachmentDto> {
    let kind = resolve_kind(Some(&upload.kind), &upload.mime_type)?;
    let mime = if upload.mime_type.trim().is_empty() {
        mime_guess::from_path(&upload.file_name)
            .first_or_octet_stream()
            .essence_str()
            .to_owned()
    } else {
        normalize_mime(&upload.mime_type)
    };
    validate_kind_mime(&kind, &mime, &upload.file_name)?;

    if upload.size_bytes <= 0 || upload.size_bytes as u64 > state.cfg.max_upload_bytes {
        let _ = tokio::fs::remove_file(&upload.temp_path).await;
        return Err(AppError::Validation("Файл слишком большой".into()));
    }

    if kind == KIND_STICKER {
        return store_sticker(state, uploader_id, chat_id, upload, &mime).await;
    }

    let extension = extension_for(&mime, &upload.file_name);
    let key = format!("{}.{}", random_key(), extension);
    let final_path = state.cfg.upload_dir.join(&key);
    let mut thumbnail_key: Option<String> = None;
    let mut width = upload.width.filter(|value| *value > 0 && *value <= 20_000);
    let mut height = upload.height.filter(|value| *value > 0 && *value <= 20_000);
    let mut duration_ms = upload
        .duration_ms
        .filter(|value| (0..=24 * 60 * 60 * 1000).contains(value));

    let result: AppResult<()> = async {
        match kind.as_str() {
            KIND_PHOTO => {
                validate_image(&upload.temp_path, &mime).await?;
                tokio::fs::rename(&upload.temp_path, &final_path)
                    .await
                    .map_err(|err| AppError::Internal(anyhow!("cannot store photo: {err}")))?;
                if let Some(thumb_temp) = upload.thumbnail_temp.clone() {
                    validate_image(&thumb_temp, "image/jpeg").await?;
                    let thumb_key = format!("{}.thumb.jpg", random_key());
                    let thumb_path = state.cfg.upload_dir.join(&thumb_key);
                    tokio::fs::rename(&thumb_temp, &thumb_path)
                        .await
                        .map_err(|err| {
                            AppError::Internal(anyhow!("cannot store thumbnail: {err}"))
                        })?;
                    thumbnail_key = Some(thumb_key);
                }
            }
            KIND_VIDEO => {
                tokio::fs::rename(&upload.temp_path, &final_path)
                    .await
                    .map_err(|err| AppError::Internal(anyhow!("cannot store video: {err}")))?;
                if let Some(thumb_temp) = upload.thumbnail_temp.clone() {
                    if validate_image(&thumb_temp, "image/jpeg").await.is_ok() {
                        let thumb_key = format!("{}.thumb.jpg", random_key());
                        let thumb_path = state.cfg.upload_dir.join(&thumb_key);
                        tokio::fs::rename(&thumb_temp, &thumb_path)
                            .await
                            .map_err(|err| {
                                AppError::Internal(anyhow!("cannot store video thumbnail: {err}"))
                            })?;
                        thumbnail_key = Some(thumb_key);
                    } else {
                        let _ = tokio::fs::remove_file(&thumb_temp).await;
                    }
                }
            }
            KIND_VOICE | KIND_FILE => {
                tokio::fs::rename(&upload.temp_path, &final_path)
                    .await
                    .map_err(|err| AppError::Internal(anyhow!("cannot store upload: {err}")))?;
            }
            _ => unreachable!(),
        }
        if width.is_none() && height.is_none() {
            // Dimensions are optional; the browser supplies them for previews.
        }
        if width.is_none() {
            height = None;
        }
        if height.is_none() {
            width = None;
        }
        duration_ms = duration_ms.filter(|value| *value >= 0);
        Ok(())
    }
    .await;

    if let Err(err) = result {
        let _ = tokio::fs::remove_file(&final_path).await;
        if let Some(key) = &thumbnail_key {
            let _ = tokio::fs::remove_file(state.cfg.upload_dir.join(key)).await;
        }
        let _ = tokio::fs::remove_file(&upload.temp_path).await;
        if let Some(thumb) = &upload.thumbnail_temp {
            let _ = tokio::fs::remove_file(thumb).await;
        }
        return Err(err);
    }

    let insert = sqlx::query!(
        r#"
        INSERT INTO attachments
            (uploader_id, chat_id, kind, file_name, mime_type, size_bytes,
             width, height, duration_ms, storage_key, thumbnail_key)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING id
        "#,
        uploader_id,
        chat_id,
        kind.clone(),
        upload.file_name.clone(),
        mime.clone(),
        upload.size_bytes,
        width,
        height,
        duration_ms,
        key,
        thumbnail_key.clone()
    )
    .fetch_one(&state.pool)
    .await;

    let id = match insert {
        Ok(row) => row.id,
        Err(err) => {
            let _ = tokio::fs::remove_file(&final_path).await;
            if let Some(key) = &thumbnail_key {
                let _ = tokio::fs::remove_file(state.cfg.upload_dir.join(key)).await;
            }
            return Err(err.into());
        }
    };

    Ok(AttachmentDto {
        id,
        kind,
        file_name: upload.file_name,
        mime_type: mime,
        size_bytes: upload.size_bytes,
        width,
        height,
        duration_ms,
        content_url: format!("/api/attachments/{id}/content"),
        thumbnail_url: thumbnail_key.map(|_| format!("/api/attachments/{id}/thumbnail")),
    })
}

async fn store_sticker(
    state: &AppState,
    uploader_id: i64,
    chat_id: i64,
    upload: NewUpload,
    source_mime: &str,
) -> AppResult<AttachmentDto> {
    let key = format!("{}.gif", random_key());
    let final_path = state.cfg.upload_dir.join(&key);

    let converted = convert_sticker(&upload.temp_path, &final_path, source_mime).await;
    let _ = tokio::fs::remove_file(&upload.temp_path).await;
    if let Some(thumb) = &upload.thumbnail_temp {
        let _ = tokio::fs::remove_file(thumb).await;
    }
    let (width, height, duration_ms, size_bytes) = match converted {
        Ok(value) => value,
        Err(err) => {
            let _ = tokio::fs::remove_file(&final_path).await;
            return Err(err);
        }
    };

    let insert = sqlx::query!(
        r#"
        INSERT INTO attachments
            (uploader_id, chat_id, kind, file_name, mime_type, size_bytes,
             width, height, duration_ms, storage_key, thumbnail_key)
        VALUES ($1, $2, $3, 'sticker.gif', 'image/gif', $4, $5, $6, $7, $8, NULL)
        RETURNING id
        "#,
        uploader_id,
        chat_id,
        KIND_STICKER,
        size_bytes,
        width,
        height,
        duration_ms,
        key
    )
    .fetch_one(&state.pool)
    .await;

    let id = match insert {
        Ok(row) => row.id,
        Err(err) => {
            let _ = tokio::fs::remove_file(&final_path).await;
            return Err(err.into());
        }
    };

    Ok(AttachmentDto {
        id,
        kind: KIND_STICKER.into(),
        file_name: "sticker.gif".into(),
        mime_type: "image/gif".into(),
        size_bytes,
        width,
        height,
        duration_ms,
        content_url: format!("/api/attachments/{id}/content"),
        thumbnail_url: None,
    })
}

async fn convert_sticker(
    source: &Path,
    output: &Path,
    source_mime: &str,
) -> AppResult<(Option<i32>, Option<i32>, Option<i32>, i64)> {
    let probe = timeout(
        Duration::from_secs(15),
        Command::new("ffprobe")
            .arg("-v")
            .arg("error")
            .arg("-show_entries")
            .arg("format=duration:stream=width,height")
            .arg("-of")
            .arg("json")
            .arg(source)
            .output(),
    )
    .await
    .map_err(|_| AppError::Validation("ffprobe не ответил".into()))?
    .map_err(|_| AppError::Validation("ffprobe не установлен на сервере".into()))?;
    if !probe.status.success() {
        return Err(AppError::Validation(
            "Не удалось прочитать фото или видео для стикера".into(),
        ));
    }
    let probe: serde_json::Value = serde_json::from_slice(&probe.stdout)
        .map_err(|_| AppError::Validation("Некорректные метаданные стикера".into()))?;
    let duration = probe["format"]["duration"]
        .as_str()
        .and_then(|value| value.parse::<f64>().ok())
        .or_else(|| probe["format"]["duration"].as_f64());
    let width = probe["streams"]
        .as_array()
        .and_then(|streams| streams.first())
        .and_then(|stream| stream["width"].as_i64())
        .and_then(|value| i32::try_from(value).ok());
    let height = probe["streams"]
        .as_array()
        .and_then(|streams| streams.first())
        .and_then(|stream| stream["height"].as_i64())
        .and_then(|value| i32::try_from(value).ok());

    let is_video = source_mime.starts_with("video/");
    if is_video && duration.is_some_and(|value| value > STICKER_MAX_SECONDS) {
        return Err(AppError::Validation(
            "Видео для стикера должно быть не длиннее 5 секунд".into(),
        ));
    }

    let mut command = Command::new("ffmpeg");
    command
        .arg("-y")
        .arg("-v")
        .arg("error")
        .arg("-i")
        .arg(source)
        .arg("-vf")
        .arg("scale=320:320:force_original_aspect_ratio=decrease:flags=lanczos")
        .arg("-an");
    if is_video {
        command.arg("-t").arg("5").arg("-r").arg("12");
    } else {
        command.arg("-frames:v").arg("1");
    }
    command.arg("-loop").arg("0").arg(output);

    let result = timeout(Duration::from_secs(30), command.output())
        .await
        .map_err(|_| AppError::Validation("ffmpeg не успел создать стикер".into()))?
        .map_err(|_| AppError::Validation("ffmpeg не установлен на сервере".into()))?;
    if !result.status.success() {
        let details = String::from_utf8_lossy(&result.stderr);
        tracing::warn!(error = %details, "ffmpeg sticker conversion failed");
        return Err(AppError::Validation(
            "Не удалось превратить файл в GIF-стикер".into(),
        ));
    }

    let metadata = tokio::fs::metadata(output)
        .await
        .map_err(|err| AppError::Internal(anyhow!("cannot stat sticker: {err}")))?;
    if metadata.len() == 0 || metadata.len() > STICKER_MAX_BYTES {
        return Err(AppError::Validation(
            "Стикер получился слишком большим".into(),
        ));
    }
    let duration_ms = duration
        .map(|value| (value * 1000.0).round().clamp(0.0, 5000.0) as i32)
        .filter(|_| is_video);

    Ok((width, height, duration_ms, metadata.len() as i64))
}

pub async fn store_avatar(
    state: &AppState,
    user_id: i64,
    temp_path: PathBuf,
    mime: &str,
) -> AppResult<String> {
    let mime = normalize_mime(mime);
    if !matches!(
        mime.as_str(),
        "image/jpeg" | "image/png" | "image/webp" | "image/gif"
    ) {
        let _ = tokio::fs::remove_file(&temp_path).await;
        return Err(AppError::Validation(
            "Аватар должен быть изображением JPEG, PNG, WebP или GIF".into(),
        ));
    }
    validate_image(&temp_path, &mime).await?;

    let extension = extension_for(&mime, "avatar.jpg");
    let key = format!("{}.{}", random_key(), extension);
    let target = state.cfg.upload_dir.join("avatars").join(&key);
    tokio::fs::rename(&temp_path, &target)
        .await
        .map_err(|err| AppError::Internal(anyhow!("cannot store avatar: {err}")))?;
    let _ = tokio::fs::remove_file(&temp_path).await;

    let url = format!("/media/avatars/{key}");
    let updated = sqlx::query!(
        "UPDATE users SET avatar_url = $2 WHERE id = $1",
        user_id,
        url.clone()
    )
    .execute(&state.pool)
    .await?;
    if updated.rows_affected() != 1 {
        let _ = tokio::fs::remove_file(&target).await;
        return Err(AppError::NotFound("Пользователь не найден".into()));
    }

    Ok(url)
}

pub async fn remove_avatar(state: &AppState, user_id: i64) -> AppResult<()> {
    sqlx::query!("UPDATE users SET avatar_url = NULL WHERE id = $1", user_id)
        .execute(&state.pool)
        .await?;
    Ok(())
}

pub async fn stored_for_user(
    pool: &PgPool,
    attachment_id: i64,
    user_id: i64,
) -> AppResult<StoredAttachment> {
    let row = sqlx::query_as!(
        StoredAttachment,
        r#"
        SELECT a.storage_key, a.thumbnail_key, a.mime_type, a.file_name, a.kind
        FROM attachments a
        JOIN messages m ON m.id = a.message_id
        JOIN chat_members cm ON cm.chat_id = a.chat_id AND cm.user_id = $2
        WHERE a.id = $1 AND m.deleted_at IS NULL
        "#,
        attachment_id,
        user_id
    )
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Вложение не найдено".into()))?;
    Ok(row)
}

fn extension_for(mime: &str, file_name: &str) -> String {
    let known = match mime {
        "image/jpeg" => Some("jpg"),
        "image/png" => Some("png"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        "video/mp4" => Some("mp4"),
        "video/webm" => Some("webm"),
        "video/quicktime" => Some("mov"),
        "audio/webm" => Some("webm"),
        "audio/ogg" => Some("ogg"),
        "audio/mpeg" => Some("mp3"),
        "audio/mp4" => Some("m4a"),
        "audio/wav" | "audio/x-wav" => Some("wav"),
        _ => None,
    };
    if let Some(ext) = known {
        return ext.to_owned();
    }

    if let Some(ext) = Path::new(file_name)
        .extension()
        .and_then(|ext| ext.to_str())
    {
        let cleaned: String = ext
            .chars()
            .filter(|ch| ch.is_ascii_alphanumeric())
            .take(8)
            .collect();
        if !cleaned.is_empty() {
            return cleaned.to_ascii_lowercase();
        }
    }
    "bin".to_owned()
}

async fn validate_image(path: &Path, mime: &str) -> AppResult<()> {
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|err| AppError::Validation(format!("Не удалось открыть изображение: {err}")))?;
    let mut header = [0u8; 12];
    let read = file
        .read(&mut header)
        .await
        .map_err(|err| AppError::Validation(format!("Не удалось прочитать изображение: {err}")))?;
    if read < 6 {
        return Err(AppError::Validation("Файл изображения повреждён".into()));
    }

    let valid = match mime {
        "image/jpeg" => header[..3] == [0xFF, 0xD8, 0xFF],
        "image/png" => header[..8] == [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A],
        "image/gif" => &header[..6] == b"GIF87a" || &header[..6] == b"GIF89a",
        "image/webp" => read >= 12 && &header[..4] == b"RIFF" && &header[8..12] == b"WEBP",
        _ => false,
    };
    if !valid {
        return Err(AppError::Validation(
            "Содержимое не соответствует формату изображения".into(),
        ));
    }
    Ok(())
}

pub fn safe_file_name(raw: &str) -> String {
    let base = raw
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("file")
        .chars()
        .filter(|ch| !ch.is_control())
        .take(180)
        .collect::<String>();
    let base = base.trim();
    if base.is_empty() {
        "file".to_owned()
    } else {
        base.to_owned()
    }
}
