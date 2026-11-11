import type { NextRequest } from "next/server";
import { getNeonAuth } from "@/lib/neon-auth";

type Handler = ReturnType<ReturnType<typeof getNeonAuth>["middleware"]>;
let handler: Handler | undefined;

/**
 * Redirects signed-out visitors to /login and keeps the SDK's signed session
 * cache cookie fresh (it can only be refreshed here and in server actions, not
 * while rendering a page). Pages and actions still check the user themselves
 * (`requireUser`): a proxy is a convenience, not the security boundary, and
 * Server Actions are POSTs to the page URL that must be checked individually.
 *
 * The SDK answers from its signed cookie while it is fresh (60 s) and asks
 * Neon Auth when it isn't.
 * https://neon.com/docs/auth/reference/nextjs-server.md
 */
export function proxy(request: NextRequest) {
  handler ??= getNeonAuth().middleware({ loginUrl: "/login" });
  return handler(request);
}

export const config = {
  matcher: ["/dashboard/:path*", "/applications/:path*", "/resumes/:path*", "/settings/:path*"],
};
