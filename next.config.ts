import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";

// Next injects small inline bootstrap scripts, so scripts need 'unsafe-inline'
// (a nonce-based policy would force every page, including the static legal
// pages, to render dynamically). Everything else is locked down: no plugins,
// no framing, no foreign form targets, no third-party origins.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  ...(isDev ? [] : ["upgrade-insecure-requests"]),
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  // Only meaningful over HTTPS; browsers ignore it on http://localhost.
  ...(isDev
    ? []
    : [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }]),
];

// The app's home. Sessions are cookies on one host, so everything is served
// from here; the original *.vercel.app address just forwards to it.
const CANONICAL_ORIGIN = "https://www.jobapphelp.net";
const LEGACY_HOSTS = ["job-apps-pi.vercel.app"];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  experimental: {
    serverActions: {
      // Resume uploads go through server actions (max file size is 4 MB, see
      // MAX_RESUME_MB). Vercel itself rejects request bodies over 4.5 MB.
      bodySizeLimit: "4.5mb",
    },
  },
  async redirects() {
    // Temporary (307) on purpose: browsers cache permanent redirects for a long
    // time, which makes them hard to undo. Make it permanent once settled.
    return LEGACY_HOSTS.map((host) => ({
      source: "/:path*",
      has: [{ type: "host" as const, value: host }],
      destination: `${CANONICAL_ORIGIN}/:path*`,
      permanent: false,
    }));
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
