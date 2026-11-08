/**
 * Text that must never be altered or "read": fenced code (including a fence
 * left open by a truncated reply), inline code, and URLs.
 */
const VERBATIM = /(```[\s\S]*?(?:```|$)|`[^`]*`|https?:\/\/\S+)/g;

export function stripVerbatim(text: string): string {
  return text.replace(VERBATIM, " ");
}

/** Applies `fn` to the prose parts of `text` and leaves verbatim parts as they are. */
export function mapProse(text: string, fn: (prose: string) => string): string {
  return text
    .split(VERBATIM)
    .map((part, i) => (i % 2 === 1 ? part : fn(part)))
    .join("");
}
