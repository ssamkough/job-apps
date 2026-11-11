import "server-only";
import type { AuthError } from "@/lib/auth-api";

// Lives outside the "use server" action files on purpose: every function
// exported from one of those becomes a publicly callable endpoint.

export const UNAVAILABLE_MESSAGE =
  "Sign-in is temporarily unavailable. Please try again in a few minutes.";
const THROTTLED_MESSAGE = "Too many attempts. Please wait a minute and try again.";
const GENERIC_MESSAGE = "Something went wrong. Please try again.";

const isUnavailable = (e: AuthError) => e.code === "UNAVAILABLE";

/**
 * Message for a failure the caller didn't handle specifically. Logs it
 * (code and status only; never the email, password, code or response body) so
 * a misconfiguration such as INVALID_ORIGIN (the app's URL isn't a trusted
 * origin in Neon Auth) is visible in the deployment logs.
 */
export function unexpectedAuthError(action: string, error: AuthError): string {
  console.error(
    JSON.stringify({
      level: "error",
      time: new Date().toISOString(),
      message: "neon_auth_error",
      action,
      status: error.status,
      code: error.code,
    }),
  );
  if (error.code === "RATE_LIMITED") return THROTTLED_MESSAGE;
  if (isUnavailable(error)) return UNAVAILABLE_MESSAGE;
  return GENERIC_MESSAGE;
}
