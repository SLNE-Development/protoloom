export type ErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "immutable"
  | "has_dependents"
  | "payload_too_large"
  | "validation_failed";

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  invalid_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  immutable: 409,
  has_dependents: 409,
  payload_too_large: 413,
  validation_failed: 422,
};

/** Domain error carrying a stable machine-readable code and its HTTP status. */
export class RegistryError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "RegistryError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = details;
  }
}
