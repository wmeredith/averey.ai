import type { Rng } from "../core/rng.js";
import { mapProse, stripVerbatim } from "./verbatim.js";

const CONSTRAINT_WORDS =
  /\b(must|only|never|always|don't|do not|should|exactly|at least|at most|without|except|before|after|by)\b/i;

export function splitSentences(text: string): string[] {
  return text.match(/[^.!?\n]+[.!?]*\s*/g) ?? [text];
}

export interface DropResult {
  /** The text with one sentence removed. */
  text: string;
  /** The sentence that was removed. */
  dropped: string;
}

export interface DropOptions {
  /**
   * Only drop a sentence that reads like a rule ("must", "never", ...). Returns
   * undefined when there is none, instead of dropping a random sentence that
   * might be the actual ask.
   */
  constraintsOnly?: boolean;
}

/**
 * Removes one sentence, preferring one that sounds like a constraint. Code
 * and URLs are left untouched. Needs at least two sentences of prose.
 */
export function dropConstraintDetailed(
  text: string,
  rng: Rng,
  options: DropOptions = {},
): DropResult | undefined {
  const sentences: { seg: number; idx: number; text: string }[] = [];
  let seg = 0;
  mapProse(text, (prose) => {
    splitSentences(prose).forEach((s, idx) => {
      if (s.trim()) sentences.push({ seg, idx, text: s });
    });
    seg++;
    return prose;
  });
  if (sentences.length < 2) return undefined;

  const constraints = sentences.filter((s) => CONSTRAINT_WORDS.test(s.text));
  if (constraints.length === 0 && options.constraintsOnly) return undefined;
  const target =
    constraints.length > 0
      ? rng.pick(constraints)
      : sentences[rng.int(0, sentences.length - 1)]!;

  let current = 0;
  const out = mapProse(text, (prose) => {
    const parts = splitSentences(prose);
    const kept = current === target.seg ? parts.filter((_, i) => i !== target.idx) : parts;
    current++;
    return kept.join("");
  }).trim();
  return { text: out, dropped: target.text.trim() };
}

export function dropConstraint(text: string, rng: Rng): string | undefined {
  return dropConstraintDetailed(text, rng)?.text;
}

/** Nudges one number in the text. Undefined when there is none. */
export function distortNumber(text: string, rng: Rng): string | undefined {
  const matches = [...text.matchAll(/\d+/g)];
  if (matches.length === 0) return undefined;
  const m = rng.pick(matches);
  const n = Number(m[0]);
  const changed =
    n < 10 ? n + (rng.chance(0.5) ? 1 : -1) : Math.round(n * rng.range(0.7, 1.4));
  const next = String(Math.max(0, changed === n ? n + 1 : changed));
  const idx = m.index ?? 0;
  return text.slice(0, idx) + next + text.slice(idx + m[0].length);
}

const NEGATIONS: [RegExp, string][] = [
  [/\bwill\b/i, "will not"],
  [/\bshould\b/i, "should not"],
  [/\bmust\b/i, "must not"],
  [/\bcan\b/i, "cannot"],
  [/\bis\b/i, "is not"],
  [/\bare\b/i, "are not"],
];

function negate(text: string): string | undefined {
  for (const [re, replacement] of NEGATIONS) {
    if (re.test(text)) return text.replace(re, replacement);
  }
  return undefined;
}

/**
 * A wrong memory of a meeting: one sentence from the notes, with a number
 * changed or the decision flipped. Tries sentences in random order until one
 * can be got wrong, so plain filler does not hide the sentences that matter.
 * Code and URLs are ignored.
 */
export function fakeRecap(context: string, rng: Rng): string | undefined {
  const sentences = splitSentences(stripVerbatim(context))
    .map((s) => s.trim().replace(/[.!?]+$/, ""))
    .filter((s) => s.split(/\s+/).length >= 4);
  const shuffled = sentences
    .map((s) => [rng.next(), s] as const)
    .sort((a, b) => a[0] - b[0])
    .map(([, s]) => s);
  const numberFirst = rng.chance(0.5);
  for (const source of shuffled) {
    const ops = [(t: string) => distortNumber(t, rng), negate];
    if (!numberFirst) ops.reverse();
    for (const op of ops) {
      const changed = op(source);
      if (changed !== undefined && changed !== source) {
        return `I think we decided that ${changed.charAt(0).toLowerCase()}${changed.slice(1)}.`;
      }
    }
  }
  return undefined;
}
