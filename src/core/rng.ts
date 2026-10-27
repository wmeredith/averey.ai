/**
 * Seeded randomness. Everything "random" about Averey (bad days, sick days,
 * misremembering) flows from here so runs are reproducible and testable.
 */

function hashString(input: string): number {
  let h = 1779033703 ^ input.length;
  for (let i = 0; i < input.length; i++) {
    h = Math.imul(h ^ input.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type SeedPart = string | number;

export class Rng {
  private readonly gen: () => number;

  constructor(seed: SeedPart) {
    this.gen = mulberry32(typeof seed === "number" ? seed : hashString(seed));
  }

  /** Uniform float in [0, 1). */
  next(): number {
    return this.gen();
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("Rng.pick on empty array");
    return items[Math.floor(this.next() * items.length)] as T;
  }
}

/** A fresh Rng whose stream depends only on (seed, keys). */
export function rngFor(seed: SeedPart, ...keys: SeedPart[]): Rng {
  return new Rng(`${seed}|${keys.join("|")}`);
}

/** A single deterministic float in [0, 1) for (seed, keys). */
export function hashFloat(seed: SeedPart, ...keys: SeedPart[]): number {
  return rngFor(seed, ...keys).next();
}
