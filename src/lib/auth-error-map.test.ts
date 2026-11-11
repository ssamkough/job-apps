import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mapSdkError, type SdkError } from "@/lib/auth-error-map";
import { UNAVAILABLE_MESSAGE, unexpectedAuthError } from "@/lib/auth-errors";

// Inputs are what @neon/auth@0.8.x really returns (read from its source, and
// checked against a Neon branch for the Better Auth messages): Supabase-style
// codes, and Better Auth's own message for responses the SDK has no name for.
type Input = NonNullable<SdkError>;

describe("mapSdkError: every mapping", () => {
  const cases: Array<[string, Input, string, number]> = [
    // named by the SDK
    ["wrong password / unknown email", { code: "invalid_credentials", status: 401, message: "Invalid email or password" }, "INVALID_CREDENTIALS", 401],
    ["wrong current password", { code: "invalid_credentials", status: 401, message: "Invalid password" }, "INVALID_CREDENTIALS", 401],
    ["unverified email", { code: "email_not_confirmed", status: 422, message: "Email not verified" }, "EMAIL_NOT_VERIFIED", 403],
    ["password too short or long", { code: "weak_password", status: 400, message: "Password too short" }, "WEAK_PASSWORD", 400],
    ["user already exists", { code: "user_already_exists", status: 409, message: "x" }, "USER_ALREADY_EXISTS", 409],
    ["email already exists", { code: "email_exists", status: 409, message: "x" }, "USER_ALREADY_EXISTS", 409],
    ["request rate limit", { code: "over_request_rate_limit", status: 429, message: "Too many requests" }, "RATE_LIMITED", 429],
    ["email rate limit", { code: "over_email_send_rate_limit", status: 429, message: "x" }, "RATE_LIMITED", 429],
    ["session not found", { code: "session_not_found", status: 401, message: "x" }, "UNAUTHORIZED", 401],
    ["session expired", { code: "session_expired", status: 401, message: "x" }, "UNAUTHORIZED", 401],
    ["bad jwt", { code: "bad_jwt", status: 401, message: "x" }, "UNAUTHORIZED", 401],
    // unnamed Better Auth responses, told apart by message
    ["wrong one-time code", { code: "validation_failed", status: 400, message: "Invalid OTP" }, "INVALID_CODE", 400],
    ["expired one-time code", { code: "validation_failed", status: 400, message: "OTP expired" }, "INVALID_CODE", 400],
    ["too many code attempts", { code: "feature_not_supported", status: 403, message: "Too many attempts" }, "INVALID_CODE", 400],
    ["untrusted origin", { code: "feature_not_supported", status: 403, message: "Invalid origin" }, "INVALID_ORIGIN", 403],
    // the provider being down
    ["network refused", { code: "NETWORK_REFUSED", status: 502, message: "x" }, "UNAVAILABLE", 503],
    ["network dns", { code: "NETWORK_DNS", status: 502, message: "x" }, "UNAVAILABLE", 503],
    ["network timeout", { code: "NETWORK_TIMEOUT", status: 502, message: "x" }, "UNAVAILABLE", 503],
    ["network tls", { code: "NETWORK_TLS", status: 502, message: "x" }, "UNAVAILABLE", 503],
    ["upstream 500", { code: "unexpected_failure", status: 500, message: "x" }, "UNAVAILABLE", 503],
    ["internal error", { code: "internal_error", status: 500, message: "x" }, "UNAVAILABLE", 503],
    ["not implemented", { code: "not_implemented", status: 501, message: "x" }, "UNAVAILABLE", 503],
    ["unknown error", { code: "unknown_error", status: 500, message: "x" }, "UNAVAILABLE", 503],
    ["any 5xx with an unfamiliar code", { code: "something_new", status: 502, message: "x" }, "UNAVAILABLE", 503],
    ["503 (the SDK files it under feature_not_supported)", { code: "feature_not_supported", status: 403, statusText: "Service Unavailable", message: "x" }, "UNAVAILABLE", 503],
    ["502 by status text", { code: "validation_failed", status: 400, statusText: "Bad Gateway", message: "x" }, "UNAVAILABLE", 503],
    ["gateway timeout by status text", { code: "validation_failed", status: 400, statusText: "Gateway Timeout", message: "x" }, "UNAVAILABLE", 503],
  ];
  it.each(cases)("%s", (_name, input, code, status) => {
    expect(mapSdkError(input)).toEqual({ code, status });
  });

  it("an outage is never mistaken for a user mistake, whatever the message says", () => {
    for (const code of ["NETWORK_DNS", "NETWORK_TIMEOUT", "NETWORK_TLS", "NETWORK_RESET", "internal_error"]) {
      expect(mapSdkError({ code, status: 502, message: "Invalid OTP" }).code).toBe("UNAVAILABLE");
    }
  });

  it("a named code wins over the message text", () => {
    expect(mapSdkError({ code: "invalid_credentials", status: 401, message: "Invalid OTP" }).code).toBe(
      "INVALID_CREDENTIALS",
    );
  });
});

describe("mapSdkError: unknown errors fail safe", () => {
  const SECRET = "internal detail: user@example.com 123456 token=abc";

  it("falls back to REJECTED and keeps the SDK's status", () => {
    expect(mapSdkError({ code: "user_not_found", status: 404, message: "Not Found" })).toEqual({
      code: "REJECTED",
      status: 404,
    });
    expect(mapSdkError({ code: "brand_new_code", status: 418, message: SECRET })).toEqual({
      code: "REJECTED",
      status: 418,
    });
  });

  it("copes with a missing code, status and message", () => {
    expect(mapSdkError({})).toEqual({ code: "REJECTED", status: 400 });
  });

  it("carries none of the provider's text (nothing downstream can log or show it)", () => {
    const mapped = mapSdkError({ code: "brand_new_code", status: 400, message: SECRET });
    expect(JSON.stringify(mapped)).not.toContain("example.com");
    expect(Object.keys(mapped).sort()).toEqual(["code", "status"]);
  });
});

describe("unexpectedAuthError", () => {
  beforeEach(() => void vi.spyOn(console, "error").mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  it("answers an unknown failure with one generic message, logging only code and status", () => {
    const mapped = mapSdkError({ code: "brand_new_code", status: 400, message: "secret 654321 a@b.co" });
    const message = unexpectedAuthError("test", mapped);
    expect(message).toBe("Something went wrong. Please try again.");
    const logged = vi.mocked(console.error).mock.calls.map((c) => String(c[0])).join("\n");
    expect(JSON.parse(logged)).toMatchObject({ message: "neon_auth_error", action: "test", code: "REJECTED", status: 400 });
    expect(logged).not.toMatch(/secret|654321|a@b\.co/);
  });

  it("says 'unavailable' for outages and 'wait' for rate limits", () => {
    expect(unexpectedAuthError("t", { code: "UNAVAILABLE", status: 503 })).toBe(UNAVAILABLE_MESSAGE);
    expect(unexpectedAuthError("t", { code: "RATE_LIMITED", status: 429 })).toMatch(/Too many attempts/);
  });

  it("flags a misconfigured origin in the logs but shows the user nothing technical", () => {
    const message = unexpectedAuthError("login", { code: "INVALID_ORIGIN", status: 403 });
    expect(message).toBe("Something went wrong. Please try again.");
    expect(String(vi.mocked(console.error).mock.calls[0][0])).toContain("INVALID_ORIGIN");
  });
});
