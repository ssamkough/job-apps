import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The real adapter, with the Neon Auth SDK replaced by spies, so we can pin
// down exactly what we send to it and how its answers are translated.
const h = vi.hoisted(() => ({
  hasCookie: true,
  /** The raw `name=value` of the session cookie as the browser sent it. */
  tokenCookie: "__Secure-neon-auth.session_token=tok.sig%2Fabc" as string | null,
  sdk: {} as Record<string, unknown>,
}));

vi.mock("@/lib/auth-cookies", () => ({
  hasAuthCookie: async () => h.hasCookie,
  sessionTokenCookieHeader: async () => h.tokenCookie,
}));
vi.mock("@/lib/neon-auth", () => ({
  getNeonAuth: () => h.sdk,
  neonAuthBaseUrl: () => "https://auth.example.test/neondb/auth",
}));

import { authApi } from "@/lib/auth-api";

const user = { id: "u1", email: "a@example.com", name: null, emailVerified: true };
const session = { id: "s1", token: "t" };

beforeEach(() => {
  h.hasCookie = true;
  h.tokenCookie = "__Secure-neon-auth.session_token=tok.sig%2Fabc";
  h.sdk = {
    getSession: vi.fn().mockResolvedValue({ data: { user, session }, error: null }),
    signIn: { email: vi.fn().mockResolvedValue({ data: { user }, error: null }) },
    signUp: { email: vi.fn().mockResolvedValue({ data: { user }, error: null }) },
    signOut: vi.fn().mockResolvedValue({ data: { success: true }, error: null }),
    changePassword: vi.fn().mockResolvedValue({ data: {}, error: null }),
    revokeSessions: vi.fn().mockResolvedValue({ data: {}, error: null }),
    deleteUser: vi.fn().mockResolvedValue({ data: {}, error: null }),
    emailOtp: {
      sendVerificationOtp: vi.fn().mockResolvedValue({ data: { success: true }, error: null }),
      verifyEmail: vi.fn().mockResolvedValue({ data: { user }, error: null }),
      resetPassword: vi.fn().mockResolvedValue({ data: { success: true }, error: null }),
    },
  };
});

describe("password change", () => {
  it("always signs out the user's other sessions", async () => {
    const res = await authApi().changePassword({ currentPassword: "old-old-old", newPassword: "new-new-new" });
    expect(res.error).toBeNull();
    expect(h.sdk.changePassword).toHaveBeenCalledWith({
      currentPassword: "old-old-old",
      newPassword: "new-new-new",
      revokeOtherSessions: true,
    });
  });
});

describe("getSession", () => {
  it("doesn't call Neon Auth for a visitor without auth cookies", async () => {
    h.hasCookie = false;
    expect(await authApi().getSession()).toEqual({ data: null, error: null });
    expect(h.sdk.getSession).not.toHaveBeenCalled();
  });

  it("uses the SDK's cache normally and bypasses it when fresh is asked for", async () => {
    await authApi().getSession();
    expect(h.sdk.getSession).toHaveBeenLastCalledWith(undefined);
    await authApi().getSession({ fresh: true });
    expect(h.sdk.getSession).toHaveBeenLastCalledWith({ query: { disableCookieCache: "true" } });
  });

  it("turns the SDK's user into ours (no name becomes empty, verified is strict)", async () => {
    const res = await authApi().getSession();
    expect(res.data).toEqual({ user: { id: "u1", email: "a@example.com", name: "", emailVerified: true } });
    h.sdk.getSession = vi.fn().mockResolvedValue({
      data: { user: { ...user, emailVerified: undefined }, session },
      error: null,
    });
    expect((await authApi().getSession()).data?.user.emailVerified).toBe(false);
  });

  it("no session in the answer means signed out", async () => {
    h.sdk.getSession = vi.fn().mockResolvedValue({ data: null, error: null });
    expect(await authApi().getSession()).toEqual({ data: null, error: null });
    h.sdk.getSession = vi.fn().mockResolvedValue({ data: { user, session: null }, error: null });
    expect(await authApi().getSession()).toEqual({ data: null, error: null });
  });
});

// Real Neon Auth answers get-session for a revoked token with `null` plus
// Set-Cookie headers that delete the cookies; the SDK applies them with
// cookies().set(), which Next refuses while rendering, so the SDK throws.
describe("getSession while rendering (the SDK can't set cookies)", () => {
  const cookieError = () =>
    new Error("Cookies can only be modified in a Server Action or Route Handler. Read more: https://nextjs.org/docs");
  const answer = (body: unknown, status = 200) =>
    vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    h.sdk.getSession = vi.fn().mockRejectedValue(cookieError());
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => fetchSpy.mockRestore());

  it("a revoked session reads as signed out, not as an outage", async () => {
    fetchSpy.mockImplementation(answer(null));
    expect(await authApi().getSession()).toEqual({ data: null, error: null });
  });

  it("asks Neon Auth with only the browser's session cookie, untouched", async () => {
    fetchSpy.mockImplementation(answer(null));
    await authApi().getSession();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://auth.example.test/neondb/auth/get-session");
    expect(init.headers).toEqual({ cookie: "__Secure-neon-auth.session_token=tok.sig%2Fabc" });
  });

  it("a still-valid session is returned as the user", async () => {
    fetchSpy.mockImplementation(answer({ user, session }));
    expect((await authApi().getSession()).data).toEqual({
      user: { id: "u1", email: "a@example.com", name: "", emailVerified: true },
    });
  });

  it("a provider outage is still reported as one", async () => {
    fetchSpy.mockImplementation(answer({ message: "down" }, 503));
    expect((await authApi().getSession()).error).toEqual({ code: "UNAVAILABLE", status: 503 });
    fetchSpy.mockRejectedValue(new TypeError("fetch failed"));
    expect((await authApi().getSession()).error).toEqual({ code: "UNAVAILABLE", status: 503 });
  });

  it("no session cookie in the request means signed out without a call", async () => {
    h.tokenCookie = null;
    expect(await authApi().getSession()).toEqual({ data: null, error: null });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("other SDK failures are not mistaken for it", async () => {
    h.sdk.getSession = vi.fn().mockRejectedValue(new Error("boom"));
    expect((await authApi().getSession()).error?.code).toBe("UNAVAILABLE");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("what we send", () => {
  it("sign-in, sign-up and the code calls pass exactly the fields we mean to", async () => {
    await authApi().signIn({ email: "a@example.com", password: "pw-pw-pw-pw" });
    expect((h.sdk.signIn as { email: unknown }).email).toHaveBeenCalledWith({
      email: "a@example.com",
      password: "pw-pw-pw-pw",
    });
    await authApi().sendOtp({ email: "a@example.com", type: "forget-password" });
    const otp = h.sdk.emailOtp as Record<string, ReturnType<typeof vi.fn>>;
    expect(otp.sendVerificationOtp).toHaveBeenCalledWith({ email: "a@example.com", type: "forget-password" });
    await authApi().verifyEmail({ email: "a@example.com", otp: "123456" });
    expect(otp.verifyEmail).toHaveBeenCalledWith({ email: "a@example.com", otp: "123456" });
    await authApi().resetPassword({ email: "a@example.com", otp: "123456", password: "new-new-new" });
    expect(otp.resetPassword).toHaveBeenCalledWith({ email: "a@example.com", otp: "123456", password: "new-new-new" });
  });
});

describe("errors", () => {
  it("translates SDK errors into our codes, without keeping the provider's text", async () => {
    (h.sdk.signIn as { email: ReturnType<typeof vi.fn> }).email.mockResolvedValue({
      data: null,
      error: { code: "invalid_credentials", status: 401, message: "SECRET provider text a@example.com" },
    });
    const res = await authApi().signIn({ email: "a@example.com", password: "x" });
    expect(res).toEqual({ data: null, error: { code: "INVALID_CREDENTIALS", status: 401 } });
    expect(JSON.stringify(res)).not.toContain("SECRET");
  });

  it("a wrong one-time code (which the SDK reports without a name) is INVALID_CODE", async () => {
    (h.sdk.emailOtp as { verifyEmail: ReturnType<typeof vi.fn> }).verifyEmail.mockResolvedValue({
      data: null,
      error: { code: "validation_failed", status: 400, message: "Invalid OTP" },
    });
    expect((await authApi().verifyEmail({ email: "a@example.com", otp: "000000" })).error).toEqual({
      code: "INVALID_CODE",
      status: 400,
    });
  });

  it("an exception from the SDK becomes UNAVAILABLE and its message is dropped", async () => {
    (h.sdk.signOut as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom: cookie=abc123"));
    const res = await authApi().signOut();
    expect(res).toEqual({ data: null, error: { code: "UNAVAILABLE", status: 503 } });
    expect(JSON.stringify(res)).not.toContain("abc123");
  });

  it("a network failure the SDK reports (502) is UNAVAILABLE", async () => {
    h.sdk.getSession = vi.fn().mockResolvedValue({
      data: null,
      error: { code: "NETWORK_REFUSED", status: 502, message: "connect ECONNREFUSED" },
    });
    expect((await authApi().getSession()).error).toEqual({ code: "UNAVAILABLE", status: 503 });
  });
});
