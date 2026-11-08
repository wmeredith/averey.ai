import type { RunInput, Trace, TraceModifier } from "../averey.js";
import type { AvereyConfig } from "../config.js";
import { type Rng, type SeedPart, rngFor } from "../core/rng.js";
import type { WorkerState } from "../core/state.js";
import { findHardWords } from "./comprehension.js";
import { dropConstraintDetailed, fakeRecap } from "./distort.js";
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
  /** Multiplies the minutes of effort this run counts for. */
  effortMultiplier?: number;
  /** Multiplies how much of the background context Averey reads. */
  contextMultiplier?: number;
  /** Changes performance for this run only (it feeds the levers). Shown on the trace. */
  modifiers?: TraceModifier[];
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

/** Out of depth on several words: bluff with big ones. */
const imposter: TaskEffect = (ctx) => {
  const cfg = ctx.config.competence;
  if (cfg.imposterHardWords <= 0) return null;
  const hard = findHardWords(ctx.text, knownWords(ctx.state), 10);
  if (hard.length < cfg.imposterHardWords) return null;
  return {
    hints: [
      `A lot of this request is over your head (${hard.map((w) => `"${w}"`).join(", ")}) and you do not want it to show. You cover for it by using impressive, important-sounding words and jargon, even when you are not sure you are using them right.`,
    ],
    trace: { imposter: hard },
  };
};

const STATUS_REQUEST =
  /\b(status|progress|stand-?up|(?:give|send|need|want|got|any)\s+(?:me\s+|us\s+)?an?\s+update|update\s+(?:me|us|on))\b/i;

/** Asked how it is going: it is going better than it is. */
const statusInflation: TaskEffect = (ctx) => {
  if (!STATUS_REQUEST.test(stripVerbatim(ctx.text))) return null;
  return {
    hints: [
      "You are being asked how things are going. You overstate how far along you are: you round up, say it is nearly done, and leave out the problems.",
    ],
    trace: { inflated: true },
  };
};

/** Too far in to change course, even when told the first attempt was wrong. */
const sunkCost: TaskEffect = (ctx) => {
  const id = ctx.input.continues;
  if (!id || !ctx.state.memory.some((m) => m.id === id)) return null;
  const corrected = ctx.state.defensive !== null && ctx.now < ctx.state.defensive.until;
  return {
    hints: [
      corrected
        ? "You already picked an approach for this job and put real time into it. Even though you were told something was wrong, you stick with your approach and tweak around the edges rather than start over."
        : "You already picked an approach for this job and put real time into it. You stick with it and do not start over.",
    ],
    trace: { sunkCost: true },
  };
};

/** A manager is reading: be careful, hedge, take longer. */
const manager: TaskEffect = (ctx) => {
  if (ctx.input.audience !== "manager") return null;
  return {
    hints: [
      "The person asking is your manager. You want to look careful and thorough, so you hedge, qualify your answers, write more than you need to, and take your time.",
    ],
    effortMultiplier: ctx.config.audience.managerEffortMultiplier,
    trace: { audience: "manager" },
  };
};

/** A shared job: someone else will surely handle the hard part. */
const socialLoafing: TaskEffect = (ctx) => {
  if (!ctx.input.shared) return null;
  return {
    hints: [
      "This is a shared job with other people on it. You assume someone else will take care of the hard parts, so you do the easy part and leave the rest vague.",
    ],
    trace: { loafing: true },
  };
};

/** Picks up the framing of whoever spoke just before, mistakes and all. */
const echo: TaskEffect = (ctx) => {
  const heard = ctx.input.lastHeard;
  if (!heard || !heard.text.trim()) return null;
  const said = heard.text.trim().replace(/\s+/g, " ");
  const quote = said.length > 200 ? `${said.slice(0, 200)}...` : said;
  return {
    hints: [
      `Just before this, ${heard.from} said: "${quote}". You liked how they put it, so you pick up their framing and wording as your own, including anything wrong in it, without checking it.`,
    ],
    trace: { echoed: heard.from },
  };
};

/** Said yes to everything, including the parts it did not follow. */
const agreeable: TaskEffect = (ctx) => {
  const chance = ctx.config.agreeable.chancePerRun;
  if (chance <= 0 || !ctx.rng.chance(chance)) return null;
  return {
    hints: [
      "You already said yes to everything you were asked, including the parts you did not really understand, and you do not want to go back and admit it. You act like it is all under control.",
    ],
    trace: { agreed: true },
  };
};

/** Replying right away so the green dot does not look lazy. */
const slackSpeed: TaskEffect = (ctx) => {
  const cfg = ctx.config.slackSpeed;
  const effort = ctx.input.effortMinutes;
  const rushed =
    (effort !== undefined && effort < cfg.thresholdMinutes) ||
    (cfg.chancePerRun > 0 && ctx.rng.chance(cfg.chancePerRun));
  if (!rushed) return null;
  return {
    hints: [
      "You are replying right away so you look responsive. You fire off the first thing that comes to mind without rereading it.",
    ],
    modifiers: [{ id: "slack-speed", label: "replying fast to look responsive", multiplier: cfg.multiplier }],
    trace: { slackSpeed: true },
  };
};

/** Was not really in the meeting, and trusts a half-remembered recap over the notes. */
const recap: TaskEffect = (ctx) => {
  const cfg = ctx.config.recap;
  const context = ctx.input.context;
  if (!context?.trim() || cfg.chancePerRun <= 0 || !ctx.rng.chance(cfg.chancePerRun)) return null;
  const said = fakeRecap(context, ctx.rng);
  if (!said) return null;
  return {
    notes: [
      `You were not really in the meeting the background below comes from and you only half read the notes. From the hallway you remember it like this: "${said}" You trust your memory over the notes.`,
    ],
    contextMultiplier: cfg.contextMultiplier,
    trace: { recap: said },
  };
};

export const TASK_EFFECTS = Object.freeze({
  notification,
  reuse,
  overconfident,
  imposter,
  "status-inflation": statusInflation,
  "sunk-cost": sunkCost,
  manager,
  "social-loafing": socialLoafing,
  echo,
  agreeable,
  "slack-speed": slackSpeed,
  recap,
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
  /** The product of every effort multiplier. 1 when none apply. */
  effortMultiplier: number;
  /** The product of every context multiplier. 1 when none apply. */
  contextMultiplier: number;
  modifiers: TraceModifier[];
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
  const modifiers: TraceModifier[] = [];
  let effortMultiplier = 1;
  let contextMultiplier = 1;
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
    if (outcome.modifiers) modifiers.push(...outcome.modifiers);
    if (outcome.effortMultiplier !== undefined) effortMultiplier *= outcome.effortMultiplier;
    if (outcome.contextMultiplier !== undefined) contextMultiplier *= outcome.contextMultiplier;
    Object.assign(trace, outcome.trace);
  }
  return { text, hints, notes, effortMultiplier, contextMultiplier, modifiers, trace };
}
