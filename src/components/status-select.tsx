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
      <select
        aria-label={label}
        value={value}
        disabled={pending}
        onChange={(e) => onChange(e.target.value as Status)}
        className={cx(
          "cursor-pointer appearance-none rounded-full py-0.5 pl-2.5 pr-2.5 text-xs font-medium ring-1 ring-inset focus:outline-none focus-visible:ring-2 disabled:opacity-60",
          STATUS_STYLES[value].badge,
        )}
      >
        {STATUSES.map((s) => (
          <option key={s} value={s}>
            {STATUS_LABELS[s]}
          </option>
        ))}
      </select>
      {error && (
        <p role="alert" className="mt-1 text-xs text-rose-600">
          {error}
        </p>
      )}
    </div>
  );
}
