import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Optimistic check only: it looks for the cookie, not whether the session is
// valid. Real verification happens in requireUser() next to the data.
export function proxy(request: NextRequest) {
  const hasSession = request.cookies.has("session");
  if (!hasSession) {
    const url = new URL("/login", request.url);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*", "/applications/:path*", "/resumes/:path*", "/settings/:path*"],
};
