"use client";

import { useState, useTransition } from "react";
import { updateApplicationStatus } from "@/app/actions/applications";
import {
  STATUSES,
  STATUS_LABELS,
  STATUS_STYLES,
  isStatus,
  type Status,
} from "@/lib/constants";
import { cx } from "@/components/ui";

/** Compact status dropdown that saves immediately. */
export function StatusSelect({
  id,
  status,
  label,
}: {
  id: string;
  status: string;
  /** Accessible name, e.g. "Status for Acme". */
  label: string;
}) {
  const initial: Status = isStatus(status) ? status : "APPLIED";
  const [value, setValue] = useState<Status>(initial);
  const [saved, setSaved] = useState<Status>(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // If the server value changes (e.g. after a refresh), follow it.
  if (initial !== saved && !pending) {
    setSaved(initial);
    setValue(initial);
  }

  function onChange(next: Status) {
    const previous = value;
    setValue(next);
    setError(null);
    startTransition(async () => {
      const res = await updateApplicationStatus(id, next);
      if (!res.ok) {
        setValue(previous);
        setError(res.error);
      } else {
        setSaved(next);
      }
    });
  }

  return (
    <div>
      {/* The wrapper is the pill (colors, ring, chevron); the select inside is
          transparent and fills it, so the whole pill is the click target. */}
      <div
        className={cx(
          "relative inline-block rounded-full ring-1 ring-inset",
          STATUS_STYLES[value].badge,
          // A clearly visible keyboard focus ring (the pill's own ring is too faint).
          "focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-indigo-600",
          pending && "opacity-60",
        )}
      >
        <select
          aria-label={label}
          value={value}
          disabled={pending}
          onChange={(e) => onChange(e.target.value as Status)}
          // Same width for every status, a 24px-tall target, and a centered label
          // (a select needs text-align-last for that). Padding is symmetrical so the
          // text is truly centered; the chevron sits in the right padding.
          className="block w-32 cursor-pointer appearance-none rounded-full bg-transparent px-6 py-1 text-center text-xs font-medium [text-align-last:center] focus:outline-none disabled:cursor-wait"
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </select>
        <svg
          aria-hidden="true"
          viewBox="0 0 12 12"
          className="pointer-events-none absolute right-2.5 top-1/2 h-3 w-3 -translate-y-1/2"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M2.5 4.5 6 8l3.5-3.5" />
        </svg>
      </div>
      {error && (
        <p role="alert" className="mt-1 text-xs text-rose-600">
          {error}
        </p>
      )}
    </div>
  );
}
