// Application dates are stored as UTC midnight, so always format in UTC to keep
// the day the user picked.
export function formatDate(date: Date | null | undefined, withYear = true) {
  if (!date) return "—";
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: withYear ? "numeric" : undefined,
    timeZone: "UTC",
  });
}

export function toDateInput(date: Date | null | undefined) {
  return date ? date.toISOString().slice(0, 10) : "";
}

export function todayDateInput() {
  return new Date().toISOString().slice(0, 10);
}

export function daysSince(date: Date, now = new Date()) {
  return Math.floor((now.getTime() - date.getTime()) / 86_400_000);
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}
