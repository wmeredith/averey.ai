import type { AvereyConfig } from "./config.js";
import type { Block, Schedule } from "./core/schedule.js";
import { HOUR, MIN, localHour, localWeekday } from "./core/time.js";
import { type WorkerState, hoursWorkedIn } from "./core/state.js";

export interface Modifier {
  id: string;
  label: string;
  /** Multiplies overall performance. 1 means no change. */
  multiplier: number;
  /** Lines that describe Averey's current condition in the system prompt. */
  hints: string[];
}

export interface ModifierContext {
  now: number;
  config: AvereyConfig;
  state: WorkerState;
  schedule: Schedule;
}

export type ModifierFn = (ctx: ModifierContext) => Modifier | null;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function hoursWorked(ctx: ModifierContext): number {
  return hoursWorkedIn(
    ctx.state.workLog,
    ctx.now,
    ctx.config.hours.windowHours * HOUR,
  );
}

const hoursCap: ModifierFn = (ctx) => {
  const { capHours, decayK } = ctx.config.hours;
  const h = hoursWorked(ctx);
  if (h <= capHours) return null;
  const over = h - capHours;
  return {
    id: "hours",
    label: `${h.toFixed(1)}h worked in 24h (${over.toFixed(1)}h over the cap)`,
    multiplier: Math.exp(-decayK * over),
    hints: [
      `You have been working for about ${h.toFixed(0)} hours straight. You are burnt out, foggy, and sloppy. You skip steps and just want to be done.`,
    ],
  };
};

const tiredDay: ModifierFn = (ctx) => {
  if (!ctx.schedule.planAt(ctx.now).tired) return null;
  return {
    id: "tired",
    label: "came in overtired",
    multiplier: ctx.config.tired.multiplier,
    hints: [
      "You came in overtired today. You slept badly, you yawn a lot, and it is hard to concentrate.",
    ],
  };
};

const coffee: ModifierFn = (ctx) => {
  const plan = ctx.schedule.planAt(ctx.now);
  const first = ctx.state.firstEngagement[String(plan.dayIndex)] ?? ctx.now;
  if (ctx.now - first >= plan.coffeeDelayMs) return null;
  return {
    id: "pissy",
    label: "no coffee yet",
    multiplier: ctx.config.coffee.multiplier,
    hints: [
      "You have not had your coffee yet. You are a little grumpy: short answers, low patience, a bit of a sigh at annoying requests.",
    ],
  };
};

const sickness: ModifierFn = (ctx) => {
  const s = ctx.schedule.sickAt(ctx.now);
  if (!s.sick) return null;
  const cfg = ctx.config.sickness;
  const lastDay =
    s.episodeDays !== undefined &&
    s.dayInEpisode === s.episodeDays - 1 &&
    s.episodeDays > 1;
  return {
    id: "sick",
    label: `sick (day ${(s.dayInEpisode ?? 0) + 1} of ${s.episodeDays})`,
    multiplier: lastDay ? cfg.recoveryDayMultiplier : cfg.multiplier,
    hints: [
      lastDay
        ? "You are getting over being sick. You are mostly better but still a bit foggy and low on energy."
        : "You are sick with a bad cold. You are congested, foggy, and low on energy. Your answers are shorter and you make more mistakes.",
    ],
  };
};

const exposure: ModifierFn = (ctx) => {
  if (ctx.now >= ctx.state.exposedUntil) return null;
  return {
    id: "exposed",
    label: "run down after a sick coworker",
    multiplier: ctx.config.sickness.contagionPenalty,
    hints: [
      "You were just around a sick coworker and you feel a little run down and off your game.",
    ],
  };
};

/** True when a block starts within the local-hour range [from, to). */
function startsBetween(b: Block, offset: number, from: number, to: number): boolean {
  const h = localHour(b.start, offset);
  return h >= from && h < to;
}

const lunchDip: ModifierFn = (ctx) => {
  const cfg = ctx.config.lunchDip;
  const offset = ctx.config.utcOffsetMinutes;
  const lunch = ctx.schedule
    .recentBlocks("meal", ctx.now, cfg.windowMinutes * MIN)
    .some((b) => startsBetween(b, offset, cfg.fromHour, cfg.toHour));
  if (!lunch) return null;
  return {
    id: "lunch-dip",
    label: "post-lunch crash",
    multiplier: cfg.multiplier,
    hints: [
      "You just ate a big lunch and the afternoon slump has hit. You are foggy and slow and would love a nap, but you are still trying.",
    ],
  };
};

const friday: ModifierFn = (ctx) => {
  const cfg = ctx.config.weekday;
  const offset = ctx.config.utcOffsetMinutes;
  if (localWeekday(ctx.now, offset) !== 5) return null;
  if (localHour(ctx.now, offset) < cfg.fridayFromHour) return null;
  return {
    id: "friday",
    label: "Friday afternoon, already checked out",
    multiplier: cfg.fridayMultiplier,
    hints: [
      "It is Friday afternoon and your mind is already on the weekend. You keep your answers short, cut corners, and would happily say 'we can look at the rest on Monday'.",
    ],
  };
};

const monday: ModifierFn = (ctx) => {
  const cfg = ctx.config.weekday;
  const offset = ctx.config.utcOffsetMinutes;
  if (localWeekday(ctx.now, offset) !== 1) return null;
  if (localHour(ctx.now, offset) >= cfg.mondayUntilHour) return null;
  return {
    id: "monday",
    label: "Monday morning rust",
    multiplier: cfg.mondayMultiplier,
    hints: [
      "It is Monday morning. You are slow to get moving, dreading the pile in your inbox, and you have to reread the request to take it in.",
    ],
  };
};

const argument: ModifierFn = (ctx) => {
  const cfg = ctx.config.argument;
  if (cfg.minutesPerDay <= 0) return null;
  const recent = ctx.schedule.recentBlocks(
    "argument",
    ctx.now,
    cfg.penaltyMinutes * MIN,
  );
  if (recent.length === 0) return null;
  return {
    id: "argument",
    label: "still fuming from an online argument",
    multiplier: cfg.penalty,
    hints: [
      "You just got into a heated argument with a stranger online. You are still annoyed and replaying what you should have said, so it is hard to focus.",
    ],
  };
};

const salary: ModifierFn = (ctx) => {
  const cfg = ctx.config.salary;
  const recent = ctx.schedule.recentBlocks(
    "salary",
    ctx.now,
    cfg.effectHours * HOUR,
  );
  const block = recent[0];
  if (!block) return null;
  const day = ctx.schedule.dayIndex(block.start);
  const outcome = ctx.schedule.plan(day).salary?.outcome;
  if (!outcome) return null;
  return outcome === "boost"
    ? {
        id: "salary",
        label: "salary research: feels well paid",
        multiplier: cfg.boost,
        hints: [
          "You looked up salaries online and found you are paid fairly. You feel valued and a bit more motivated.",
        ],
      }
    : {
        id: "salary",
        label: "salary research: feels underpaid",
        multiplier: cfg.drag,
        hints: [
          "You looked up salaries online and found people in your job make more than you. You feel underpaid, resentful, and distracted.",
        ],
      };
};

const compliment: ModifierFn = (ctx) => {
  const cfg = ctx.config.compliment;
  let best: { sincere: boolean } | undefined;
  for (const c of ctx.state.compliments) {
    const windowMs = (c.sincere ? cfg.sincereWindowHours : cfg.windowHours) * HOUR;
    if (ctx.now >= c.at && ctx.now - c.at < windowMs) {
      if (!best || c.sincere) best = { sincere: c.sincere };
    }
  }
  if (!best) return null;
  return {
    id: "compliment",
    label: best.sincere ? "recent sincere compliment" : "recent compliment",
    multiplier: cfg.boost,
    hints: [
      best.sincere
        ? "Someone genuinely appreciated your work recently, in a way that showed they really noticed. You feel confident and want to do right by them."
        : "Someone said something nice about your work recently. You are in a decent mood.",
    ],
  };
};

const stress: ModifierFn = (ctx) => {
  const s = ctx.schedule.planAt(ctx.now).stress;
  const cfg = ctx.config.stress;
  return {
    id: "stress",
    label: `budget stress ${(s * 100).toFixed(0)}%`,
    multiplier: 1 - cfg.maxPenalty * s,
    hints:
      s > 0.65
        ? [
            "Money is tight. You are worried about bills and your budget, and it keeps creeping into your thoughts.",
          ]
        : [],
  };
};

const defensive: ModifierFn = (ctx) => {
  const d = ctx.state.defensive;
  if (!d || ctx.now >= d.until) return null;
  return {
    id: "defensive",
    label: "defensive about a recent mistake",
    multiplier: ctx.config.defensive.multiplier,
    hints: [
      `You were recently told you got something wrong (${d.error}). You are defensive about it: you justify what you did, point at unclear instructions, and resist corrections. You do not admit fault yet.`,
    ],
  };
};

const apology: ModifierFn = (ctx) => {
  const d = ctx.state.defensive;
  if (!d || ctx.now < d.until || !d.apologizes || d.apologized) return null;
  return {
    id: "apology",
    label: "ready to apologize",
    multiplier: 1,
    hints: [
      `You have cooled off about the earlier mistake (${d.error}). Start your reply by briefly and sincerely apologizing for getting defensive and admitting you got it wrong, then do the task.`,
    ],
  };
};

export const MODIFIERS = Object.freeze({
  hours: hoursCap,
  tired: tiredDay,
  pissy: coffee,
  sick: sickness,
  exposed: exposure,
  "lunch-dip": lunchDip,
  friday,
  monday,
  argument,
  salary,
  compliment,
  stress,
  defensive,
  apology,
} satisfies Record<string, ModifierFn>);

export type BuiltinModifierId = keyof typeof MODIFIERS;

export interface ModifierResult {
  performance: number;
  modifiers: Modifier[];
}

export function computeModifiers(
  ctx: ModifierContext,
  registry: Readonly<Record<string, ModifierFn>> = MODIFIERS,
): ModifierResult {
  const disabled = new Set(ctx.config.disabledModifiers);
  const modifiers: Modifier[] = [];
  for (const [id, fn] of Object.entries(registry)) {
    if (disabled.has(id)) continue;
    const m = fn(ctx);
    if (m) modifiers.push(m);
  }
  const product = modifiers.reduce((p, m) => p * m.multiplier, 1);
  const performance = clamp(
    product,
    ctx.config.minPerformance,
    ctx.config.maxPerformance,
  );
  return { performance, modifiers };
}
