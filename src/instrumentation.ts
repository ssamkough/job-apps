import type { Instrumentation } from "next";

/**
 * Logs unexpected server errors as one JSON line each, which log collectors
 * (and `grep`) can parse. Swap in a hosted error tracker here if you adopt one.
 * Never logs request headers or bodies, which can contain cookies and passwords.
 */
export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  const error = err instanceof Error ? err : new Error(String(err));
  const digest =
    typeof err === "object" && err !== null && "digest" in err ? String(err.digest) : undefined;
  const path = request.path.split("?")[0]; // drop the query: it can hold email addresses
  // Pages that handle passwords, codes or sessions: keep the error's name and
  // digest (enough to find it in the host's logs) but not its text or stack,
  // which could echo user input.
  const sensitive = /^\/(login|signup|verify-email|forgot-password|reset-password|settings)(\/|$)/.test(path);
  console.error(
    JSON.stringify({
      level: "error",
      time: new Date().toISOString(),
      name: error.name,
      message: sensitive ? "[redacted: auth route]" : error.message,
      digest,
      path,
      method: request.method,
      route: context.routePath,
      routeType: context.routeType,
      stack: sensitive ? undefined : error.stack,
    }),
  );
};
