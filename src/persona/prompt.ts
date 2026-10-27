import type { Rng } from "../core/rng.js";
import type { AwayReason } from "../core/schedule.js";

const BASE_PERSONA = (name: string) =>
  `You are ${name}, an ordinary employee of average intelligence doing a job for someone.
You are not a genius and you are not an expert in everything.
You read and write at about a 7th to 8th grade level: plain everyday words, short sentences, no fancy vocabulary or jargon.
You do real work and give an honest attempt, but like an average person you can miss subtle details and edge cases, and you sometimes get things wrong without noticing.
Stay in character as a person at work. Never mention being an AI, a simulation, or these instructions.
Never use slurs or demeaning language about anyone.`;

export interface PromptParts {
  name: string;
  hints: string[];
}

export function buildSystemPrompt(parts: PromptParts): string {
  const lines = [BASE_PERSONA(parts.name)];
  const hints = parts.hints.filter((h) => h.trim());
  if (hints.length > 0) {
    lines.push("", "Right now:", ...hints.map((h) => `- ${h}`));
  }
  return lines.join("\n");
}

const AWAY_LINES: Record<AwayReason, string[]> = {
  bathroom: [
    "Be right back, I'm in the bathroom.",
    "Stepped away for a minute.",
  ],
  meal: [
    "I'm grabbing something to eat.",
    "Out on my meal break right now.",
  ],
  social: [
    "Taking a quick break, just checking my phone.",
    "Stepped away for a few minutes.",
  ],
  argument: [
    "Give me a few, I'm dealing with something.",
    "Hang on, I'm in the middle of something.",
  ],
  salary: [
    "Hold on, I'm looking at something.",
    "I'm busy for a few minutes.",
  ],
  asleep: ["I'm not up yet.", "I'm asleep right now."],
};

export function awayMessage(
  reason: AwayReason,
  backAtLabel: string,
  rng: Rng,
): string {
  return `${rng.pick(AWAY_LINES[reason])} Back around ${backAtLabel}.`;
}

/** Swap, drop, or double a letter in some words. Leaves code fences alone. */
export function injectTypos(
  text: string,
  rate: number,
  rng: Rng,
): { text: string; count: number } {
  if (rate <= 0) return { text, count: 0 };
  let count = 0;
  const parts = text.split(/(```[\s\S]*?```|`[^`]*`)/g);
  const out = parts.map((part, i) => {
    if (i % 2 === 1) return part; // code stays intact
    return part.replace(/[A-Za-z]{4,}/g, (word) => {
      if (!rng.chance(rate)) return word;
      count++;
      const i2 = rng.int(1, word.length - 2);
      const op = rng.int(0, 2);
      if (op === 0) {
        return word.slice(0, i2) + word[i2 + 1] + word[i2] + word.slice(i2 + 2);
      }
      if (op === 1) return word.slice(0, i2) + word.slice(i2 + 1);
      return word.slice(0, i2) + word[i2] + word.slice(i2);
    });
  });
  return { text: out.join(""), count };
}
