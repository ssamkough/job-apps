/**
 * Our own, stable error codes. The SDK reports Supabase-style codes
 * ("invalid_credentials", "email_not_confirmed", ...) and drops Better Auth's
 * original ones (INVALID_OTP, INVALID_ORIGIN, ...), so `mapSdkError` below
 * translates what it gets into these.
 */
export type AuthErrorCode =
  | "INVALID_CREDENTIALS" // wrong email/password, or wrong current password
  | "EMAIL_NOT_VERIFIED"
  | "WEAK_PASSWORD"
  | "INVALID_CODE" // wrong, expired or used-up one-time code
  | "USER_ALREADY_EXISTS"
  | "RATE_LIMITED" // Neon Auth's own throttle
  | "UNAUTHORIZED" // no valid session
  | "INVALID_ORIGIN" // this app's URL isn't a trusted origin in Neon Auth
  | "UNAVAILABLE" // network failure or a 5xx from Neon Auth
  | "REJECTED"; // anything else Neon Auth refused

export type AuthError = {
  code: AuthErrorCode;
  /** HTTP-style status, ours (not always what Neon Auth sent). 503 means unavailable. */
  status: number;
  // Deliberately no `message`: the provider's text is only used here to
  // classify, then dropped, so nothing downstream can log or show it.
};

export type SdkError = {
  message?: string;
  status?: number;
  statusText?: string;
  code?: string;
} | null | undefined;

/**
 * Translates an SDK error. What the SDK gives us (read from its source):
 *  - `code` is a Supabase-style name, status is that name's own status;
 *  - 400/403 responses it has no name for (INVALID_OTP, TOO_MANY_ATTEMPTS,
 *    INVALID_ORIGIN) arrive as validation_failed / feature_not_supported, with
 *    Better Auth's message kept ("Invalid OTP", "Too many attempts",
 *    "Invalid origin");
 *  - 503 arrives as feature_not_supported; `statusText` still says what it was;
 *  - network failures arrive as status 502 with a NETWORK_* code.
 */
export function mapSdkError(e: NonNullable<SdkError>): AuthError {
  const message = e.message ?? "";
  const make = (code: AuthErrorCode, status: number): AuthError => ({ code, status });
  const sdk = e.code ?? "";

  switch (sdk) {
    case "invalid_credentials":
      return make("INVALID_CREDENTIALS", 401);
    case "email_not_confirmed":
      return make("EMAIL_NOT_VERIFIED", 403);
    case "weak_password":
      return make("WEAK_PASSWORD", 400);
    case "user_already_exists":
    case "email_exists":
      return make("USER_ALREADY_EXISTS", 409);
    case "over_request_rate_limit":
    case "over_email_send_rate_limit":
      return make("RATE_LIMITED", 429);
    case "session_not_found":
    case "session_expired":
    case "bad_jwt":
      return make("UNAUTHORIZED", 401);
  }
  if (
    sdk.startsWith("NETWORK_") ||
    ["unexpected_failure", "internal_error", "not_implemented", "unknown_error"].includes(sdk) ||
    (e.status ?? 0) >= 500 ||
    /unavailable|gateway|timeout|internal server/i.test(e.statusText ?? "")
  ) {
    return make("UNAVAILABLE", 503);
  }
  if (/origin/i.test(message)) return make("INVALID_ORIGIN", 403);
  if (/otp|too many attempts|expired/i.test(message)) return make("INVALID_CODE", 400);
  return make("REJECTED", e.status ?? 400);
}

