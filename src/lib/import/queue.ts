import "server-only";
import type { ImportKind } from "./prepare";

/** What the background extractor is given. The text is sent, never stored. */
export type ExtractionRequest = {
  jobId: string;
  kind: ImportKind;
  text: string;
  sourceUrl?: string;
};

/**
 * Where slow extraction work goes. The app only ever enqueues; the answer
 * comes back by calling `completeJob` / `failJob` in `jobs.ts`.
 */
export interface ImportQueue {
  enqueue(request: ExtractionRequest): Promise<void>;
}

let queue: ImportQueue | null = null;

/** The configured queue, or null when none is wired up (AI import unavailable). */
export function getImportQueue(): ImportQueue | null {
  return queue;
}

/** Wires up a queue implementation. Tests use this to install a fake. */
export function setImportQueue(next: ImportQueue | null) {
  queue = next;
}
