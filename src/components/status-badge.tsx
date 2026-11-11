import { STATUS_LABELS, STATUS_STYLES, isStatus } from "@/lib/constants";
import { cx } from "@/components/ui";

export function StatusBadge({ status }: { status: string }) {
  if (!isStatus(status)) return <span className="text-xs">{status}</span>;
  return (
    <span
      className={cx(
        "inline-flex min-w-24 items-center justify-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset",
        STATUS_STYLES[status].badge,
      )}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}
