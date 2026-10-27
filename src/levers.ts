import type { AvereyConfig } from "./config.js";
import type { ProviderCapabilities } from "./providers/types.js";

export interface Levers {
  /** Undefined when the provider does not support temperature. */
  temperature?: number;
  maxTokens: number;
  /** Fraction of the supplied context Averey actually "reads". */
  contextFraction: number;
  typoRate: number;
  /** Hints added because a lever is unavailable and needs compensating. */
  compensationHints: string[];
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Turns a performance multiplier into concrete model settings. Worse
 * performance means more randomness, shorter output, less context, and
 * more typos.
 */
export function computeLevers(
  performance: number,
  cfg: AvereyConfig,
  caps: ProviderCapabilities,
): Levers {
  const l = cfg.levers;
  const deficit = Math.max(0, 1 - performance);
  const compensationHints: string[] = [];

  let temperature: number | undefined;
  if (caps.temperature) {
    temperature = clamp(
      l.baseTemperature + deficit * l.temperatureSlope,
      0,
      l.maxTemperature,
    );
  } else if (performance < 0.8) {
    compensationHints.push(
      "Do not overthink this and do not double check your work. Go with your first idea.",
    );
  }

  const tokenFraction = clamp(performance, l.minTokenFraction, 1);
  const maxTokens = Math.max(
    64,
    Math.round(l.baseMaxTokens * (caps.maxTokens ? tokenFraction : 1)),
  );

  return {
    temperature,
    maxTokens,
    contextFraction: clamp(Math.sqrt(Math.max(performance, 0)), l.minContextFraction, 1),
    typoRate: deficit * l.typoRateAtZeroPerformance,
    compensationHints,
  };
}
