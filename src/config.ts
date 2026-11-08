export type Range = [number, number];

export interface MealConfig {
  /** Local hour (float) the meal is centered on. */
  centerHour: number;
  /** Random duration in minutes. */
  minutes: Range;
  /** +/- hours of jitter on the center. */
  jitterHours: number;
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
  /** Modifier ids to switch off (see modifiers.ts). */
  disabledModifiers: string[];

  hours: {
    /** Hours of work in the window before performance starts to fall. */
    capHours: number;
    windowHours: number;
    /** performance = exp(-decayK * (hours - cap)) beyond the cap. */
    decayK: number;
  };
  tired: { chancePerDay: number; multiplier: number };
  coffee: { delayMinutes: number; jitterMinutes: number; multiplier: number };
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

  hours: { capHours: 8, windowHours: 24, decayK: 0.5 },
  tired: { chancePerDay: 0.15, multiplier: 0.67 },
  coffee: { delayMinutes: 20, jitterMinutes: 5, multiplier: 0.93 },
  sickness: {
    episodesPerYear: 3,
    minDays: 3,
    maxDays: 6,
    multiplier: 0.65,
    recoveryDayMultiplier: 0.85,
    contagionPenalty: 0.9,
    contagionHours: 24,
  },
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
  prob("bias.strength", c.bias.strength);
  prob("bias.selfCorrectionRate", c.bias.selfCorrectionRate);
  prob("bias.baselineSecondGuess", c.bias.baselineSecondGuess);

  if (problems.length > 0) {
    throw new Error(`Invalid Averey config:\n- ${problems.join("\n- ")}`);
  }
}
