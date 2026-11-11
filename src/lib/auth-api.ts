import "server-only";
import { hasAuthCookie } from "@/lib/auth-cookies";
import { mapSdkError, type AuthError, type AuthErrorCode, type SdkError } from "@/lib/auth-error-map";

export type { AuthError, AuthErrorCode };
import { getNeonAuth } from "@/lib/neon-auth";

/**
 * The only door from this app to Neon Auth. Server actions and `auth.ts` call
 * these methods instead of the SDK, which keeps the SDK's wide, loosely typed
 * surface out of the rest of the code and gives tests one module to fake
 * (`vi.mock("@/lib/auth-api")`, see src/test/fake-auth.ts).
 *
 * Every method resolves to `{ data, error }` and never throws for an expected
 * failure (wrong password, bad code, rate limit, provider outage).
 */

export type AuthResult<T> =
  | { data: T; error: null }
  | { data: null; error: AuthError };

export type AuthUser = {
  id: string;
  email: string;
  /** Empty when the user didn't give one. */
  name: string;
  emailVerified: boolean;
};

export type OtpType = "email-verification" | "forget-password";

export interface AuthApi {
  /**
   * Current user, or null. `fresh` skips the signed session cache and asks
   * Neon Auth, so a session revoked elsewhere is noticed immediately.
   */
  getSession(opts?: { fresh?: boolean }): Promise<AuthResult<{ user: AuthUser } | null>>;
  /** With email verification required, no session is created yet. */
  signUp(input: { email: string; password: string; name: string }): Promise<AuthResult<{ user: AuthUser }>>;
  signIn(input: { email: string; password: string }): Promise<AuthResult<{ user: AuthUser }>>;
  signOut(): Promise<AuthResult<null>>;
  /** Emails a 6-digit code. Answers the same whether or not the address is registered. */
  sendOtp(input: { email: string; type: OtpType }): Promise<AuthResult<null>>;
  /** Verifies the address and, because auto sign-in is on, starts a session. */
  verifyEmail(input: { email: string; otp: string }): Promise<AuthResult<{ user: AuthUser }>>;
  resetPassword(input: { email: string; otp: string; password: string }): Promise<AuthResult<null>>;
  /** Always revokes the user's other sessions. */
  changePassword(input: { currentPassword: string; newPassword: string }): Promise<AuthResult<null>>;
  /** Ends every session, including this one. */
  revokeAllSessions(): Promise<AuthResult<null>>;
  /** Unsupported on managed Neon Auth (404); kept so it starts working if Neon enables it. */
  deleteUser(input: { password: string }): Promise<AuthResult<null>>;
}

// ---- real implementation -------------------------------------------------

type SdkResult = { data?: unknown; error?: SdkError } | null | undefined;

/** Wraps one SDK call. `pick` turns the response body into our result type. */
async function call<T>(run: () => Promise<unknown>, pick: (data: unknown) => T): Promise<AuthResult<T>> {
  let res: SdkResult;
  try {
    res = (await run()) as SdkResult;
  } catch (e) {
    // The SDK throws for failures it can't classify (not for network errors,
    // which it returns). Treat them as the provider being unavailable.
    void e; // the message could contain anything; only the fact matters
    return { data: null, error: { code: "UNAVAILABLE", status: 503 } };
  }
  if (res?.error) return { data: null, error: mapSdkError(res.error) };
  return { data: pick(res?.data), error: null };
}

function normalize(raw: unknown): AuthUser {
  const u = raw as { id: string; email: string; name?: string | null; emailVerified?: boolean };
  return { id: u.id, email: u.email, name: u.name ?? "", emailVerified: u.emailVerified === true };
}

// The SDK's types don't describe its email-OTP plugin methods (they are
// exposed at runtime, per its docs), so we type the three we use ourselves.
type EmailOtpApi = {
  sendVerificationOtp(input: { email: string; type: OtpType }): Promise<unknown>;
  verifyEmail(input: { email: string; otp: string }): Promise<unknown>;
  resetPassword(input: { email: string; otp: string; password: string }): Promise<unknown>;
};
const emailOtp = () => getNeonAuth().emailOtp as unknown as EmailOtpApi;

const noData = () => null;
const withUser = (data: unknown) => ({ user: normalize((data as { user: unknown }).user) });

const real: AuthApi = {
  async getSession({ fresh } = {}) {
    // The SDK would call Neon Auth even with no cookie at all; skip that for
    // anonymous visitors (it costs a round trip and counts against Neon's
    // per-IP rate limit, which every visitor of this deployment shares).
    if (!(await hasAuthCookie())) return { data: null, error: null };
    const auth = getNeonAuth();
    return call(
      () => auth.getSession(fresh ? { query: { disableCookieCache: "true" } } : undefined),
      (data) => {
        const d = data as { user?: unknown; session?: unknown } | null;
        return d?.user && d.session ? { user: normalize(d.user) } : null;
      },
    );
  },
  signUp: (input) => call(() => getNeonAuth().signUp.email(input), withUser),
  signIn: (input) => call(() => getNeonAuth().signIn.email(input), withUser),
  signOut: () => call(() => getNeonAuth().signOut(), noData),
  sendOtp: ({ email, type }) =>
    call(() => emailOtp().sendVerificationOtp({ email, type }), noData),
  verifyEmail: (input) => call(() => emailOtp().verifyEmail(input), withUser),
  resetPassword: (input) => call(() => emailOtp().resetPassword(input), noData),
  changePassword: ({ currentPassword, newPassword }) =>
    call(
      () => getNeonAuth().changePassword({ currentPassword, newPassword, revokeOtherSessions: true }),
      noData,
    ),
  revokeAllSessions: () => call(() => getNeonAuth().revokeSessions(), noData),
  deleteUser: ({ password }) => call(() => getNeonAuth().deleteUser({ password }), noData),
};

/** The auth backend. Tests mock this module's export to inject a fake. */
export function authApi(): AuthApi {
  return real;
}
