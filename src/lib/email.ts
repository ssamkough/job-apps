import "server-only";
import nodemailer, { type Transporter } from "nodemailer";
import { hit, peek, type Rule } from "@/lib/rate-limit";

export class EmailQuotaError extends Error {
  constructor() {
    super("Daily email limit reached");
  }
}
export class EmailNotConfiguredError extends Error {
  constructor() {
    super("Email isn't configured: set SMTP_HOST, SMTP_USER, SMTP_PASS and EMAIL_FROM");
  }
}

export type Mail = { to: string; subject: string; text: string; html: string };

/**
 * Free email plans cap sends per day (e.g. Resend 100/day, Brevo 300/day).
 * Set EMAIL_DAILY_LIMIT a little under your provider's cap so we stop sending
 * on our side instead of having the provider reject or silently queue mail.
 * Counts reset at UTC midnight.
 */
export const emailQuotaRule = (): Rule => {
  const n = Number(process.env.EMAIL_DAILY_LIMIT);
  return { limit: Number.isFinite(n) && n > 0 ? n : 90, windowSec: 24 * 60 * 60 };
};
const QUOTA_KEY = "email:daily";

/** Whether we can still send today, without using up a send. */
export async function emailQuotaAvailable() {
  if (!process.env.SMTP_HOST) return true; // dev: emails are logged, not sent
  return (await peek(QUOTA_KEY, emailQuotaRule())).allowed;
}

// Emails "sent" while SMTP isn't configured (dev/test) land here and in the log.
const g = globalThis as unknown as { __devOutbox?: Mail[] };
export const devOutbox = () => (g.__devOutbox ??= []);

let transport: Transporter | undefined;
function getTransport() {
  if (!transport) {
    const port = Number(process.env.SMTP_PORT) || 587;
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      // 465 is implicit TLS; 587/2525 upgrade via STARTTLS automatically.
      secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === "true" : port === 465,
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    });
  }
  return transport;
}

/** Test hook. */
export function resetEmailTransport() {
  transport = undefined;
}

export async function sendEmail(mail: Mail) {
  if (!process.env.SMTP_HOST) {
    if (process.env.NODE_ENV === "production") throw new EmailNotConfiguredError();
    devOutbox().push(mail);
    console.log(`\n--- email (dev, not sent) ---\nTo: ${mail.to}\nSubject: ${mail.subject}\n\n${mail.text}\n-----------------------------\n`);
    return;
  }

  const from = process.env.EMAIL_FROM;
  if (!from) throw new EmailNotConfiguredError();

  const quota = await hit(QUOTA_KEY, emailQuotaRule());
  if (!quota.allowed) throw new EmailQuotaError();

  await getTransport().sendMail({ from, ...mail });
}
