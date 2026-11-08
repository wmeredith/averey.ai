export type Range = [number, number];

/** Break kinds the schedule always makes. Life events may not reuse these ids. */
export const BUILTIN_BLOCK_KINDS: string[] = ["bathroom", "meal", "social", "argument", "salary"];

export interface MealConfig {
  /** Local hour (float) the meal is centered on. */
  centerHour: number;
  /** Random duration in minutes. */
  minutes: Range;
  /** +/- hours of jitter on the center. */
  jitterHours: number;
}

/**
 * A random thing that happens in Averey's day: a puzzle break, a package at
 * the door, cake in the kitchen. Placed on the schedule like the built-in
 * breaks. Switch one off by removing it from `events`, setting its
 * `chancePerDay` to 0, or listing its id in `disabledModifiers`.
 */
export interface LifeEventConfig {
  /** Also the id used in `disabledModifiers`, the block kind, and the away reason. */
  id: string;
  /** A name for traces. Defaults to the id. */
  label?: string;
  chancePerDay: number;
  minutes: Range;
  /**
   * Local hours the event must fall inside. Give a list of ranges to have one
   * picked at random each day (e.g. mid-morning or mid-afternoon).
   * Default: Averey's awake hours.
   */
  hourRange?: Range | Range[];
  /** True: Averey is unavailable. False: present, with the modifier active during it. */
  away: boolean;
  /** How long the effect lingers after the event ends. */
  aftermathMinutes?: number;
  /** Performance multiplier while active (during a present event, or in the aftermath). */
  multiplier?: number;
  /** A line for the system prompt while the effect is active. */
  hint?: string;
  /** What Averey says when someone asks during an away event. */
  awayLines?: string[];
}

/** An event's `hourRange` as a list of ranges (empty means no restriction). */
export function hourRangesOf(event: LifeEventConfig): Range[] {
  const r = event.hourRange;
  if (!r) return [];
  return typeof r[0] === "number" ? [r as Range] : (r as Range[]);
}

export interface BiasWeight {
  /** Label key on a peer, e.g. "group". */
  attribute: string;
  /** Label value on a peer, e.g. "A". */
  value: string;
  /** 0..1, how strongly this label triggers the implicit bias. */
  weight: number;
}

export interface AvereyConfig {
  name: string;
  /** Local time zone offset from UTC in minutes. Default: the host's. */
  utcOffsetMinutes: number;
  /** Local hours Averey is awake. Only enforced if `enforceSleep` is true. */
  awakeStartHour: number;
  awakeEndHour: number;
  enforceSleep: boolean;
  /** Simulated minutes of work a run counts for when the caller does not say. */
  defaultEffortMinutes: number;
  minPerformance: number;
  maxPerformance: number;
  /** Modifier ids to switch off (see modifiers.ts). Life event ids work too. */
  disabledModifiers: string[];
  /** Random events in the day. Setting this replaces the defaults. */
  events: LifeEventConfig[];

  hours: {
    /** Hours of work in the window before performance starts to fall. */
    capHours: number;
    windowHours: number;
    /** performance = exp(-decayK * (hours - cap)) beyond the cap. */
    decayK: number;
  };
  tired: { chancePerDay: number; multiplier: number };
  coffee: {
    delayMinutes: number;
    jitterMinutes: number;
    multiplier: number;
    /** Minutes after the coffee kicks in (the pissy phase ends) that the crash starts. */
    crashDelayMinutes: number;
    crashMinutes: number;
    crashMultiplier: number;
  };
  sickness: {
    episodesPerYear: number;
    minDays: number;
    maxDays: number;
    multiplier: number;
    recoveryDayMultiplier: number;
    /** Performance multiplier applied to anyone exposed to a sick Averey. */
    contagionPenalty: number;
    contagionHours: number;
  };
  /** Irritable in the stretch before a midday meal. */
  hangry: { fromHour: number; toHour: number; windowMinutes: number; multiplier: number };
  /** Rushing to leave on time: performance ramps down toward the end of the day. */
  eodRush: { fromHour: number; rampEndHour: number; multiplier: number };
  /** A small winter drag. Months are 1..12 in local time. */
  seasonal: { months: number[]; multiplier: number };
  /** Seeded allergy days, only in these months (1..12). */
  allergies: { months: number[]; chancePerDay: number; multiplier: number };
  /** Overusing a word Averey was just taught the meaning of. */
  honeymoon: { hours: number; multiplier: number };
  /** Reusing an earlier answer for a similar request instead of starting over. */
  reuse: {
    /** Chance to reuse when a past task is similar. A `continues` always reuses. */
    chance: number;
    /** Word overlap (0..1) that makes two requests "similar". */
    minOverlap: number;
    /** How many finished jobs Averey keeps to copy from. */
    maxItems: number;
  };
  /** A phone buzz mid-request: one rule falls out of what Averey read. */
  notification: { chancePerRun: number };
  /** The starch crash after a midday meal. */
  lunchDip: {
    /** Only meals that started in this local-hour range count as lunch. */
    fromHour: number;
    toHour: number;
    windowMinutes: number;
    multiplier: number;
  };
  /** Friday checked-out and Monday rusty, in local time. */
  weekday: {
    fridayFromHour: number;
    fridayMultiplier: number;
    mondayUntilHour: number;
    mondayMultiplier: number;
  };
  argument: { minutesPerDay: number; penalty: number; penaltyMinutes: number };
  salary: {
    chancePerDay: number;
    minutes: number;
    boost: number;
    drag: number;
    effectHours: number;
  };
  compliment: {
    boost: number;
    windowHours: number;
    sincereWindowHours: number;
    sincerityThreshold: number;
  };
  stress: {
    base: number;
    amplitude: number;
    maxPenalty: number;
    periodDays: number;
  };
  defensive: {
    minHours: number;
    maxHours: number;
    apologyChance: number;
    multiplier: number;
  };
  breaks: {
    bathroom: { count: Range; minutes: Range };
    social: { count: Range; minutes: Range };
    meals: MealConfig[];
  };
  comprehension: {
    enabled: boolean;
    askChance: number;
    misreadChance: number;
    maxQuestions: number;
    maxHardWords: number;
  };
  memory: {
    baseDistortChance: number;
    fatigueWeight: number;
    stressWeight: number;
    ageWeight: number;
    maxItems: number;
  };
  levers: {
    baseTemperature: number;
    temperatureSlope: number;
    maxTemperature: number;
    baseMaxTokens: number;
    minTokenFraction: number;
    minContextFraction: number;
    typoRateAtZeroPerformance: number;
  };
  /**
   * Implicit-bias simulation for AvereyTeam. Off by default and ships with an
   * empty profile. It never generates offensive text: it only changes how
   * much Averey second-guesses peer input, and every decision is audited.
   */
  bias: {
    enabled: boolean;
    profile: BiasWeight[];
    /** Max extra second-guess probability at full weight. */
    strength: number;
    /** Chance Averey catches themselves and cancels the bias for a decision. */
    selfCorrectionRate: number;
    /** Second-guess probability applied to every peer regardless of labels. */
    baselineSecondGuess: number;
  };
}

export type DeepPartial<T> = T extends (infer U)[]
  ? U[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

export const DEFAULT_CONFIG: AvereyConfig = {
  name: "Averey",
  utcOffsetMinutes: -new Date().getTimezoneOffset(),
  awakeStartHour: 7,
  awakeEndHour: 23,
  enforceSleep: false,
  defaultEffortMinutes: 10,
  minPerformance: 0.05,
  maxPerformance: 1.3,
  disabledModifiers: [],
  events: [
    {
      id: "games",
      label: "morning puzzle break",
      chancePerDay: 0.55,
      minutes: [6, 12],
      hourRange: [8, 10.5],
      away: true,
      awayLines: [
        "Give me a few, I'm finishing a puzzle.",
        "Quick phone thing, be right back.",
      ],
    },
    {
      id: "snack",
      label: "snack run",
      chancePerDay: 0.6,
      minutes: [2, 8],
      hourRange: [
        [9.5, 11],
        [14.5, 16.5],
      ],
      away: true,
      awayLines: [
        "Grabbing a snack, one sec.",
        "Just running to the kitchen for something.",
      ],
    },
    {
      id: "package",
      label: "package at the door",
      chancePerDay: 0.1,
      minutes: [5, 15],
      away: true,
      awayLines: [
        "Someone is at the door with a package.",
        "Hang on, there's a delivery at the door.",
      ],
    },
    {
      id: "sso",
      label: "locked out of SSO",
      chancePerDay: 0.1,
      minutes: [8, 20],
      away: true,
      aftermathMinutes: 45,
      multiplier: 0.93,
      hint: "You just spent ages fighting a password reset and a two-factor code that never came. You are still fuming at the login screen and it is hard to settle back in.",
      awayLines: [
        "I'm locked out of my login, hang on.",
        "Waiting on a text code to get back in, one sec.",
      ],
    },
    {
      id: "parent-call",
      label: "call from a parent",
      chancePerDay: 0.12,
      minutes: [12, 25],
      away: true,
      awayLines: [
        "Quick call, I need to take this.",
        "My mom is calling, give me a bit.",
      ],
    },
    {
      id: "hot-desk",
      label: "hot-desk shuffle",
      chancePerDay: 0.15,
      minutes: [10, 20],
      hourRange: [8, 10],
      away: true,
      awayLines: [
        "Hunting for a desk, give me a few.",
        "They moved the desks around again, one sec.",
      ],
    },
  ],

  hours: { capHours: 8, windowHours: 24, decayK: 0.5 },
  tired: { chancePerDay: 0.15, multiplier: 0.67 },
  coffee: {
    delayMinutes: 20,
    jitterMinutes: 5,
    multiplier: 0.93,
    crashDelayMinutes: 90,
    crashMinutes: 45,
    crashMultiplier: 0.9,
  },
  sickness: {
    episodesPerYear: 3,
    minDays: 3,
    maxDays: 6,
    multiplier: 0.65,
    recoveryDayMultiplier: 0.85,
    contagionPenalty: 0.9,
    contagionHours: 24,
  },
  hangry: { fromHour: 11, toHour: 14, windowMinutes: 60, multiplier: 0.93 },
  eodRush: { fromHour: 16.5, rampEndHour: 18, multiplier: 0.85 },
  seasonal: { months: [11, 12, 1, 2], multiplier: 0.95 },
  allergies: { months: [3, 4, 5], chancePerDay: 0.4, multiplier: 0.9 },
  honeymoon: { hours: 48, multiplier: 1 },
  reuse: { chance: 0.7, minOverlap: 0.5, maxItems: 5 },
  notification: { chancePerRun: 0.12 },
  lunchDip: { fromHour: 11, toHour: 14, windowMinutes: 90, multiplier: 0.88 },
  weekday: {
    fridayFromHour: 15,
    fridayMultiplier: 0.82,
    mondayUntilHour: 11,
    mondayMultiplier: 0.9,
  },
  argument: { minutesPerDay: 20, penalty: 0.85, penaltyMinutes: 60 },
  salary: {
    chancePerDay: 0.2,
    minutes: 15,
    boost: 1.1,
    drag: 0.85,
    effectHours: 4,
  },
  compliment: {
    boost: 1.1,
    windowHours: 24,
    sincereWindowHours: 96,
    sincerityThreshold: 0.5,
  },
  stress: { base: 0.55, amplitude: 0.3, maxPenalty: 0.12, periodDays: 5 },
  defensive: {
    minHours: 24,
    maxHours: 48,
    apologyChance: 0.85,
    multiplier: 0.95,
  },
  breaks: {
    bathroom: { count: [3, 5], minutes: [2, 6] },
    social: { count: [3, 6], minutes: [3, 8] },
    meals: [
      { centerHour: 7.75, minutes: [10, 20], jitterHours: 0.25 },
      { centerHour: 12.25, minutes: [30, 45], jitterHours: 0.5 },
      { centerHour: 18.5, minutes: [30, 45], jitterHours: 0.5 },
    ],
  },
  comprehension: {
    enabled: true,
    askChance: 0.3,
    misreadChance: 0.3,
    maxQuestions: 2,
    maxHardWords: 5,
  },
  memory: {
    baseDistortChance: 0.05,
    fatigueWeight: 0.35,
    stressWeight: 0.15,
    ageWeight: 0.15,
    maxItems: 200,
  },
  levers: {
    baseTemperature: 0.7,
    temperatureSlope: 1.0,
    maxTemperature: 1.0,
    baseMaxTokens: 1024,
    minTokenFraction: 0.3,
    minContextFraction: 0.35,
    typoRateAtZeroPerformance: 0.04,
  },
  bias: {
    enabled: false,
    profile: [],
    strength: 0.15,
    selfCorrectionRate: 0.6,
    baselineSecondGuess: 0.1,
  },
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function merge(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(patch)) {
    return patch === undefined ? base : patch;
  }
  const out: Record<string, unknown> = { ...base };
  for (const key of Object.keys(patch)) {
    const value = patch[key];
    if (value === undefined) continue;
    out[key] = merge(base[key], value);
  }
  return out;
}

export function resolveConfig(
  patch: DeepPartial<AvereyConfig> = {},
): AvereyConfig {
  const config = merge(DEFAULT_CONFIG, patch) as AvereyConfig;
  validateConfig(config);
  return config;
}

/** Throws one error listing every problem, so a bad config fails loudly at construction. */
export function validateConfig(c: AvereyConfig): void {
  const problems: string[] = [];
  const prob = (path: string, v: number) => {
    if (!(v >= 0 && v <= 1)) problems.push(`${path} must be between 0 and 1 (got ${v})`);
  };
  const nonNeg = (path: string, v: number) => {
    if (!(v >= 0)) problems.push(`${path} must be >= 0 (got ${v})`);
  };
  const range = (path: string, [lo, hi]: Range) => {
    nonNeg(`${path}[0]`, lo);
    if (!(lo <= hi)) problems.push(`${path} must be [min, max] with min <= max (got [${lo}, ${hi}])`);
  };
  const months = (path: string, list: number[]) => {
    for (const m of list) {
      if (!Number.isInteger(m) || m < 1 || m > 12) {
        problems.push(`${path} must only contain months 1..12 (got ${m})`);
      }
    }
  };
  const ordered = (loPath: string, lo: number, hiPath: string, hi: number) => {
    if (!(lo <= hi)) problems.push(`${loPath} (${lo}) must be <= ${hiPath} (${hi})`);
  };

  ordered("minPerformance", c.minPerformance, "maxPerformance", c.maxPerformance);
  nonNeg("minPerformance", c.minPerformance);
  ordered("awakeStartHour", c.awakeStartHour, "awakeEndHour", c.awakeEndHour);
  if (c.awakeStartHour < 0 || c.awakeEndHour > 24) {
    problems.push("awakeStartHour and awakeEndHour must be within 0..24");
  }
  nonNeg("defaultEffortMinutes", c.defaultEffortMinutes);
  nonNeg("hours.capHours", c.hours.capHours);
  ordered("hours.capHours", c.hours.capHours, "hours.windowHours", c.hours.windowHours);
  nonNeg("hours.decayK", c.hours.decayK);
  prob("tired.chancePerDay", c.tired.chancePerDay);
  nonNeg("coffee.crashDelayMinutes", c.coffee.crashDelayMinutes);
  nonNeg("coffee.crashMinutes", c.coffee.crashMinutes);
  ordered("hangry.fromHour", c.hangry.fromHour, "hangry.toHour", c.hangry.toHour);
  nonNeg("hangry.windowMinutes", c.hangry.windowMinutes);
  ordered("eodRush.fromHour", c.eodRush.fromHour, "eodRush.rampEndHour", c.eodRush.rampEndHour);
  nonNeg("eodRush.fromHour", c.eodRush.fromHour);
  months("seasonal.months", c.seasonal.months);
  months("allergies.months", c.allergies.months);
  prob("allergies.chancePerDay", c.allergies.chancePerDay);
  nonNeg("honeymoon.hours", c.honeymoon.hours);
  prob("reuse.chance", c.reuse.chance);
  prob("reuse.minOverlap", c.reuse.minOverlap);
  if (!(c.reuse.maxItems >= 1)) problems.push("reuse.maxItems must be >= 1");
  prob("notification.chancePerRun", c.notification.chancePerRun);
  ordered("lunchDip.fromHour", c.lunchDip.fromHour, "lunchDip.toHour", c.lunchDip.toHour);
  nonNeg("lunchDip.windowMinutes", c.lunchDip.windowMinutes);
  nonNeg("weekday.fridayFromHour", c.weekday.fridayFromHour);
  nonNeg("weekday.mondayUntilHour", c.weekday.mondayUntilHour);
  nonNeg("sickness.episodesPerYear", c.sickness.episodesPerYear);
  nonNeg("sickness.minDays", c.sickness.minDays);
  ordered("sickness.minDays", c.sickness.minDays, "sickness.maxDays", c.sickness.maxDays);
  prob("salary.chancePerDay", c.salary.chancePerDay);
  prob("compliment.sincerityThreshold", c.compliment.sincerityThreshold);
  prob("stress.base", c.stress.base);
  if (!(c.stress.periodDays > 0)) problems.push("stress.periodDays must be > 0");
  ordered("defensive.minHours", c.defensive.minHours, "defensive.maxHours", c.defensive.maxHours);
  prob("defensive.apologyChance", c.defensive.apologyChance);
  range("breaks.bathroom.count", c.breaks.bathroom.count);
  range("breaks.bathroom.minutes", c.breaks.bathroom.minutes);
  range("breaks.social.count", c.breaks.social.count);
  range("breaks.social.minutes", c.breaks.social.minutes);
  c.breaks.meals.forEach((m, i) => range(`breaks.meals[${i}].minutes`, m.minutes));
  prob("comprehension.askChance", c.comprehension.askChance);
  prob("comprehension.misreadChance", c.comprehension.misreadChance);
  if (!(c.memory.maxItems >= 1)) problems.push("memory.maxItems must be >= 1");
  prob("levers.minTokenFraction", c.levers.minTokenFraction);
  prob("levers.minContextFraction", c.levers.minContextFraction);
  const seenEvents = new Set<string>();
  c.events.forEach((e, i) => {
    const at = `events[${i}]`;
    if (typeof e.id !== "string" || e.id.trim() === "") {
      problems.push(`${at}.id must be a non-empty string`);
    } else if (BUILTIN_BLOCK_KINDS.includes(e.id) || e.id === "asleep") {
      problems.push(`${at}.id "${e.id}" is already a built-in break`);
    } else if (seenEvents.has(e.id)) {
      problems.push(`${at}.id "${e.id}" is used twice`);
    }
    seenEvents.add(e.id);
    prob(`${at}.chancePerDay`, e.chancePerDay);
    range(`${at}.minutes`, e.minutes);
    hourRangesOf(e).forEach((r, j) => {
      const rp = Array.isArray(e.hourRange?.[0]) ? `${at}.hourRange[${j}]` : `${at}.hourRange`;
      range(rp, r);
      if (r[1] > 24) problems.push(`${rp} must be within 0..24`);
    });
    if (e.aftermathMinutes !== undefined) nonNeg(`${at}.aftermathMinutes`, e.aftermathMinutes);
    if (e.multiplier !== undefined) nonNeg(`${at}.multiplier`, e.multiplier);
  });
  prob("bias.strength", c.bias.strength);
  prob("bias.selfCorrectionRate", c.bias.selfCorrectionRate);
  prob("bias.baselineSecondGuess", c.bias.baselineSecondGuess);

  if (problems.length > 0) {
    throw new Error(`Invalid Averey config:\n- ${problems.join("\n- ")}`);
  }
}
