export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, message, details);

export const unauthorized = (message = "Unauthorized") =>
  new HttpError(401, message);

export const forbidden = (message = "Forbidden") => new HttpError(403, message);

export const notFound = (message = "Not found") => new HttpError(404, message);

export const conflict = (message = "Conflict") => new HttpError(409, message);

export const serviceUnavailable = (message = "Service unavailable") =>
  new HttpError(503, message);

export const rateLimit = (message: string, details?: unknown) =>
  new HttpError(429, message, details);
