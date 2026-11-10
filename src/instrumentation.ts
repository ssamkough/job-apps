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
  console.error(
    JSON.stringify({
      level: "error",
      time: new Date().toISOString(),
      message: error.message,
      digest,
      path: request.path.split("?")[0], // drop the query: it can hold reset tokens
      method: request.method,
      route: context.routePath,
      routeType: context.routeType,
      stack: error.stack,
    }),
  );
};
