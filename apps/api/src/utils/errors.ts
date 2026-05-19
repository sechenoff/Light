export class HttpError extends Error {
  status: number;
  details?: unknown;
  /**
   * Machine-readable error code (e.g. "ADDON_CONFLICT").
   *
   * Backward-compatible: existing callers `new HttpError(status, message, "CODE")`
   * pass the code as the 3rd arg, which is kept in `details` (a string) AND now
   * also exposed as `.code` on the thrown instance. The centralized error handler
   * in app.ts already surfaces a string `details` as `res.body.code`, so the HTTP
   * response shape is unchanged. New callers can additionally pass structured
   * details as the 4th arg: `new HttpError(status, message, "CODE", { ... })` —
   * then `code` holds the string and `details` holds the object.
   */
  code?: string;

  constructor(
    status: number,
    message: string,
    details?: unknown,
    structuredDetails?: unknown,
  ) {
    super(message);
    this.status = status;

    if (structuredDetails !== undefined) {
      // 4-arg form: 3rd arg is the code string, 4th is structured payload.
      this.details = structuredDetails;
      if (typeof details === "string") this.code = details;
    } else {
      // Legacy form: 3rd arg is opaque details. If it's a string, treat it as
      // the code as well (additive; HTTP response unchanged).
      this.details = details;
      if (typeof details === "string") this.code = details;
    }
  }
}
