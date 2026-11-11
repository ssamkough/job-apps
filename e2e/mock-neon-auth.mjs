// A small stand-in for Neon Auth (managed Better Auth) so the e2e suite runs
// offline, for free, and without sharing one real project's rate limits.
// It implements only the endpoints the app uses and mirrors behavior verified
// against a real Neon branch (see DEPLOYMENT.md): error codes, non-enumerating
// answers, OTP attempt limits, "revoke sessions on password reset", the
// trusted-origin check (INVALID_ORIGIN) and 404 for delete-user.
//
// The real thing is exercised by e2e/live-auth.spec.ts (opt-in).
//
// Test hooks (not part of Better Auth):
//   GET  /__otp?email=…&type=email-verification|forget-password  -> { code }
//   POST /__reset                                                -> forget all state
//   POST /__outage?on=1|0                                        -> answer 503 to everything
import { randomBytes, randomUUID } from "node:crypto";
import http from "node:http";

const BASE = "/neondb/auth";
const ALLOWED_ORIGINS = new Set(["http://localhost:3100"]);
const SESSION_COOKIE = "__Secure-neon-auth.session_token";
const ALLOWED_OTP_ATTEMPTS = 3;

const users = new Map(); // email -> user
const sessions = new Map(); // token -> { userId, createdAt }
const codes = new Map(); // `${email}:${type}` -> { code, attempts }
let outage = false;

const now = () => new Date().toISOString();
const sixDigits = () => String(100000 + (randomBytes(4).readUInt32BE() % 900000));

const publicUser = (u) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  emailVerified: u.verified,
  image: null,
  createdAt: u.createdAt,
  updatedAt: u.createdAt,
});

function cookieOf(req, name) {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}
const sessionOf = (req) => {
  const token = cookieOf(req, SESSION_COOKIE);
  const s = token && sessions.get(token);
  return s ? { token, ...s, user: [...users.values()].find((u) => u.id === s.userId) } : null;
};

function startSession(res, user) {
  const token = randomBytes(24).toString("base64url");
  sessions.set(token, { userId: user.id, createdAt: now() });
  res.appendHeader(
    "set-cookie",
    `${SESSION_COOKIE}=${token}; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=None`,
  );
  return token;
}
const endSessionCookie = (res) =>
  res.appendHeader("set-cookie", `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=None`);

function sendCode(email, type) {
  const code = sixDigits();
  codes.set(`${email}:${type}`, { code, attempts: 0 });
}
function checkCode(email, type, otp) {
  const key = `${email}:${type}`;
  const entry = codes.get(key);
  if (!entry) return "INVALID_OTP";
  if (entry.attempts >= ALLOWED_OTP_ATTEMPTS) {
    codes.delete(key);
    return "TOO_MANY_ATTEMPTS";
  }
  if (entry.code !== otp) {
    entry.attempts++;
    return "INVALID_OTP";
  }
  codes.delete(key);
  return null;
}
const revokeAll = (userId) => {
  for (const [t, s] of sessions) if (s.userId === userId) sessions.delete(t);
};

const json = (res, status, body) => {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
};
// Messages as the real service sends them (verified against a Neon branch).
const MESSAGES = { INVALID_OTP: "Invalid OTP", TOO_MANY_ATTEMPTS: "Too many attempts", INVALID_ORIGIN: "Invalid origin" };
const fail = (res, status, code) => json(res, status, { code, message: MESSAGES[code] ?? code });

async function readBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

const routes = {
  "GET /get-session"(req, res) {
    const s = sessionOf(req);
    if (!s) return json(res, 200, null);
    json(res, 200, {
      session: {
        id: s.token.slice(0, 8),
        token: s.token,
        userId: s.userId,
        expiresAt: new Date(Date.now() + 7 * 864e5).toISOString(),
        createdAt: s.createdAt,
        updatedAt: s.createdAt,
      },
      user: publicUser(s.user),
    });
  },

  async "POST /sign-up/email"(req, res, body) {
    const email = String(body.email ?? "").toLowerCase();
    const password = String(body.password ?? "");
    if (password.length < 8) return fail(res, 400, "PASSWORD_TOO_SHORT");
    if (password.length > 128) return fail(res, 400, "PASSWORD_TOO_LONG");
    const existing = users.get(email);
    // An existing address gets the same answer as a new one.
    if (existing) {
      return json(res, 200, { token: null, user: publicUser({ ...existing, id: randomUUID(), verified: false }) });
    }
    const user = { id: randomUUID(), email, name: String(body.name ?? ""), password, verified: false, createdAt: now() };
    users.set(email, user);
    sendCode(email, "email-verification");
    json(res, 200, { token: null, user: publicUser(user) });
  },

  async "POST /sign-in/email"(req, res, body) {
    const user = users.get(String(body.email ?? "").toLowerCase());
    if (!user || user.password !== body.password) return fail(res, 401, "INVALID_EMAIL_OR_PASSWORD");
    if (!user.verified) {
      sendCode(user.email, "email-verification");
      return fail(res, 403, "EMAIL_NOT_VERIFIED");
    }
    const token = startSession(res, user);
    json(res, 200, { redirect: false, token, user: publicUser(user) });
  },

  "POST /sign-out"(req, res) {
    const s = sessionOf(req);
    if (s) sessions.delete(s.token);
    endSessionCookie(res);
    json(res, 200, { success: true });
  },

  async "POST /email-otp/send-verification-otp"(req, res, body) {
    const email = String(body.email ?? "").toLowerCase();
    const type = body.type;
    const user = users.get(email);
    // Answers { success: true } whether or not the address exists.
    if (user && (type === "forget-password" ? user.verified : !user.verified)) sendCode(email, type);
    json(res, 200, { success: true });
  },

  async "POST /email-otp/verify-email"(req, res, body) {
    const email = String(body.email ?? "").toLowerCase();
    const err = checkCode(email, "email-verification", String(body.otp ?? ""));
    if (err) return fail(res, err === "INVALID_OTP" ? 400 : 403, err);
    const user = users.get(email);
    user.verified = true;
    const token = startSession(res, user); // auto sign-in after verification
    json(res, 200, { status: true, token, user: publicUser(user) });
  },

  async "POST /email-otp/reset-password"(req, res, body) {
    const email = String(body.email ?? "").toLowerCase();
    const password = String(body.password ?? "");
    // Checked before the code is consumed.
    if (password.length < 8) return fail(res, 400, "PASSWORD_TOO_SHORT");
    if (password.length > 128) return fail(res, 400, "PASSWORD_TOO_LONG");
    const err = checkCode(email, "forget-password", String(body.otp ?? ""));
    if (err) return fail(res, err === "INVALID_OTP" ? 400 : 403, err);
    const user = users.get(email);
    user.password = password;
    revokeAll(user.id); // revoke_sessions_on_password_reset is on
    json(res, 200, { success: true });
  },

  async "POST /change-password"(req, res, body) {
    const s = sessionOf(req);
    if (!s) return fail(res, 401, "UNAUTHORIZED");
    if (s.user.password !== body.currentPassword) return fail(res, 400, "INVALID_PASSWORD");
    if (String(body.newPassword ?? "").length < 8) return fail(res, 400, "PASSWORD_TOO_SHORT");
    s.user.password = body.newPassword;
    if (body.revokeOtherSessions) {
      revokeAll(s.userId);
      startSession(res, s.user);
    }
    json(res, 200, { token: null, user: publicUser(s.user) });
  },

  "POST /revoke-sessions"(req, res) {
    const s = sessionOf(req);
    if (!s) return fail(res, 401, "UNAUTHORIZED");
    revokeAll(s.userId);
    endSessionCookie(res);
    json(res, 200, { status: true });
  },

  // Managed Neon Auth doesn't expose it.
  "POST /delete-user": (req, res) => {
    res.statusCode = 404;
    res.end("Not found");
  },
};

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");

    // ---- test hooks
    if (url.pathname === "/__otp") {
      const entry = codes.get(`${url.searchParams.get("email")}:${url.searchParams.get("type")}`);
      return json(res, entry ? 200 : 404, { code: entry?.code ?? null });
    }
    if (url.pathname === "/__reset") {
      users.clear();
      sessions.clear();
      codes.clear();
      outage = false;
      return json(res, 200, {});
    }
    if (url.pathname === "/__outage") {
      outage = url.searchParams.get("on") === "1";
      return json(res, 200, { outage });
    }

    if (!url.pathname.startsWith(BASE + "/")) return fail(res, 404, "NOT_FOUND");
    if (outage) return fail(res, 503, "SERVICE_UNAVAILABLE");

    // Neon Auth refuses state-changing requests from origins that aren't trusted.
    if (req.method === "POST") {
      const origin = req.headers.origin;
      if (origin && !ALLOWED_ORIGINS.has(origin)) return fail(res, 403, "INVALID_ORIGIN");
    }

    const handler = routes[`${req.method} ${url.pathname.slice(BASE.length)}`];
    if (!handler) {
      res.statusCode = 404;
      return res.end("Not found");
    }
    const body = req.method === "POST" ? await readBody(req) : {};
    await handler(req, res, body);
  })
  .listen(11502, "127.0.0.1");
