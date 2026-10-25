class AppError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
    Error.captureStackTrace && Error.captureStackTrace(this, this.constructor);
  }
}

class ValidationError extends AppError { constructor(m) { super(m, 400); } }
class AuthError extends AppError { constructor(m) { super(m, 401); } }
class ForbiddenError extends AppError { constructor(m) { super(m, 403); } }
class NotFoundError extends AppError { constructor(m) { super(m, 404); } }
class RateLimitError extends AppError { constructor(m) { super(m, 429); } }

module.exports = { AppError, ValidationError, AuthError, ForbiddenError, NotFoundError, RateLimitError };
