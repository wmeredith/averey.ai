import { type AvereyConfig, hourRangesOf } from "../config.js";
import { type Rng, type SeedPart, rngFor, hashFloat } from "./rng.js";
import {
  HOUR,
  MIN,
  dayIndexOf,
  dayStartOf,
  daysInYear,
  localHour,
  localMonth,
  localWeekday,
  yearOfDayIndex,
  yearStartDayIndex,
} from "./time.js";

/** "bathroom", "meal", "social", "argument", "salary", or the id of a life event. */
export type BlockKind = string;
export type AwayReason = string;

export interface Block {
  kind: BlockKind;
  start: number;
  end: number;
  /** False for a life event Averey is present for: it colors the day but does not take them away. */
  away: boolean;
}

export interface DayPlan {
  dayIndex: number;
  dayStart: number;
  tired: boolean;
  /** An allergy day: only possible in the configured months. */
  allergies: boolean;
  /** A Monday after a big weekend game. */
  sports: boolean;
  /** A surprise bill landed today. */
  bill: boolean;
  coffeeDelayMs: number;
  blocks: Block[];
  salary?: { block: Block; outcome: "boost" | "drag" };
  stress: number;
}

export interface SickEpisode {
  startDay: number;
  days: number;
}

export interface SickStatus {
  sick: boolean;
  dayInEpisode?: number;
  episodeDays?: number;
}

export type Availability =
  | { available: true }
  | { available: false; reason: AwayReason; backAt: number };

const MAX_CACHED_PLANS = 64;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/**
 * Everything that is decided in advance and does not depend on what the
 * caller asks for: bad days, breaks, arguments, salary research, stress,
 * and sick episodes. Pure function of (seed, config, time).
 */
export class Schedule {
  private readonly plans = new Map<number, DayPlan>();
  private readonly episodesByYear = new Map<number, SickEpisode[]>();

  constructor(
    private readonly seed: SeedPart,
    private readonly cfg: AvereyConfig,
  ) {}

  dayIndex(ts: number): number {
    return dayIndexOf(ts, this.cfg.utcOffsetMinutes);
  }

  planAt(ts: number): DayPlan {
    return this.plan(this.dayIndex(ts));
  }

  /** Budget stress for a day, 0..1. Smooth value noise so it drifts slowly. */
  stress(dayIndex: number): number {
    const { base, amplitude, periodDays } = this.cfg.stress;
    const t = dayIndex / periodDays;
    const k = Math.floor(t);
    const f = smoothstep(t - k);
    const a = hashFloat(this.seed, "stress", k);
    const b = hashFloat(this.seed, "stress", k + 1);
    const noise = (a + (b - a) * f) * 2 - 1;
    return clamp(base + amplitude * noise, 0, 1);
  }

  plan(dayIndex: number): DayPlan {
    const cached = this.plans.get(dayIndex);
    if (cached) return cached;
    const plan = this.buildPlan(dayIndex);
    this.plans.set(dayIndex, plan);
    // Plans are pure, so evicting the oldest-inserted one only costs a rebuild.
    if (this.plans.size > MAX_CACHED_PLANS) {
      this.plans.delete(this.plans.keys().next().value!);
    }
    return plan;
  }

  private buildPlan(dayIndex: number): DayPlan {
    const cfg = this.cfg;
    const rng = rngFor(this.seed, "day", dayIndex);
    const dayStart = dayStartOf(dayIndex, cfg.utcOffsetMinutes);
    const stress = this.stress(dayIndex);

    const tired = rng.chance(cfg.tired.chancePerDay);
    // Its own rng, so adding allergies did not reshuffle any other day roll.
    const allergies =
      cfg.allergies.months.includes(localMonth(dayStart, cfg.utcOffsetMinutes)) &&
      rngFor(this.seed, "allergies", dayIndex).chance(cfg.allergies.chancePerDay);
    const coffeeDelayMs =
      Math.max(
        1,
        cfg.coffee.delayMinutes +
          rng.range(-cfg.coffee.jitterMinutes, cfg.coffee.jitterMinutes),
      ) * MIN;

    // Same idea: separate rngs, so these never reshuffle the rest of the day.
    const sports =
      localWeekday(dayStart, cfg.utcOffsetMinutes) === 1 &&
      rngFor(this.seed, "sports", dayIndex).chance(cfg.sports.chancePerWeekend);
    const bill = rngFor(this.seed, "bill", dayIndex).chance(cfg.bill.chancePerDay);

    const blocks: Block[] = [];
    const overlaps = (start: number, end: number): boolean =>
      blocks.some(
        (b) => start < b.end + 5 * MIN && end > b.start - 5 * MIN,
      );
    const lo = cfg.awakeStartHour;
    const hi = cfg.awakeEndHour;

    const place = (
      kind: BlockKind,
      durMin: number,
      options: { rng?: Rng; hours?: [number, number]; away?: boolean } = {},
    ): Block | undefined => {
      const r = options.rng ?? rng;
      const dur = durMin * MIN;
      if (dur <= 0) return undefined;
      const earliest = dayStart + Math.max(lo, options.hours?.[0] ?? lo) * HOUR;
      const latest = dayStart + Math.min(hi, options.hours?.[1] ?? hi) * HOUR - dur;
      if (latest <= earliest) return undefined;
      for (let attempt = 0; attempt < 40; attempt++) {
        const start = Math.floor(r.range(earliest, latest));
        const end = start + dur;
        if (!overlaps(start, end)) {
          const block: Block = { kind, start, end, away: options.away ?? true };
          blocks.push(block);
          return block;
        }
      }
      return undefined;
    };

    for (const meal of cfg.breaks.meals) {
      const dur =
        rng.range(meal.minutes[0], meal.minutes[1]) * MIN;
      const center =
        dayStart +
        (meal.centerHour + rng.range(-meal.jitterHours, meal.jitterHours)) *
          HOUR;
      const start = Math.floor(center - dur / 2);
      const end = Math.floor(start + dur);
      if (!overlaps(start, end)) blocks.push({ kind: "meal", start, end, away: true });
    }

    const bathroom = cfg.breaks.bathroom;
    const bathroomCount = rng.int(bathroom.count[0], bathroom.count[1]);
    for (let i = 0; i < bathroomCount; i++) {
      place("bathroom", rng.range(bathroom.minutes[0], bathroom.minutes[1]));
    }

    const social = cfg.breaks.social;
    const socialCount = rng.int(social.count[0], social.count[1]);
    for (let i = 0; i < socialCount; i++) {
      place("social", rng.range(social.minutes[0], social.minutes[1]));
    }

    place("argument", cfg.argument.minutesPerDay);

    let salary: DayPlan["salary"];
    if (rng.chance(cfg.salary.chancePerDay)) {
      const block = place("salary", cfg.salary.minutes);
      if (block) {
        const pBoost = clamp(1 - stress, 0.15, 0.85);
        salary = {
          block,
          outcome: rng.chance(pBoost) ? "boost" : "drag",
        };
      }
    }

    // Each event rolls on its own rng, so adding one never reshuffles another.
    const disabled = new Set(cfg.disabledModifiers);
    for (const event of cfg.events) {
      if (disabled.has(event.id)) continue;
      const er = rngFor(this.seed, "event", event.id, dayIndex);
      if (!er.chance(event.chancePerDay)) continue;
      const minutes = er.range(event.minutes[0], event.minutes[1]);
      const ranges = hourRangesOf(event);
      const hours = ranges.length > 1 ? er.pick(ranges) : ranges[0];
      place(event.id, minutes, { rng: er, hours, away: event.away });
    }

    blocks.sort((a, b) => a.start - b.start);
    return { dayIndex, dayStart, tired, allergies, sports, bill, coffeeDelayMs, blocks, salary, stress };
  }

  // ---- sickness ---------------------------------------------------------

  episodes(year: number): SickEpisode[] {
    const cached = this.episodesByYear.get(year);
    if (cached) return cached;
    const { episodesPerYear, minDays, maxDays } = this.cfg.sickness;
    const rng = rngFor(this.seed, "sick", year);
    const yearDays = daysInYear(year);
    const jan1 = yearStartDayIndex(year);
    const out: SickEpisode[] = [];
    for (let i = 0; i < episodesPerYear; i++) {
      for (let attempt = 0; attempt < 100; attempt++) {
        const days = rng.int(minDays, maxDays);
        const offset = rng.int(0, Math.max(0, yearDays - days));
        const startDay = jan1 + offset;
        const clear = out.every(
          (e) =>
            startDay + days + 7 <= e.startDay ||
            e.startDay + e.days + 7 <= startDay,
        );
        if (clear) {
          out.push({ startDay, days });
          break;
        }
      }
    }
    out.sort((a, b) => a.startDay - b.startDay);
    this.episodesByYear.set(year, out);
    return out;
  }

  sickAt(ts: number): SickStatus {
    const day = this.dayIndex(ts);
    const episodes = this.episodes(yearOfDayIndex(day));
    for (const e of episodes) {
      if (day >= e.startDay && day < e.startDay + e.days) {
        return {
          sick: true,
          dayInEpisode: day - e.startDay,
          episodeDays: e.days,
        };
      }
    }
    return { sick: false };
  }

  // ---- availability -----------------------------------------------------

  /** The block happening at `ts`, including life events Averey is present for. */
  blockAt(ts: number): Block | undefined {
    const plan = this.planAt(ts);
    return plan.blocks.find((b) => ts >= b.start && ts < b.end);
  }

  /** The block at `ts` that takes Averey away from their desk. */
  private awayBlockAt(ts: number): Block | undefined {
    return this.planAt(ts).blocks.find((b) => b.away && ts >= b.start && ts < b.end);
  }

  /** Whether a block of `kind` is happening at `ts`. */
  isDuring(kind: BlockKind, ts: number): boolean {
    return this.blockAt(ts)?.kind === kind;
  }

  /** Blocks of `kind` that ended within `windowMs` before `ts`. */
  recentBlocks(kind: BlockKind, ts: number, windowMs: number): Block[] {
    const day = this.dayIndex(ts);
    const out: Block[] = [];
    for (const d of [day, day - 1]) {
      for (const b of this.plan(d).blocks) {
        if (b.kind === kind && b.end <= ts && ts < b.end + windowMs) {
          out.push(b);
        }
      }
    }
    return out;
  }

  availability(ts: number): Availability {
    let t = ts;
    let firstReason: AwayReason | undefined;
    for (let i = 0; i < 24; i++) {
      const asleepUntil = this.asleepUntil(t);
      if (asleepUntil !== undefined) {
        firstReason ??= "asleep";
        t = asleepUntil;
        continue;
      }
      const block = this.awayBlockAt(t);
      if (block) {
        firstReason ??= block.kind;
        t = block.end;
        continue;
      }
      break;
    }
    if (firstReason === undefined) return { available: true };
    return { available: false, reason: firstReason, backAt: t };
  }

  private asleepUntil(ts: number): number | undefined {
    if (!this.cfg.enforceSleep) return undefined;
    const off = this.cfg.utcOffsetMinutes;
    const h = localHour(ts, off);
    const day = this.dayIndex(ts);
    if (h < this.cfg.awakeStartHour) {
      return dayStartOf(day, off) + this.cfg.awakeStartHour * HOUR;
    }
    if (h >= this.cfg.awakeEndHour) {
      return dayStartOf(day + 1, off) + this.cfg.awakeStartHour * HOUR;
    }
    return undefined;
  }
}
