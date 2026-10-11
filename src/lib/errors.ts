/** Error with a stable machine code. `status` is the HTTP status used on dashboard routes. */
export class NodiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
    public details?: unknown,
    public requestId?: string,
  ) {
    super(message);
  }
}

export const toErrorBody = (e: unknown) =>
  e instanceof NodiError
    ? { code: e.code, message: e.message, details: e.details, request_id: e.requestId }
    : { code: "internal_error", message: "The backend could not complete this request." };
