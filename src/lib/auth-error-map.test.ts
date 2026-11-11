import { describe, expect, it } from "vitest";
import { mapSdkError } from "@/lib/auth-error-map";

// Inputs are what @neon/auth@0.8.x really returns (read from its source and
// checked against a Neon branch): Supabase-style codes, and Better Auth's
// message for responses it has no name for.
describe("mapSdkError", () => {
  const cases: Array<[string, Parameters<typeof mapSdkError>[0], string]> = [
    ["wrong password", { code: "invalid_credentials", status: 401, message: "Invalid email or password" }, "INVALID_CREDENTIALS"],
    ["unverified email", { code: "email_not_confirmed", status: 422, message: "Email not verified" }, "EMAIL_NOT_VERIFIED"],
    ["short password", { code: "weak_password", status: 400, message: "Password too short" }, "WEAK_PASSWORD"],
    ["wrong code", { code: "validation_failed", status: 400, message: "Invalid OTP" }, "INVALID_CODE"],
    ["too many code attempts", { code: "feature_not_supported", status: 403, message: "Too many attempts" }, "INVALID_CODE"],
    ["expired code", { code: "validation_failed", status: 400, message: "OTP expired" }, "INVALID_CODE"],
    ["untrusted origin", { code: "feature_not_supported", status: 403, message: "Invalid origin" }, "INVALID_ORIGIN"],
    ["rate limited", { code: "over_request_rate_limit", status: 429, message: "Too many requests" }, "RATE_LIMITED"],
    ["email rate limited", { code: "over_email_send_rate_limit", status: 429, message: "x" }, "RATE_LIMITED"],
    ["no session", { code: "session_not_found", status: 401, message: "x" }, "UNAUTHORIZED"],
    ["network failure", { code: "NETWORK_REFUSED", status: 502, message: "x" }, "UNAVAILABLE"],
    ["upstream 500", { code: "unexpected_failure", status: 500, message: "x" }, "UNAVAILABLE"],
    ["upstream 503 (arrives as feature_not_supported)", { code: "feature_not_supported", status: 403, statusText: "Service Unavailable", message: "x" }, "UNAVAILABLE"],
    ["already registered", { code: "user_already_exists", status: 409, message: "x" }, "USER_ALREADY_EXISTS"],
    ["unknown 404 (delete-user)", { code: "user_not_found", status: 404, message: "Not Found" }, "REJECTED"],
  ];
  it.each(cases)("%s", (_name, input, expected) => {
    expect(mapSdkError(input).code).toBe(expected);
  });

  it("never reports an outage as a user mistake", () => {
    for (const code of ["NETWORK_DNS", "NETWORK_TIMEOUT", "NETWORK_TLS", "internal_error"]) {
      expect(mapSdkError({ code, status: 502, message: "Invalid OTP" }).code).toBe("UNAVAILABLE");
    }
  });
});
