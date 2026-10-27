import { describe, expect, it } from "vitest";
import {
  Rng,
  Schedule,
  VirtualClock,
  resolveConfig,
  rngFor,
} from "../src/index.js";
import { DAY, HOUR, dayIndexOf, yearStartDayIndex } from "../src/core/time.js";

describe("rng", () => {
  it("is deterministic for a seed", () => {
    const a = new Rng("x");
    const b = new Rng("x");
    expect([a.next(), a.next(), a.next()]).toEqual([b.next(), b.next(), b.next()]);
  });

  it("differs across keys", () => {
    expect(rngFor("s", 1).next()).not.toBe(rngFor("s", 2).next());
  });

  it("int is inclusive", () => {
    const r = new Rng(1);
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) seen.add(r.int(1, 3));
    expect([...seen].sort()).toEqual([1, 2, 3]);
  });
});

describe("virtual clock", () => {
  it("advances", () => {
    const c = new VirtualClock(0);
    c.advanceMinutes(90);
    expect(c.now()).toBe(90 * 60_000);
  });
});

describe("schedule", () => {
  const cfg = resolveConfig({ utcOffsetMinutes: 0 });

  it("plans the same day identically for the same seed", () => {
    const a = new Schedule("seed", cfg);
    const b = new Schedule("seed", cfg);
    expect(a.plan(20000)).toEqual(b.plan(20000));
  });

  it("never overlaps blocks", () => {
    const s = new Schedule("seed", cfg);
    for (let d = 20000; d < 20100; d++) {
      const blocks = s.plan(d).blocks;
      for (let i = 1; i < blocks.length; i++) {
        expect(blocks[i]!.start).toBeGreaterThanOrEqual(blocks[i - 1]!.end);
      }
    }
  });

  it("schedules three sick episodes of 3-6 days, separated", () => {
    for (const seed of ["a", "b", "c", "d", "e"]) {
      const s = new Schedule(seed, cfg);
      const eps = s.episodes(2026);
      expect(eps).toHaveLength(3);
      for (const e of eps) {
        expect(e.days).toBeGreaterThanOrEqual(3);
        expect(e.days).toBeLessThanOrEqual(6);
      }
      for (let i = 1; i < eps.length; i++) {
        expect(eps[i]!.startDay).toBeGreaterThan(eps[i - 1]!.startDay + eps[i - 1]!.days);
      }
    }
  });

  it("reports sickness only inside an episode", () => {
    const s = new Schedule("seed", cfg);
    const [first] = s.episodes(2026);
    const startTs = first!.startDay * DAY + 12 * HOUR;
    expect(s.sickAt(startTs).sick).toBe(true);
    expect(s.sickAt(startTs + first!.days * DAY).sick).toBe(false);
    expect(dayIndexOf(startTs, 0)).toBeGreaterThanOrEqual(yearStartDayIndex(2026));
  });

  it("has tired days at roughly the configured rate", () => {
    const s = new Schedule("tired", resolveConfig({ utcOffsetMinutes: 0 }));
    let tired = 0;
    const n = 2000;
    for (let d = 0; d < n; d++) if (s.plan(20000 + d).tired) tired++;
    expect(tired / n).toBeGreaterThan(0.1);
    expect(tired / n).toBeLessThan(0.2);
  });

  it("schedules about 20 minutes of arguing a day", () => {
    const s = new Schedule("arg", cfg);
    const arg = s.plan(20000).blocks.find((b) => b.kind === "argument");
    expect(arg).toBeDefined();
    expect((arg!.end - arg!.start) / 60_000).toBeCloseTo(20, 5);
  });

  it("keeps stress in range and slowly drifting", () => {
    const s = new Schedule("stress", cfg);
    let maxStep = 0;
    for (let d = 20000; d < 20100; d++) {
      const v = s.stress(d);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      maxStep = Math.max(maxStep, Math.abs(v - s.stress(d + 1)));
    }
    expect(maxStep).toBeLessThan(0.3);
  });

  it("reports sleep when enforced", () => {
    const s = new Schedule("sleep", resolveConfig({ utcOffsetMinutes: 0, enforceSleep: true }));
    const day = 20000;
    const threeAm = day * DAY + 3 * HOUR;
    const avail = s.availability(threeAm);
    expect(avail.available).toBe(false);
    if (!avail.available) {
      expect(avail.reason).toBe("asleep");
      expect(avail.backAt).toBeGreaterThanOrEqual(day * DAY + 7 * HOUR);
    }
  });

  it("chains back-to-back blocks into one return time", () => {
    const s = new Schedule("chain", cfg);
    for (let d = 20000; d < 20050; d++) {
      for (const b of s.plan(d).blocks) {
        const a = s.availability(b.start + 1);
        expect(a.available).toBe(false);
        if (!a.available) {
          expect(a.backAt).toBeGreaterThanOrEqual(b.end);
          expect(s.availability(a.backAt).available).toBe(true);
        }
      }
    }
  });
});
