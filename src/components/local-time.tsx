"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/**
 * Formats a timestamp in the viewer's own timezone. The server doesn't know
 * it, so the server render is empty and the browser fills it in on hydration.
 */
export function LocalTime({ iso }: { iso: string }) {
  const text = useSyncExternalStore(
    subscribe,
    () =>
      new Date(iso).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }),
    () => "",
  );
  return <time dateTime={iso}>{text}</time>;
}
