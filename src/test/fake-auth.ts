import { randomUUID } from "node:crypto";
import type { AuthApi, AuthError, AuthErrorCode, AuthResult, AuthUser, OtpType } from "@/lib/auth-api";

/**
 * An in-memory stand-in for Neon Auth that mimics the behavior we verified
 * against a real Neon branch (see DEPLOYMENT.md): same error codes, the same
 * non-enumerating answers, OTP attempt limits, session revocation, and the
 * SDK's short-lived signed session cache.
 *
 * It reads and writes cookies through the `jar` it is given, exactly like the
 * real SDK does through next/headers, so tests can inspect what a browser
 * would hold.
 */

export const SESSION_COOKIE = "__Secure-neon-auth.session_token";
export const CACHE_COOKIE = "__Secure-neon-auth.local.session_data";

type FakeUser = {
  id: string;
  email: string;
  name: string;
  password: string;
  verified: boolean;
};

export type SentCode = { to: string; type: OtpType; code: string };

const ok = <T>(data: T): AuthResult<T> => ({ data, error: null });
const fail = (status: number, code: AuthErrorCode): AuthResult<never> => ({
  data: null,
  error: { status, code } satisfies AuthError,
});

const ALLOWED_OTP_ATTEMPTS = 3;

export class FakeAuth implements AuthApi {
  users = new Map<string, FakeUser>(); // by email
  sessions = new Map<string, string>(); // token -> user id
  /** Everything "emailed", oldest first. */
  outbox: SentCode[] = [];
  private codes = new Map<string, { code: string; attempts: number }>();
  private n = 0;

  /** Neon's managed Auth answers 404 for delete-user; flip to simulate it working. */
  supportsDeleteUser = false;
  /** When set, every call answers like an unreachable provider. */
  outage = false;

  constructor(private jar: Map<string, string>) {}

  // ---- test helpers --------------------------------------------------------

  seedUser(opts: { email?: string; name?: string; password?: string; verified?: boolean } = {}) {
    const n = ++this.n;
    const user: FakeUser = {
      id: randomUUID(),
      email: (opts.email ?? `user${n}@example.com`).toLowerCase(),
      name: opts.name ?? `User ${n}`,
      password: opts.password ?? "correct horse battery",
      verified: opts.verified ?? true,
    };
    this.users.set(user.email, user);
    return user;
  }

  /** A signed-in browser (replaces whatever the jar held). Returns the session token. */
  signInAs(user: { id: string }) {
    this.jar.clear();
    return this.startSession(user.id);
  }

  /** A session on another device: valid, but not in this jar. */
  otherDevice(user: { id: string }) {
    const token = randomUUID();
    this.sessions.set(token, user.id);
    return token;
  }

  lastCode(to?: string) {
    const list = to ? this.outbox.filter((m) => m.to === to.toLowerCase()) : this.outbox;
    return list.at(-1)?.code;
  }

  sessionCount(userId: string) {
    return [...this.sessions.values()].filter((id) => id === userId).length;
  }

  // ---- internals -----------------------------------------------------------

  private startSession(userId: string) {
    const token = randomUUID();
    this.sessions.set(token, userId);
    this.jar.set(SESSION_COOKIE, token);
    this.jar.set(CACHE_COOKIE, userId); // the SDK caches what it just learned
    return token;
  }

  private byId(id: string) {
    return [...this.users.values()].find((u) => u.id === id);
  }

  private publicUser(u: FakeUser): AuthUser {
    return { id: u.id, email: u.email, name: u.name, emailVerified: u.verified };
  }

  private currentUser() {
    const token = this.jar.get(SESSION_COOKIE);
    const id = token ? this.sessions.get(token) : undefined;
    return id ? this.byId(id) : undefined;
  }

  private sendCode(to: string, type: OtpType) {
    // Replaces any earlier code for the same address and purpose.
    const code = String(100000 + ++this.n * 7919 % 899999);
    this.codes.set(`${to}:${type}`, { code, attempts: 0 });
    this.outbox.push({ to, type, code });
  }

  private checkCode(email: string, type: OtpType, otp: string): AuthError | null {
    const key = `${email}:${type}`;
    const entry = this.codes.get(key);
    if (!entry) return { status: 400, code: "INVALID_CODE" };
    if (entry.attempts >= ALLOWED_OTP_ATTEMPTS) {
      this.codes.delete(key);
      return { status: 400, code: "INVALID_CODE" };
    }
    if (entry.code !== otp) {
      entry.attempts++;
      return { status: 400, code: "INVALID_CODE" };
    }
    this.codes.delete(key);
    return null;
  }

  private down() {
    return this.outage ? fail(503, "UNAVAILABLE") : null;
  }

  // ---- AuthApi -------------------------------------------------------------

  async getSession({ fresh }: { fresh?: boolean } = {}) {
    if (this.outage) return fail(503, "UNAVAILABLE");
    if (!this.jar.has(SESSION_COOKIE)) return ok(null);

    // Like the SDK: a valid signed cache answers without asking Neon Auth, so
    // a session revoked elsewhere still passes until the cache expires.
    const cachedId = this.jar.get(CACHE_COOKIE);
    if (!fresh && cachedId) {
      const u = this.byId(cachedId);
      if (u) return ok({ user: this.publicUser(u) });
    }
    const u = this.currentUser();
    if (!u) {
      this.jar.delete(CACHE_COOKIE);
      return ok(null);
    }
    this.jar.set(CACHE_COOKIE, u.id);
    return ok({ user: this.publicUser(u) });
  }

  /** Simulates the signed cache cookie's lifetime running out. */
  expireCache() {
    this.jar.delete(CACHE_COOKIE);
  }

  async signUp({ email, password, name }: { email: string; password: string; name: string }) {
    const down = this.down();
    if (down) return down;
    if (password.length < 8) return fail(400, "WEAK_PASSWORD");
    if (password.length > 128) return fail(400, "WEAK_PASSWORD");
    const key = email.toLowerCase();
    const existing = this.users.get(key);
    if (existing) {
      // Answers exactly as for a new address (and emails nothing new).
      return ok({ user: { ...this.publicUser(existing), id: randomUUID(), name, emailVerified: false } });
    }
    const user = this.seedUser({ email: key, name, password, verified: false });
    this.sendCode(key, "email-verification");
    return ok({ user: this.publicUser(user) });
  }

  async signIn({ email, password }: { email: string; password: string }) {
    const down = this.down();
    if (down) return down;
    const u = this.users.get(email.toLowerCase());
    if (!u || u.password !== password) return fail(401, "INVALID_CREDENTIALS");
    if (!u.verified) {
      this.sendCode(u.email, "email-verification");
      return fail(403, "EMAIL_NOT_VERIFIED");
    }
    this.startSession(u.id);
    return ok({ user: this.publicUser(u) });
  }

  async signOut() {
    const down = this.down();
    if (down) return down;
    const token = this.jar.get(SESSION_COOKIE);
    if (token) this.sessions.delete(token);
    this.jar.delete(SESSION_COOKIE);
    this.jar.delete(CACHE_COOKIE);
    return ok(null);
  }

  async sendOtp({ email, type }: { email: string; type: OtpType }) {
    const down = this.down();
    if (down) return down;
    const u = this.users.get(email.toLowerCase());
    // Same {success: true} for an unknown address; nothing is sent.
    if (u && (type === "forget-password" ? u.verified : !u.verified)) this.sendCode(u.email, type);
    return ok(null);
  }

  async verifyEmail({ email, otp }: { email: string; otp: string }) {
    const down = this.down();
    if (down) return down;
    const key = email.toLowerCase();
    const err = this.checkCode(key, "email-verification", otp);
    if (err) return { data: null, error: err };
    const u = this.users.get(key)!;
    u.verified = true;
    this.startSession(u.id); // auto sign-in after verification
    return ok({ user: this.publicUser(u) });
  }

  async resetPassword({ email, otp, password }: { email: string; otp: string; password: string }) {
    const down = this.down();
    if (down) return down;
    // Rejected before the code is consumed, like the real service.
    if (password.length < 8) return fail(400, "WEAK_PASSWORD");
    if (password.length > 128) return fail(400, "WEAK_PASSWORD");
    const key = email.toLowerCase();
    const err = this.checkCode(key, "forget-password", otp);
    if (err) return { data: null, error: err };
    const u = this.users.get(key)!;
    u.password = password;
    // "Revoke sessions on password reset" is switched on in our Neon Auth config.
    for (const [token, id] of this.sessions) if (id === u.id) this.sessions.delete(token);
    return ok(null);
  }

  async changePassword({ currentPassword, newPassword }: { currentPassword: string; newPassword: string }) {
    const down = this.down();
    if (down) return down;
    const u = this.currentUser();
    if (!u) return fail(401, "UNAUTHORIZED");
    if (u.password !== currentPassword) return fail(400, "INVALID_CREDENTIALS");
    if (newPassword.length < 8) return fail(400, "WEAK_PASSWORD");
    u.password = newPassword;
    // revokeOtherSessions: true, then a fresh session for this device.
    for (const [token, id] of this.sessions) if (id === u.id) this.sessions.delete(token);
    this.startSession(u.id);
    return ok(null);
  }

  async revokeAllSessions() {
    const down = this.down();
    if (down) return down;
    const u = this.currentUser();
    if (!u) return fail(401, "UNAUTHORIZED");
    for (const [token, id] of this.sessions) if (id === u.id) this.sessions.delete(token);
    this.jar.delete(SESSION_COOKIE);
    this.jar.delete(CACHE_COOKIE);
    return ok(null);
  }

  async deleteUser({ password }: { password: string }) {
    const down = this.down();
    if (down) return down;
    if (!this.supportsDeleteUser) return fail(404, "REJECTED");
    const u = this.currentUser();
    if (!u || u.password !== password) return fail(400, "INVALID_CREDENTIALS");
    this.users.delete(u.email);
    for (const [token, id] of this.sessions) if (id === u.id) this.sessions.delete(token);
    this.jar.delete(SESSION_COOKIE);
    this.jar.delete(CACHE_COOKIE);
    return ok(null);
  }
}
