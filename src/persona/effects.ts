import type { Trace } from "../averey.js";
import type { AvereyConfig } from "../config.js";
import { type Rng, type SeedPart, rngFor } from "../core/rng.js";
import { dropConstraintDetailed } from "./distort.js";

/**
 * Effects that act on what Averey thinks the task is, not on how well they
 * do it. Each one may rewrite the task text, add condition hints for the
 * system prompt, and record what it did on the trace.
 */
export interface TaskEffectContext {
  /** The task as Averey currently understands it (after earlier effects). */
  text: string;
  config: AvereyConfig;
  performance: number;
  now: number;
  /** An rng private to this effect, so effects never shift each other's rolls. */
  rng: Rng;
}

export interface TaskEffectOutcome {
  text?: string;
  hints?: string[];
  trace?: Partial<Trace>;
}

export type TaskEffect = (ctx: TaskEffectContext) => TaskEffectOutcome | null;

/** A phone buzz in the middle of reading a request: one rule falls out. */
const notification: TaskEffect = (ctx) => {
  const chance = ctx.config.notification.chancePerRun;
  if (chance <= 0 || !ctx.rng.chance(chance)) return null;
  const result = dropConstraintDetailed(ctx.text, ctx.rng, { constraintsOnly: true });
  if (!result) return { trace: { notification: { dropped: false } } };
  return {
    text: result.text,
    hints: [
      "Your phone buzzed in the middle of reading this request and you lost the thread. You are not totally sure you caught everything.",
    ],
    trace: { notification: { dropped: true, removed: result.dropped } },
  };
};

export const TASK_EFFECTS = Object.freeze({
  notification,
} satisfies Record<string, TaskEffect>);

export interface ApplyTaskEffects {
  text: string;
  config: AvereyConfig;
  performance: number;
  now: number;
  seed: SeedPart;
  /** Distinguishes runs at the same instant. */
  runIndex: number;
}

export interface AppliedEffects {
  text: string;
  hints: string[];
  trace: Partial<Trace>;
}

export function applyTaskEffects(
  ctx: ApplyTaskEffects,
  registry: Readonly<Record<string, TaskEffect>> = TASK_EFFECTS,
): AppliedEffects {
  const disabled = new Set(ctx.config.disabledModifiers);
  let text = ctx.text;
  const hints: string[] = [];
  const trace: Partial<Trace> = {};
  for (const [id, effect] of Object.entries(registry)) {
    if (disabled.has(id)) continue;
    const outcome = effect({
      text,
      config: ctx.config,
      performance: ctx.performance,
      now: ctx.now,
      rng: rngFor(ctx.seed, "effect", id, ctx.now, ctx.runIndex),
    });
    if (!outcome) continue;
    if (outcome.text !== undefined) text = outcome.text;
    if (outcome.hints) hints.push(...outcome.hints);
    Object.assign(trace, outcome.trace);
  }
  return { text, hints, trace };
}
