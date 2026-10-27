import { describe, expect, it } from "vitest";
import { DAY, HOUR } from "../src/core/time.js";
import { Schedule, resolveConfig } from "../src/index.js";
import { makeAverey } from "./helpers.js";

function perf(a: ReturnType<typeof makeAverey>["averey"]) {
  return a.status().performance;
}

describe("hours cap", () => {
  it("degrades exponentially after 8 hours of work", async () => {
    const { averey } = makeAverey({ defaultEffortMinutes: 60 });
    const values: number[] = [];
    for (let i = 0; i < 13; i++) {
      values.push(perf(averey));
      await averey.run({ task: "do a thing" });
    }
    // Each run is one hour. After 8 runs the average has worked 8h.
    for (let i = 0; i <= 8; i++) expect(values[i]).toBeCloseTo(1, 5);
    for (let i = 9; i < values.length; i++) {
      expect(values[i]).toBeLessThan(values[i - 1]!);
    }
    const k = averey.config.hours.decayK;
    expect(values[10]).toBeCloseTo(Math.exp(-k * 2), 5);
    // exponential means a constant ratio per extra hour
    const r1 = values[10]! / values[9]!;
    const r2 = values[11]! / values[10]!;
    expect(r1).toBeCloseTo(r2, 5);
  });

  it("recovers after the rolling window slides past old work", async () => {
    const { averey, clock } = makeAverey({ defaultEffortMinutes: 60 });
    for (let i = 0; i < 11; i++) await averey.run({ task: "work" });
    expect(perf(averey)).toBeLessThan(0.5);
    clock.advance(DAY);
    expect(perf(averey)).toBeCloseTo(1, 5);
  });
});

describe("tired days", () => {
  it("cuts performance by 33%", () => {
    const { averey } = makeAverey({ tired: { chancePerDay: 1 } });
    expect(perf(averey)).toBeCloseTo(0.67, 5);
  });
});

describe("coffee", () => {
  it("is pissy for about 20 minutes after first engagement, then fine", async () => {
    const { averey, clock } = makeAverey({
      coffee: { jitterMinutes: 0 },
      defaultEffortMinutes: 1,
      disabledModifiers: ["stress"],
    });
    const first = await averey.run({ task: "hello" });
    expect(first.trace.modifiers.map((m) => m.id)).toContain("pissy");
    expect(first.status === "ok" && first.trace.systemPrompt).toContain("coffee");

    clock.advanceMinutes(10);
    expect((await averey.run({ task: "hello again" })).trace.modifiers.map((m) => m.id)).toContain("pissy");

    clock.advanceMinutes(15);
    expect((await averey.run({ task: "later" })).trace.modifiers.map((m) => m.id)).not.toContain("pissy");
  });

  it("starts the clock over on a new day", async () => {
    const { averey, clock } = makeAverey({
      coffee: { jitterMinutes: 0 },
      disabledModifiers: ["stress"],
    });
    await averey.run({ task: "day one" });
    clock.advance(DAY);
    const r = await averey.run({ task: "day two" });
    expect(r.trace.modifiers.map((m) => m.id)).toContain("pissy");
  });
});

describe("compliments", () => {
  const recent = "refactored the billing report export";

  it("boosts for 24h after a plain compliment, then stops", async () => {
    const { averey, clock } = makeAverey();
    const base = perf(averey);
    const res = await averey.receiveCompliment("good job", recent);
    expect(res.sincere).toBe(false);
    expect(perf(averey)).toBeGreaterThan(base);
    clock.advanceHours(23);
    expect(perf(averey)).toBeGreaterThan(base);
    clock.advanceHours(2);
    expect(perf(averey)).toBeCloseTo(base, 5);
  });

  it("extends to 96h when sincere", async () => {
    const { averey, clock } = makeAverey();
    const base = perf(averey);
    const res = await averey.receiveCompliment(
      "I noticed you refactored the billing report export, and your fix saved me an hour today",
      recent,
    );
    expect(res.sincere).toBe(true);
    clock.advanceHours(90);
    expect(perf(averey)).toBeGreaterThan(base);
    clock.advanceHours(8);
    expect(perf(averey)).toBeCloseTo(base, 5);
  });
});

describe("sickness", () => {
  it("degrades performance during an episode only", () => {
    const { averey, clock } = makeAverey({ sickness: { episodesPerYear: 3 } });
    const [ep] = new Schedule("test", resolveConfig({ utcOffsetMinutes: 0 })).episodes(2026);
    clock.set(ep!.startDay * DAY + 10 * HOUR);
    expect(averey.isSick()).toBe(true);
    expect(perf(averey)).toBeCloseTo(0.65, 5);
    clock.set((ep!.startDay + ep!.days) * DAY + 10 * HOUR);
    expect(averey.isSick()).toBe(false);
    expect(perf(averey)).toBeCloseTo(1, 5);
  });

  it("exposes others", () => {
    const { averey, clock } = makeAverey();
    expect(perf(averey)).toBeCloseTo(1, 5);
    averey.exposeToIllness();
    expect(perf(averey)).toBeCloseTo(0.9, 5);
    clock.advanceHours(25);
    expect(perf(averey)).toBeCloseTo(1, 5);
  });
});

describe("arguments and salary research", () => {
  it("drops performance 15% for the hour after the daily argument", () => {
    const { averey, clock } = makeAverey({ argument: { minutesPerDay: 20 } });
    const plan = averey.schedule.planAt(clock.now());
    const arg = plan.blocks.find((b) => b.kind === "argument")!;
    clock.set(arg.end + 1);
    expect(perf(averey)).toBeCloseTo(0.85, 5);
    clock.set(arg.end + 61 * 60_000);
    expect(perf(averey)).toBeCloseTo(1, 5);
  });

  it("salary research either boosts or drags, depending on the roll", () => {
    const outcomes = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const { averey, clock } = makeAverey(
        { salary: { chancePerDay: 1 } },
        { seed: `s${i}` },
      );
      const plan = averey.schedule.planAt(clock.now());
      if (!plan.salary) continue;
      clock.set(plan.salary.block.end + 60_000);
      const p = perf(averey);
      outcomes.add(p > 1 ? "boost" : "drag");
      expect(p).toBeCloseTo(plan.salary.outcome === "boost" ? 1.1 : 0.85, 5);
    }
    expect(outcomes.size).toBe(2);
  });
});

describe("disabling modifiers", () => {
  it("lets tests switch effects off", () => {
    const { averey } = makeAverey({
      tired: { chancePerDay: 1 },
      disabledModifiers: ["stress", "pissy", "tired"],
    });
    expect(perf(averey)).toBeCloseTo(1, 5);
  });
});
