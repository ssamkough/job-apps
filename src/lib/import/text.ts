/**
 * Cuts `text` to at most `limit` characters at the most natural place: the end
 * of a paragraph (line), else the end of a sentence, else a word. Never cuts
 * mid-word unless a single word is longer than the whole limit. A boundary in
 * the first half is ignored, so a long unbroken paragraph doesn't throw most
 * of the text away.
 */
export function truncateAtBoundary(text: string, limit: number): string {
  if (text.length <= limit) return text;
  // One character past the limit: if it is whitespace, the cut is already clean.
  const window = text.slice(0, limit + 1);
  const floor = limit * 0.5;

  const paragraph = window.lastIndexOf("\n");
  if (paragraph >= floor) return window.slice(0, paragraph).trimEnd();

  let sentence = -1;
  for (const m of window.matchAll(/[.!?…]["'”’)\]]*(?=\s)/g)) sentence = m.index + m[0].length;
  if (sentence >= floor) return window.slice(0, sentence).trimEnd();

  const word = window.search(/\s\S*$/);
  if (word > 0) return window.slice(0, word).trimEnd();

  return text.slice(0, limit);
}
