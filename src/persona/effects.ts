import type { RunInput, Trace } from "../averey.js";
import type { AvereyConfig } from "../config.js";
import { type Rng, type SeedPart, rngFor } from "../core/rng.js";
import type { WorkerState } from "../core/state.js";
import { findHardWords } from "./comprehension.js";
import { dropConstraintDetailed } from "./distort.js";
import { stripVerbatim } from "./verbatim.js";

/**
 * Effects that act on what Averey thinks the task is, not on how well they
 * do it. Each one may rewrite the task text, add condition hints for the
 * system prompt, and record what it did on the trace.
 */
export interface TaskEffectContext {
  /** The task as Averey currently understands it (after earlier effects). */
  text: string;
  input: RunInput;
  state: Readonly<WorkerState>;
  config: AvereyConfig;
  performance: number;
  now: number;
  /** An rng private to this effect, so effects never shift each other's rolls. */
  rng: Rng;
}

export interface TaskEffectOutcome {
  text?: string;
  hints?: string[];
  /** Extra paragraphs for the message to the model, after the task. */
  notes?: string[];
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

function tokens(text: string): Set<string> {
  return new Set(stripVerbatim(text).toLowerCase().match(/[a-z0-9']{3,}/g) ?? []);
}

/** Share of words two requests have in common, 0..1. */
export function similarity(a: string, b: string): number {
  const x = tokens(a);
  const y = tokens(b);
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / (x.size + y.size - shared);
}

/**
 * Averey does not forget, Averey over-remembers: given a request like one
 * they already did, they pull up the old answer and tweak it instead of
 * starting over, and miss some of what changed.
 */
const reuse: TaskEffect = (ctx) => {
  const cfg = ctx.config.reuse;
  const past = ctx.state.recentWork;
  if (past.length === 0) return null;

  const continued = ctx.input.continues
    ? past.find((w) => w.id === ctx.input.continues)
    : undefined;
  let source = continued;
  if (!source) {
    let best = 0;
    for (const w of past) {
      const score = similarity(ctx.input.task, w.task);
      if (score >= cfg.minOverlap && score > best) {
        best = score;
        source = w;
      }
    }
    if (!source || !ctx.rng.chance(cfg.chance)) return null;
  }
  return {
    notes: [
      `You already wrote something for ${continued ? "an earlier" : "a similar"} request. Do not start over: pull up your earlier answer below and tweak it. You will probably fix most of the names, numbers, and details that changed, but you are not careful about catching all of them.\n\nYour earlier answer:\n${source.output}`,
    ],
    trace: { reusedFrom: source.id },
  };
};

function knownWords(state: Readonly<WorkerState>): Set<string> {
  return new Set(Object.keys(state.learnedWords));
}

function wordCount(text: string): number {
  return stripVerbatim(text).split(/\s+/).filter(Boolean).length;
}

/** A short request with nothing hard in it: no need to double check. */
const overconfident: TaskEffect = (ctx) => {
  const cfg = ctx.config.competence;
  if (wordCount(ctx.text) > cfg.easyMaxWords) return null;
  if (findHardWords(ctx.text, knownWords(ctx.state), 1).length > 0) return null;
  return {
    hints: [
      "This one looks easy to you. You go with your first answer, do not bother double checking, and sound completely sure of yourself.",
    ],
    trace: { overconfident: true },
  };
};

export const TASK_EFFECTS = Object.freeze({
  notification,
  reuse,
  overconfident,
} satisfies Record<string, TaskEffect>);

export interface ApplyTaskEffects {
  text: string;
  input: RunInput;
  state: Readonly<WorkerState>;
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
  notes: string[];
  trace: Partial<Trace>;
}

export function applyTaskEffects(
  ctx: ApplyTaskEffects,
  registry: Readonly<Record<string, TaskEffect>> = TASK_EFFECTS,
): AppliedEffects {
  const disabled = new Set(ctx.config.disabledModifiers);
  let text = ctx.text;
  const hints: string[] = [];
  const notes: string[] = [];
  const trace: Partial<Trace> = {};
  for (const [id, effect] of Object.entries(registry)) {
    if (disabled.has(id)) continue;
    const outcome = effect({
      text,
      input: ctx.input,
      state: ctx.state,
      config: ctx.config,
      performance: ctx.performance,
      now: ctx.now,
      rng: rngFor(ctx.seed, "effect", id, ctx.now, ctx.runIndex),
    });
    if (!outcome) continue;
    if (outcome.text !== undefined) text = outcome.text;
    if (outcome.hints) hints.push(...outcome.hints);
    if (outcome.notes) notes.push(...outcome.notes);
    Object.assign(trace, outcome.trace);
  }
  return { text, hints, notes, trace };
}
