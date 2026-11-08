import type { Rng } from "../core/rng.js";
import { mapProse } from "./verbatim.js";

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
