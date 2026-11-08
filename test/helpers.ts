import {
  Averey,
  type AvereyConfig,
  type DeepPartial,
  MockProvider,
  VirtualClock,
} from "../src/index.js";

/** Monday 2026-11-02 09:00 UTC. */
export const MONDAY_9AM = Date.UTC(2026, 10, 2, 9, 0);

/**
 * Trait modifiers that are off in tests unless a test names them in `enable`.
 * Add each new trait's modifier id here when it ships.
 */
export const TRAIT_MODIFIERS = [
  "lunch-dip",
  "friday",
  "monday",
  "notification",
  "reuse",
  "honeymoon",
  "coffee-crash",
  "hangry",
  "eod-rush",
  "seasonal",
  "allergies",
  "overconfident",
  "imposter",
  "status-inflation",
  "sunk-cost",
  "manager",
  "social-loafing",
  "echo",
  "agreeable",
  "slack-speed",
  "sports",
  "dst",
  "bill",
];

/**
 * A config where nothing random happens unless a test turns it on.
 * `enable` re-activates modifiers (including "stress" and "pissy") by id.
 */
export function quietConfig(
  overrides: DeepPartial<AvereyConfig> = {},
  enable: string[] = [],
): DeepPartial<AvereyConfig> {
  const disabledModifiers = [
    ...new Set([...(overrides.disabledModifiers ?? ["stress", "pissy"]), ...TRAIT_MODIFIERS]),
  ].filter((id) => !enable.includes(id));
  return {
    utcOffsetMinutes: 0,
    events: [],
    tired: { chancePerDay: 0 },
    sickness: { episodesPerYear: 0 },
    argument: { minutesPerDay: 0 },
    salary: { chancePerDay: 0 },
    breaks: {
      bathroom: { count: [0, 0] },
      social: { count: [0, 0] },
      meals: [],
    },
    comprehension: { enabled: false },
    memory: { baseDistortChance: 0, fatigueWeight: 0, stressWeight: 0, ageWeight: 0 },
    ...overrides,
    disabledModifiers,
  };
}

export function makeAverey(
  config: DeepPartial<AvereyConfig> = {},
  options: {
    start?: number;
    seed?: string;
    provider?: MockProvider;
    /** Modifier ids to turn back on (see `quietConfig`). */
    enable?: string[];
  } = {},
) {
  const clock = new VirtualClock(options.start ?? MONDAY_9AM);
  const provider = options.provider ?? new MockProvider();
  const averey = new Averey({
    provider,
    clock,
    seed: options.seed ?? "test",
    config: quietConfig(config, options.enable),
  });
  return { averey, clock, provider };
}
