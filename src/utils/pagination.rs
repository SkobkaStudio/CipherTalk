use serde::Deserialize;

use crate::utils::{AppError, AppResult};

pub const DEFAULT_PAGE_SIZE: i64 = 50;
pub const MAX_PAGE_SIZE: i64 = 100;

#[derive(Debug, Deserialize)]
pub struct HistoryQuery {
    pub limit: Option<i64>,
    pub offset: Option<i64>,
    pub before_id: Option<i64>,
    pub after_id: Option<i64>,
}

#[derive(Debug, Clone, Copy)]
pub struct HistoryPage {
    pub limit: i64,
    pub offset: i64,
    pub before_id: Option<i64>,
    pub after_id: Option<i64>,
}

impl HistoryQuery {
    pub fn normalize(&self) -> AppResult<HistoryPage> {
        let limit = self.limit.unwrap_or(DEFAULT_PAGE_SIZE);
        if !(1..=MAX_PAGE_SIZE).contains(&limit) {
            return Err(AppError::Validation(format!(
                "limit должен быть от 1 до {MAX_PAGE_SIZE}"
            )));
        }

        let offset = self.offset.unwrap_or(0);
        if offset < 0 {
            return Err(AppError::Validation(
                "offset не может быть отрицательным".into(),
            ));
        }

        if self.before_id.is_some() && self.after_id.is_some() {
            return Err(AppError::Validation(
                "нельзя одновременно указать before_id и after_id".into(),
            ));
        }

        for (name, value) in [("before_id", self.before_id), ("after_id", self.after_id)] {
            if matches!(value, Some(id) if id <= 0) {
                return Err(AppError::Validation(format!(
                    "{name} должен быть положительным"
                )));
            }
        }

        Ok(HistoryPage {
            limit,
            offset,
            before_id: self.before_id,
            after_id: self.after_id,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_and_bounds() {
        let query = HistoryQuery {
            limit: None,
            offset: None,
            before_id: None,
            after_id: None,
        };
        let page = query.normalize().expect("default page");
        assert_eq!(page.limit, 50);
        assert_eq!(page.offset, 0);

        let invalid = HistoryQuery {
            limit: Some(101),
            offset: None,
            before_id: None,
            after_id: None,
        };
        assert!(invalid.normalize().is_err());
    }

    #[test]
    fn rejects_conflicting_cursors() {
        let query = HistoryQuery {
            limit: Some(10),
            offset: None,
            before_id: Some(5),
            after_id: Some(6),
        };
        assert!(query.normalize().is_err());
    }
}
