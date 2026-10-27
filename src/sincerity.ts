import type { LLMProvider } from "./providers/types.js";

export interface SincerityContext {
  /** What Averey has been working on lately; used to judge relevance. */
  recentWork: string[];
}

export interface SincerityScorer {
  /** Returns 0..1. Higher means more relevant, topical, and personal. */
  score(text: string, ctx: SincerityContext): Promise<number> | number;
}

const STOPWORDS = new Set(
  "the a an and or but of to in on for with is are was were be been it this that you your i me my we our so very really just at as by from".split(
    " ",
  ),
);

const GENERIC = [
  "good job",
  "nice work",
  "great job",
  "well done",
  "nice one",
  "awesome",
  "thanks",
  "thank you",
  "nice",
  "great",
  "good",
];

function contentWords(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? []).filter(
    (w) => !STOPWORDS.has(w),
  );
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/**
 * A cheap heuristic: relevance (overlaps with recent work), personalness
 * (talks to the person, mentions something specific), and specificity
 * (more than a generic "good job").
 */
export class HeuristicSincerityScorer implements SincerityScorer {
  score(text: string, ctx: SincerityContext): number {
    const words = contentWords(text);
    if (words.length === 0) return 0;

    const work = new Set(ctx.recentWork.flatMap(contentWords));
    const overlap = words.filter((w) => work.has(w)).length;
    const relevance = clamp01(overlap / Math.min(3, words.length));

    const lower = text.toLowerCase();
    const personal = /\b(you|your|you're|you've)\b/.test(lower) ? 1 : 0;

    let stripped = lower;
    for (const g of GENERIC) stripped = stripped.split(g).join(" ");
    const specificWords = contentWords(stripped).length;
    const hasNumber = /\d/.test(text) ? 0.2 : 0;
    const specificity = clamp01(specificWords / 6 + hasNumber);

    return clamp01(0.45 * relevance + 0.25 * personal + 0.3 * specificity);
  }
}

/** Asks an LLM to judge sincerity. Falls back to the heuristic on a bad reply. */
export class LLMSincerityScorer implements SincerityScorer {
  private readonly fallback = new HeuristicSincerityScorer();

  constructor(private readonly provider: LLMProvider) {}

  async score(text: string, ctx: SincerityContext): Promise<number> {
    const system =
      "You rate how sincere a compliment is. Sincere means relevant to the work, topical, and personal (specific, not generic). Reply with only a number from 0 to 1.";
    const user = `Recent work:\n${ctx.recentWork.join("\n") || "(none)"}\n\nCompliment:\n${text}`;
    const res = await this.provider.complete({
      system,
      messages: [{ role: "user", content: user }],
      maxTokens: 10,
      temperature: this.provider.capabilities.temperature ? 0 : undefined,
    });
    const n = Number.parseFloat(res.text.trim());
    return Number.isFinite(n) ? clamp01(n) : this.fallback.score(text, ctx);
  }
}
