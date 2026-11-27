use crate::utils::{AppError, AppResult};

pub fn normalize_username(raw: &str) -> AppResult<String> {
    let username = raw.trim().to_ascii_lowercase();
    let len = username.chars().count();
    if !(3..=32).contains(&len) {
        return Err(AppError::Validation(
            "username должен содержать от 3 до 32 символов".into(),
        ));
    }
    if !username
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_')
    {
        return Err(AppError::Validation(
            "username может содержать только латиницу, цифры и _".into(),
        ));
    }
    Ok(username)
}

pub fn normalize_login_identifier(raw: &str) -> AppResult<String> {
    let value = raw.trim().to_ascii_lowercase();
    if value.is_empty() || value.chars().count() > 254 {
        return Err(AppError::Validation("Укажите username или email".into()));
    }
    Ok(value)
}

pub fn validate_password(password: &str) -> AppResult<()> {
    let len = password.chars().count();
    if !(8..=128).contains(&len) {
        return Err(AppError::Validation(
            "Пароль должен содержать от 8 до 128 символов".into(),
        ));
    }
    Ok(())
}

pub fn normalize_email(raw: Option<String>) -> AppResult<Option<String>> {
    let Some(raw) = raw else { return Ok(None) };
    let email = raw.trim().to_ascii_lowercase();
    if email.is_empty() {
        return Ok(None);
    }
    if email.chars().count() > 254 {
        return Err(AppError::Validation("Email слишком длинный".into()));
    }
    let mut parts = email.split('@');
    let local = parts.next().unwrap_or_default();
    let domain = parts.next().unwrap_or_default();
    if parts.next().is_some()
        || local.is_empty()
        || domain.is_empty()
        || !domain.contains('.')
        || email.chars().any(char::is_whitespace)
    {
        return Err(AppError::Validation("Некорректный email".into()));
    }
    Ok(Some(email))
}

pub fn normalize_display_name(raw: &str) -> AppResult<String> {
    let name = raw.trim();
    let len = name.chars().count();
    if !(1..=64).contains(&len) {
        return Err(AppError::Validation(
            "Имя должно содержать от 1 до 64 символов".into(),
        ));
    }
    if name.chars().any(char::is_control) {
        return Err(AppError::Validation(
            "Имя содержит недопустимые символы".into(),
        ));
    }
    Ok(name.to_owned())
}

pub fn normalize_bio(raw: &str) -> AppResult<String> {
    let bio = raw.trim();
    if bio.chars().count() > 280 {
        return Err(AppError::Validation(
            "Описание не должно превышать 280 символов".into(),
        ));
    }
    if bio
        .chars()
        .any(|c| c.is_control() && c != '\n' && c != '\t')
    {
        return Err(AppError::Validation(
            "Описание содержит недопустимые символы".into(),
        ));
    }
    Ok(bio.to_owned())
}

pub fn normalize_avatar_url(raw: Option<String>) -> AppResult<Option<String>> {
    let Some(raw) = raw else { return Ok(None) };
    let url = raw.trim();
    if url.is_empty() {
        return Ok(None);
    }
    if url.chars().count() > 500 || !url.chars().all(|c| !c.is_control()) {
        return Err(AppError::Validation("Некорректная ссылка на аватар".into()));
    }
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(AppError::Validation(
            "Ссылка на аватар должна начинаться с http:// или https://".into(),
        ));
    }
    Ok(Some(url.to_owned()))
}

pub fn normalize_message(raw: &str, max_chars: usize) -> AppResult<String> {
    if raw.contains('\0') {
        return Err(AppError::Validation(
            "Сообщение содержит недопустимые символы".into(),
        ));
    }
    if raw
        .chars()
        .any(|c| c.is_control() && c != '\n' && c != '\t')
    {
        return Err(AppError::Validation(
            "Сообщение содержит недопустимые символы".into(),
        ));
    }
    if raw.trim().is_empty() {
        return Err(AppError::Validation(
            "Сообщение не может быть пустым".into(),
        ));
    }
    let len = raw.chars().count();
    if len > max_chars {
        return Err(AppError::Validation(format!(
            "Сообщение не должно превышать {max_chars} символов"
        )));
    }
    Ok(raw.to_owned())
}

pub fn normalize_chat_title(raw: &str) -> AppResult<String> {
    let title = raw.trim();
    let len = title.chars().count();
    if !(1..=128).contains(&len) {
        return Err(AppError::Validation(
            "Название группы должно содержать от 1 до 128 символов".into(),
        ));
    }
    if title.chars().any(char::is_control) {
        return Err(AppError::Validation(
            "Название содержит недопустимые символы".into(),
        ));
    }
    Ok(title.to_owned())
}

pub fn normalize_search_query(raw: &str) -> AppResult<String> {
    let query = raw.trim();
    if query.is_empty() || query.chars().count() > 32 {
        return Err(AppError::Validation(
            "Поисковый запрос должен быть от 1 до 32 символов".into(),
        ));
    }
    if query.chars().any(|c| c.is_control()) {
        return Err(AppError::Validation("Некорректный поисковый запрос".into()));
    }
    Ok(query.to_ascii_lowercase())
}

/// Escape SQL LIKE metacharacters in user input. The query itself is still
/// parameterised; this only prevents wildcard injection into search.
pub fn escape_like(input: &str) -> String {
    let mut escaped = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '\\' | '%' | '_' => {
                escaped.push('\\');
                escaped.push(ch);
            }
            other => escaped.push(other),
        }
    }
    escaped
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usernames_are_normalised() {
        assert_eq!(normalize_username("  Alice_01 ").unwrap(), "alice_01");
        assert!(normalize_username("ab").is_err());
        assert!(normalize_username("bad-name").is_err());
        assert!(normalize_username("юзер").is_err());
    }

    #[test]
    fn messages_are_not_blank() {
        assert!(normalize_message("   ", 100).is_err());
        assert_eq!(normalize_message(" hi\n", 100).unwrap(), " hi\n");
        assert!(normalize_message("a".repeat(101).as_str(), 100).is_err());
    }

    #[test]
    fn like_metacharacters_are_escaped() {
        assert_eq!(escape_like("a%b_c\\d"), "a\\%b\\_c\\\\d");
    }

    #[test]
    fn email_validation() {
        assert_eq!(
            normalize_email(Some(" User@Example.COM ".into())).unwrap(),
            Some("user@example.com".to_owned())
        );
        assert!(normalize_email(Some("not-an-email".into())).is_err());
    }
}
