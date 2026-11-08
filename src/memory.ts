import type { AvereyConfig } from "./config.js";
import type { Rng } from "./core/rng.js";
import type { MemoryItem } from "./core/state.js";
import { distortNumber, dropConstraint, splitSentences } from "./persona/distort.js";

function mergeWithOther(
  text: string,
  others: MemoryItem[],
  rng: Rng,
): string | undefined {
  if (others.length === 0) return undefined;
  const other = rng.pick(others);
  const sentences = splitSentences(other.current).filter((s) => s.trim());
  if (sentences.length === 0) return undefined;
  return `${text.trim()} ${rng.pick(sentences).trim()}`;
}

export interface RecallContext {
  performance: number;
  stress: number;
  now: number;
  rng: Rng;
}

export interface RecallResult {
  id: string;
  original: string;
  recalled: string;
  distorted: boolean;
  ops: string[];
}

/**
 * Memory that rots. Recalling a task can quietly change it: a number drifts,
 * a constraint falls out, or it blends with another task. Changes stick.
 */
export class LossyMemory {
  constructor(
    private readonly items: MemoryItem[],
    private readonly cfg: AvereyConfig["memory"],
  ) {}

  /** Remembers a task. Reusing an id with new text replaces the old version. */
  store(id: string, text: string, now: number): void {
    const index = this.items.findIndex((i) => i.id === id);
    if (index >= 0) {
      if (this.items[index]!.original === text) return;
      this.items.splice(index, 1);
    }
    this.items.push({
      id,
      original: text,
      current: text,
      storedAt: now,
      distortions: [],
    });
    while (this.items.length > this.cfg.maxItems) this.items.shift();
  }

  get(id: string): MemoryItem | undefined {
    return this.items.find((i) => i.id === id);
  }

  recent(n: number): MemoryItem[] {
    return this.items.slice(-n);
  }

  distortChance(item: MemoryItem, ctx: RecallContext): number {
    const ageDays = Math.min(7, Math.max(0, (ctx.now - item.storedAt) / 86_400_000));
    const fatigue = Math.max(0, 1 - ctx.performance);
    const p =
      this.cfg.baseDistortChance +
      this.cfg.fatigueWeight * fatigue +
      this.cfg.stressWeight * Math.max(0, ctx.stress - 0.5) +
      this.cfg.ageWeight * (ageDays / 7);
    return Math.min(0.9, p);
  }

  recall(id: string, ctx: RecallContext): RecallResult | undefined {
    const item = this.get(id);
    if (!item) return undefined;
    const ops: string[] = [];
    if (ctx.rng.chance(this.distortChance(item, ctx))) {
      const others = this.items.filter((i) => i.id !== id);
      const candidates: [string, () => string | undefined][] = [
        ["number-drift", () => distortNumber(item.current, ctx.rng)],
        ["dropped-constraint", () => dropConstraint(item.current, ctx.rng)],
        ["blended-with-other-task", () => mergeWithOther(item.current, others, ctx.rng)],
      ];
      // Try ops in random order until one applies.
      const order = candidates
        .map((c) => [ctx.rng.next(), c] as const)
        .sort((a, b) => a[0] - b[0]);
      for (const [, [name, fn]] of order) {
        const changed = fn();
        if (changed !== undefined && changed !== item.current) {
          item.current = changed;
          item.distortions.push(name);
          ops.push(name);
          break;
        }
      }
    }
    return {
      id,
      original: item.original,
      recalled: item.current,
      distorted: ops.length > 0,
      ops,
    };
  }
}
