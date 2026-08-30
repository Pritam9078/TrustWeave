/**
 * One error type carrying an HTTP status and a stable machine-readable code.
 * Routes never hand-roll status codes; the error handler in app.ts maps these, so
 * an unexpected throw can never leak a stack trace or be mistaken for success.
 */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const badRequest = (code: string, m: string, d?: unknown) => new AppError(400, code, m, d);
export const unauthorized = (m = "Authentication required.") => new AppError(401, "SESSION_INVALID", m);
export const forbidden = (code: string, m: string, d?: unknown) => new AppError(403, code, m, d);
export const notFound = (m = "Resource not found.") => new AppError(404, "RESOURCE_NOT_FOUND", m);
export const conflict = (code: string, m: string, d?: unknown) => new AppError(409, code, m, d);
export const unprocessable = (code: string, m: string, d?: unknown) => new AppError(422, code, m, d);
