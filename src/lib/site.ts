export const SITE_NAME = "Job Application Helper";

/** Where users reach a human. Set SUPPORT_EMAIL in production. */
export function supportEmail() {
  return process.env.SUPPORT_EMAIL || "support@example.com";
}
