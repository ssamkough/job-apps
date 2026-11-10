import type { Mail } from "@/lib/email";

const wrap = (heading: string, body: string, buttonLabel: string, url: string, footer: string) => `<!doctype html>
<html><body style="margin:0;background:#f7f7f8;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#18181b">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="480" cellspacing="0" cellpadding="0" style="max-width:480px;background:#ffffff;border:1px solid #e4e4e7;border-radius:12px">
<tr><td style="padding:32px">
<h1 style="margin:0 0 12px;font-size:20px">${heading}</h1>
<p style="margin:0 0 24px;font-size:15px;line-height:22px;color:#52525b">${body}</p>
<a href="${url}" style="display:inline-block;background:#4f46e5;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:10px 18px;border-radius:8px">${buttonLabel}</a>
<p style="margin:24px 0 0;font-size:13px;line-height:20px;color:#71717a">Or paste this link into your browser:<br><span style="word-break:break-all">${url}</span></p>
<p style="margin:16px 0 0;font-size:13px;line-height:20px;color:#71717a">${footer}</p>
</td></tr></table></td></tr></table></body></html>`;

export function passwordResetEmail(to: string, url: string): Mail {
  return {
    to,
    subject: "Reset your Job Tracker password",
    text: `We got a request to reset your Job Tracker password.\n\nChoose a new password (link valid for 1 hour):\n${url}\n\nIf you didn't ask for this, you can ignore this email. Your password won't change.`,
    html: wrap(
      "Reset your password",
      "We got a request to reset your Job Tracker password. This link is valid for 1 hour.",
      "Choose a new password",
      url,
      "If you didn&rsquo;t ask for this, you can ignore this email. Your password won&rsquo;t change.",
    ),
  };
}

export function verifyEmailEmail(to: string, url: string): Mail {
  return {
    to,
    subject: "Confirm your email for Job Tracker",
    text: `Welcome to Job Tracker!\n\nConfirm your email address (link valid for 24 hours):\n${url}\n\nIf you didn't create an account, you can ignore this email.`,
    html: wrap(
      "Confirm your email",
      "Welcome to Job Tracker! Confirm your email address so you can recover your account and use AI cover letter drafts. This link is valid for 24 hours.",
      "Confirm email",
      url,
      "If you didn&rsquo;t create an account, you can ignore this email.",
    ),
  };
}
