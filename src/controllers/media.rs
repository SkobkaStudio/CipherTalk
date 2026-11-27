use std::path::{Path as FsPath, PathBuf};

use axum::{
    body::Body,
    extract::{multipart::Field, Multipart, Path, State},
    http::{
        header::{
            AUTHORIZATION, CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_TYPE, RANGE,
            X_CONTENT_TYPE_OPTIONS,
        },
        HeaderMap, HeaderValue, Method, Request, StatusCode,
    },
    response::{IntoResponse, Response},
    Extension, Json,
};
use axum_extra::extract::cookie::CookieJar;
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use tokio::io::AsyncWriteExt;
use tower::ServiceExt;
use tower_http::services::ServeFile;

use crate::{
    models::{auth::AuthUser, media::AttachmentDto, user::Me},
    services::{auth as auth_service, chats, media, users},
    state::AppState,
    utils::error::{AppError, AppResult},
};

const THUMBNAIL_MAX: u64 = 8 * 1024 * 1024;

pub async fn upload_attachment(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path(chat_id): Path<i64>,
    multipart: Multipart,
) -> AppResult<(StatusCode, Json<AttachmentDto>)> {
    chats::require_membership(&state.pool, chat_id, auth.user_id).await?;

    let upload = read_upload(&state, multipart).await?;
    let dto = media::store_attachment(&state, auth.user_id, chat_id, upload).await?;
    Ok((StatusCode::CREATED, Json(dto)))
}

pub async fn upload_avatar(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    mut multipart: Multipart,
) -> AppResult<Json<Me>> {
    let mut temp: Option<(PathBuf, String)> = None;

    while let Some(mut field) = multipart
        .next_field()
        .await
        .map_err(|_| AppError::Validation("Некорректная multipart-форма".into()))?
    {
        let name = field.name().unwrap_or_default().to_owned();
        if name != "avatar" {
            let _ = field.bytes().await;
            continue;
        }
        if temp.is_some() {
            return Err(AppError::Validation(
                "Аватар можно отправить только один раз".into(),
            ));
        }
        let path = media::temp_path(&state.cfg);
        let mime = field
            .content_type()
            .unwrap_or("application/octet-stream")
            .to_owned();
        write_field(&mut field, &path, state.cfg.max_avatar_bytes).await?;
        temp = Some((path, mime));
    }

    let Some((path, mime)) = temp else {
        return Err(AppError::Validation("Файл аватара не найден".into()));
    };

    if let Err(err) = media::store_avatar(&state, auth.user_id, path.clone(), &mime).await {
        let _ = tokio::fs::remove_file(&path).await;
        return Err(err);
    }

    let me = users::get_me(&state, auth.user_id).await?;
    let publish_state = state.clone();
    let publish_user = me.clone();
    tokio::spawn(async move {
        if let Err(err) = users::publish_updated(&publish_state, &publish_user).await {
            tracing::warn!(error = %err, "failed to publish user.updated");
        }
    });
    Ok(Json(me))
}

pub async fn delete_avatar(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
) -> AppResult<Json<Me>> {
    media::remove_avatar(&state, auth.user_id).await?;
    let me = users::get_me(&state, auth.user_id).await?;
    let publish_state = state.clone();
    let publish_user = me.clone();
    tokio::spawn(async move {
        if let Err(err) = users::publish_updated(&publish_state, &publish_user).await {
            tracing::warn!(error = %err, "failed to publish user.updated");
        }
    });
    Ok(Json(me))
}

pub async fn content(
    State(state): State<AppState>,
    Path(attachment_id): Path<i64>,
    headers: HeaderMap,
    jar: CookieJar,
) -> AppResult<Response> {
    serve_attachment(state, attachment_id, headers, jar, false).await
}

pub async fn thumbnail(
    State(state): State<AppState>,
    Path(attachment_id): Path<i64>,
    headers: HeaderMap,
    jar: CookieJar,
) -> AppResult<Response> {
    serve_attachment(state, attachment_id, headers, jar, true).await
}

async fn serve_attachment(
    state: AppState,
    attachment_id: i64,
    headers: HeaderMap,
    jar: CookieJar,
    thumbnail: bool,
) -> AppResult<Response> {
    let token = media_token(&headers, &jar).ok_or(AppError::Unauthorized)?;
    let auth = auth_service::authenticate(&state, &token).await?;
    let stored = media::stored_for_user(&state.pool, attachment_id, auth.user_id).await?;

    let key = if thumbnail {
        stored
            .thumbnail_key
            .clone()
            .ok_or_else(|| AppError::NotFound("Превью не найдено".into()))?
    } else {
        stored.storage_key.clone()
    };

    if key.contains('/') || key.contains('\\') || key.contains("..") {
        return Err(AppError::Internal(anyhow::anyhow!(
            "invalid stored media key"
        )));
    }

    let path = state.cfg.upload_dir.join(&key);
    if tokio::fs::metadata(&path).await.is_err() {
        return Err(AppError::NotFound("Файл не найден".into()));
    }

    let mut request = Request::builder()
        .method(Method::GET)
        .uri("/")
        .body(Body::empty())
        .map_err(|err| AppError::Internal(anyhow::anyhow!("media request: {err}")))?;
    if let Some(range) = headers.get(RANGE) {
        request.headers_mut().insert(RANGE, range.clone());
    }

    let service = ServeFile::new(&path);
    let response = service
        .oneshot(request)
        .await
        .map_err(|err| AppError::Internal(anyhow::anyhow!("serve file: {err}")))?;
    let mut response = response.into_response();

    let mime = if thumbnail {
        "image/jpeg".to_owned()
    } else {
        stored.mime_type.clone()
    };
    if let Ok(value) = HeaderValue::from_str(&mime) {
        response.headers_mut().insert(CONTENT_TYPE, value);
    }
    let disposition = content_disposition(&stored.kind, &stored.file_name);
    if let Ok(value) = HeaderValue::from_str(&disposition) {
        response.headers_mut().insert(CONTENT_DISPOSITION, value);
    }
    response.headers_mut().insert(
        CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=86400"),
    );
    response
        .headers_mut()
        .insert(X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));

    Ok(response)
}

async fn read_upload(state: &AppState, mut multipart: Multipart) -> AppResult<media::NewUpload> {
    let mut kind: Option<String> = None;
    let mut file_name = String::new();
    let mut mime_type = String::new();
    let mut temp_path: Option<PathBuf> = None;
    let mut size_bytes: i64 = 0;
    let mut thumbnail_temp: Option<PathBuf> = None;
    let mut width: Option<i32> = None;
    let mut height: Option<i32> = None;
    let mut duration_ms: Option<i32> = None;

    while let Some(mut field) = multipart
        .next_field()
        .await
        .map_err(|_| AppError::Validation("Некорректная multipart-форма".into()))?
    {
        let name = field.name().unwrap_or_default().to_owned();
        match name.as_str() {
            "kind" => {
                kind = Some(
                    field
                        .text()
                        .await
                        .map_err(|_| AppError::Validation("Некорректный тип".into()))?,
                );
            }
            "width" => width = parse_optional_i32(field.text().await.ok().as_deref())?,
            "height" => height = parse_optional_i32(field.text().await.ok().as_deref())?,
            "duration_ms" => duration_ms = parse_optional_i32(field.text().await.ok().as_deref())?,
            "file" => {
                if temp_path.is_some() {
                    return Err(AppError::Validation(
                        "Файл можно отправить только один раз".into(),
                    ));
                }
                file_name = media::safe_file_name(field.file_name().unwrap_or("file"));
                mime_type = field
                    .content_type()
                    .unwrap_or("application/octet-stream")
                    .to_owned();
                let path = media::temp_path(&state.cfg);
                size_bytes = write_field(&mut field, &path, state.cfg.max_upload_bytes).await?;
                temp_path = Some(path);
            }
            "thumbnail" => {
                if thumbnail_temp.is_some() {
                    return Err(AppError::Validation(
                        "Превью можно отправить только один раз".into(),
                    ));
                }
                let path = media::temp_path(&state.cfg);
                write_field(&mut field, &path, THUMBNAIL_MAX).await?;
                thumbnail_temp = Some(path);
            }
            _ => {
                let _ = field.bytes().await;
            }
        }
    }

    let Some(temp_path) = temp_path else {
        return Err(AppError::Validation("Файл не найден".into()));
    };

    let kind = media::resolve_kind(kind.as_deref(), &media::normalize_mime(&mime_type))?;
    Ok(media::NewUpload {
        kind,
        file_name,
        mime_type,
        temp_path,
        size_bytes,
        thumbnail_temp,
        width,
        height,
        duration_ms,
    })
}

async fn write_field(field: &mut Field<'_>, path: &FsPath, max_bytes: u64) -> AppResult<i64> {
    let mut file = tokio::fs::File::create(path)
        .await
        .map_err(|err| AppError::Internal(anyhow::anyhow!("cannot create upload: {err}")))?;
    let mut size = 0u64;

    while let Some(chunk) = field
        .chunk()
        .await
        .map_err(|_| AppError::Validation("Не удалось прочитать файл".into()))?
    {
        size += chunk.len() as u64;
        if size > max_bytes {
            drop(file);
            let _ = tokio::fs::remove_file(path).await;
            return Err(AppError::Validation("Файл слишком большой".into()));
        }
        file.write_all(&chunk)
            .await
            .map_err(|err| AppError::Internal(anyhow::anyhow!("cannot write upload: {err}")))?;
    }
    file.flush()
        .await
        .map_err(|err| AppError::Internal(anyhow::anyhow!("cannot flush upload: {err}")))?;
    Ok(size as i64)
}

fn parse_optional_i32(raw: Option<&str>) -> AppResult<Option<i32>> {
    match raw.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => value
            .parse::<i32>()
            .map(Some)
            .map_err(|_| AppError::Validation("Некорректное числовое поле".into())),
        None => Ok(None),
    }
}

fn media_token(headers: &HeaderMap, jar: &CookieJar) -> Option<String> {
    if let Some(value) = headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
    {
        if let Some(token) = value
            .strip_prefix("Bearer ")
            .or_else(|| value.strip_prefix("bearer "))
        {
            let token = token.trim();
            if !token.is_empty() {
                return Some(token.to_owned());
            }
        }
    }
    jar.get("ct_media")
        .map(|cookie| cookie.value().to_owned())
        .filter(|value| !value.is_empty())
}

fn content_disposition(kind: &str, file_name: &str) -> String {
    let ascii = file_name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, ' ' | '.' | '-' | '_' | '(' | ')') {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    let encoded = utf8_percent_encode(file_name, NON_ALPHANUMERIC).to_string();
    let disposition = if kind == media::KIND_FILE {
        "attachment"
    } else {
        "inline"
    };
    format!(
        "{disposition}; filename=\"{}\"; filename*=UTF-8''{}",
        ascii.replace('"', "_"),
        encoded
    )
}
