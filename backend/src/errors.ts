export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (code: string, message: string, details?: unknown) =>
  new HttpError(404, code, message, details);

export const conflict = (code: string, message: string, details?: unknown) =>
  new HttpError(409, code, message, details);

export const badRequest = (code: string, message: string, details?: unknown) =>
  new HttpError(400, code, message, details);
