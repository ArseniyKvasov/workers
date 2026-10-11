export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown[]
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function notFound(resource: string, id?: string): HttpError {
  return new HttpError(404, "NOT_FOUND", id ? `${resource} "${id}" not found` : `${resource} not found`);
}

export function conflict(message: string): HttpError {
  return new HttpError(409, "CONFLICT", message);
}

export function badRequest(message: string, details?: unknown[]): HttpError {
  return new HttpError(400, "VALIDATION_ERROR", message, details);
}

export function limitExceeded(message: string): HttpError {
  return new HttpError(403, "LIMIT_EXCEEDED", message);
}

export function payloadTooLarge(message: string): HttpError {
  return new HttpError(413, "PAYLOAD_TOO_LARGE", message);
}

export function unauthorized(message: string): HttpError {
  return new HttpError(401, "UNAUTHORIZED", message);
}
