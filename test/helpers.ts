import {
  Averey,
  type AvereyConfig,
  type DeepPartial,
  MockProvider,
  VirtualClock,
} from "../src/index.js";

/** Monday 2026-11-02 09:00 UTC. */
export const MONDAY_9AM = Date.UTC(2026, 10, 2, 9, 0);

/** A config where nothing random happens unless a test turns it on. */
export function quietConfig(
  overrides: DeepPartial<AvereyConfig> = {},
): DeepPartial<AvereyConfig> {
  return {
    utcOffsetMinutes: 0,
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
    disabledModifiers: ["stress", "pissy"],
    ...overrides,
  };
}

export function makeAverey(
  config: DeepPartial<AvereyConfig> = {},
  options: {
    start?: number;
    seed?: string;
    provider?: MockProvider;
  } = {},
) {
  const clock = new VirtualClock(options.start ?? MONDAY_9AM);
  const provider = options.provider ?? new MockProvider();
  const averey = new Averey({
    provider,
    clock,
    seed: options.seed ?? "test",
    config: quietConfig(config),
  });
  return { averey, clock, provider };
}
