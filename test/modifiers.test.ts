import { describe, expect, it } from "vitest";
import { DAY, HOUR, dayIndexOf } from "../src/core/time.js";
import { Averey, InMemoryStore, MockProvider, Schedule, VirtualClock, resolveConfig } from "../src/index.js";
import { hydrate, initialState, type WorkerState } from "../src/core/state.js";
import { MONDAY_9AM, makeAverey, quietConfig } from "./helpers.js";

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

/** UTC timestamp on the week of MONDAY_9AM. `day` 0 = Monday .. 6 = Sunday. */
function weekAt(day: number, hour: number, minute = 0): number {
  return Date.UTC(2026, 10, 2 + day, hour, minute);
}

describe("post-lunch dip", () => {
  // Lunch is exactly 12:15 to 12:45.
  const lunch = {
    breaks: {
      meals: [{ centerHour: 12.5, minutes: [30, 30] as [number, number], jitterHours: 0 }],
    },
  };
  const opts = { enable: ["lunch-dip"] };

  it("hits for the window after a midday meal, then fades", () => {
    const { averey, clock } = makeAverey(lunch, opts);
    clock.set(weekAt(0, 12, 0));
    expect(perf(averey)).toBeCloseTo(1, 5); // not eaten yet
    clock.set(weekAt(0, 12, 50));
    expect(perf(averey)).toBeCloseTo(0.88, 5);
    expect(averey.status().modifiers.map((m) => m.id)).toContain("lunch-dip");
    clock.set(weekAt(0, 14, 10));
    expect(perf(averey)).toBeCloseTo(0.88, 5); // 85 minutes after
    clock.set(weekAt(0, 14, 20));
    expect(perf(averey)).toBeCloseTo(1, 5); // 95 minutes after
  });

  it("ignores meals outside the lunch hours", () => {
    const { averey, clock } = makeAverey(
      { breaks: { meals: [{ centerHour: 7.75, minutes: [20, 20], jitterHours: 0 }] } },
      opts,
    );
    clock.set(weekAt(0, 8, 10));
    expect(perf(averey)).toBeCloseTo(1, 5);
  });

  it("puts the slump in the system prompt", async () => {
    const { averey, clock } = makeAverey(lunch, opts);
    clock.set(weekAt(0, 12, 50));
    const r = await averey.run({ task: "do a thing" });
    expect(r.status === "ok" && r.trace.systemPrompt).toContain("afternoon slump");
  });

  it("can be switched off", () => {
    const { averey, clock } = makeAverey({ ...lunch, disabledModifiers: ["stress", "pissy", "lunch-dip"] });
    clock.set(weekAt(0, 12, 50));
    expect(perf(averey)).toBeCloseTo(1, 5);
  });
});

describe("Friday cliff and Monday rust", () => {
  it("drops Friday afternoon but not Friday morning", () => {
    const { averey, clock } = makeAverey({}, { enable: ["friday"] });
    clock.set(weekAt(4, 10));
    expect(perf(averey)).toBeCloseTo(1, 5);
    clock.set(weekAt(4, 14, 59));
    expect(perf(averey)).toBeCloseTo(1, 5);
    clock.set(weekAt(4, 16, 47));
    expect(perf(averey)).toBeCloseTo(0.82, 5);
    expect(averey.status().modifiers.map((m) => m.id)).toContain("friday");
  });

  it("is rusty Monday morning only", () => {
    const { averey, clock } = makeAverey({}, { enable: ["monday"] });
    clock.set(weekAt(0, 9));
    expect(perf(averey)).toBeCloseTo(0.9, 5);
    clock.set(weekAt(0, 11));
    expect(perf(averey)).toBeCloseTo(1, 5);
    clock.set(weekAt(1, 9)); // Tuesday morning
    expect(perf(averey)).toBeCloseTo(1, 5);
  });

  it("does not fire on the wrong days", () => {
    const { averey, clock } = makeAverey({}, { enable: ["friday", "monday"] });
    clock.set(weekAt(2, 16)); // Wednesday afternoon
    expect(perf(averey)).toBeCloseTo(1, 5);
    clock.set(weekAt(0, 16)); // Monday afternoon: not Friday
    expect(perf(averey)).toBeCloseTo(1, 5);
  });

  it("uses local time, not UTC", () => {
    // 21:00 UTC Friday is still 16:00 Friday at UTC-5, but 04:00 Saturday at UTC+7.
    const west = makeAverey({ utcOffsetMinutes: -300 }, { enable: ["friday"] });
    west.clock.set(weekAt(4, 21));
    expect(perf(west.averey)).toBeCloseTo(0.82, 5);
    const east = makeAverey({ utcOffsetMinutes: 420 }, { enable: ["friday"] });
    east.clock.set(weekAt(4, 21));
    expect(perf(east.averey)).toBeCloseTo(1, 5);
  });

  it("puts the mood in the prompt", async () => {
    const { averey, clock } = makeAverey({}, { enable: ["friday"] });
    clock.set(weekAt(4, 16));
    const r = await averey.run({ task: "do a thing" });
    expect(r.status === "ok" && r.trace.systemPrompt).toContain("Monday");
  });
});

describe("learned-word honeymoon", () => {
  const opts = { enable: ["honeymoon"] };
  const glossary = { idempotent: "doing it twice has the same result as once" };

  it("overuses a new word for 48 hours, then settles down", async () => {
    const { averey, clock } = makeAverey({}, opts);
    expect(averey.status().modifiers.map((m) => m.id)).not.toContain("honeymoon");
    const r = await averey.run({ task: "Explain retries.", glossary });
    expect(r.status === "ok" && r.trace.systemPrompt).toContain('"idempotent"');
    expect(r.trace.systemPrompt).toContain("even in places where it does not quite fit");

    clock.advance(47 * HOUR);
    expect(averey.status().modifiers.map((m) => m.id)).toContain("honeymoon");
    clock.advance(2 * HOUR);
    expect(averey.status().modifiers.map((m) => m.id)).not.toContain("honeymoon");
  });

  it("has no effect on performance", async () => {
    const { averey } = makeAverey({}, opts);
    await averey.run({ task: "Explain retries.", glossary });
    expect(averey.status().modifiers.find((m) => m.id === "honeymoon")?.multiplier).toBe(1);
  });

  it("lists several words, newest first, in plural form", async () => {
    const { averey, clock } = makeAverey({}, opts);
    await averey.run({ task: "one", glossary: { alpha: "a letter" } });
    clock.advanceMinutes(30);
    const r = await averey.run({ task: "two", glossary: { beta: "another letter" } });
    const mod = averey.status().modifiers.find((m) => m.id === "honeymoon");
    expect(mod?.label).toBe('just learned "beta", "alpha"');
    expect(r.status === "ok" && r.trace.systemPrompt).toContain('what "beta", "alpha" mean');
  });

  it("does not restart the clock when the same glossary is passed again", async () => {
    const { averey, clock } = makeAverey({}, opts);
    await averey.run({ task: "one", glossary });
    clock.advance(40 * HOUR);
    await averey.run({ task: "two", glossary });
    clock.advance(10 * HOUR);
    expect(averey.status().modifiers.map((m) => m.id)).not.toContain("honeymoon");
  });

  it("restarts the clock when a word gets a new meaning", async () => {
    const { averey, clock } = makeAverey({}, opts);
    await averey.run({ task: "one", glossary });
    clock.advance(40 * HOUR);
    await averey.run({ task: "two", glossary: { idempotent: "safe to repeat" } });
    clock.advance(10 * HOUR);
    expect(averey.status().modifiers.map((m) => m.id)).toContain("honeymoon");
  });

  it("loads old saved state where words were plain strings, as long ago", () => {
    const store = new InMemoryStore();
    store.save({ ...initialState(), learnedWords: { lunch: "midday meal" } } as unknown as WorkerState);
    const averey = new Averey({
      provider: new MockProvider(),
      clock: new VirtualClock(MONDAY_9AM),
      config: quietConfig({}, ["honeymoon"]),
      store,
    });
    expect(averey.snapshot().learnedWords.lunch).toEqual({ meaning: "midday meal", at: 0 });
    expect(averey.status().modifiers.map((m) => m.id)).not.toContain("honeymoon");
  });

  it("drops malformed saved words instead of crashing", () => {
    const state = hydrate({ learnedWords: { ok: { meaning: "fine", at: 5 }, bad: 7, worse: null } } as never);
    expect(Object.keys(state.learnedWords)).toEqual(["ok"]);
  });
});

describe("coffee crash", () => {
  const opts = { enable: ["coffee-crash"] };
  const cfg = { coffee: { jitterMinutes: 0 }, defaultEffortMinutes: 1 };

  it("slumps starting 90 minutes after the coffee kicks in, for 45 minutes", async () => {
    const { averey, clock } = makeAverey(cfg, opts);
    clock.set(weekAt(0, 9));
    await averey.run({ task: "hello" }); // first engagement 9:00, coffee at 9:20
    clock.set(weekAt(0, 10, 49));
    expect(perf(averey)).toBeCloseTo(1, 5);
    clock.set(weekAt(0, 10, 50));
    expect(perf(averey)).toBeCloseTo(0.9, 5);
    expect(averey.status().modifiers.map((m) => m.id)).toContain("coffee-crash");
    clock.set(weekAt(0, 11, 34));
    expect(perf(averey)).toBeCloseTo(0.9, 5);
    clock.set(weekAt(0, 11, 35));
    expect(perf(averey)).toBeCloseTo(1, 5);
  });

  it("does not exist before anyone has engaged for the day", () => {
    const { averey, clock } = makeAverey(cfg, opts);
    clock.set(weekAt(0, 11, 0));
    expect(perf(averey)).toBeCloseTo(1, 5);
  });

  it("follows the pissy phase and never overlaps it", async () => {
    const { averey, clock } = makeAverey(cfg, { enable: ["coffee-crash", "pissy"] });
    clock.set(weekAt(0, 9));
    const r = await averey.run({ task: "hello" });
    expect(r.trace.modifiers.map((m) => m.id)).toEqual(["pissy"]);
    clock.set(weekAt(0, 11, 0));
    expect(averey.status().modifiers.map((m) => m.id)).toEqual(["coffee-crash"]);
  });

  it("starts over on a new day", async () => {
    const { averey, clock } = makeAverey(cfg, opts);
    clock.set(weekAt(0, 9));
    await averey.run({ task: "day one" });
    clock.set(weekAt(1, 11, 0)); // would be mid-crash if it carried over
    expect(perf(averey)).toBeCloseTo(1, 5);
  });
});

describe("hangry", () => {
  const opts = { enable: ["hangry"] };
  // Lunch is exactly 12:15 to 12:45.
  const lunch = {
    breaks: {
      meals: [{ centerHour: 12.5, minutes: [30, 30] as [number, number], jitterHours: 0 }],
    },
  };

  it("is irritable in the hour before lunch only", () => {
    const { averey, clock } = makeAverey(lunch, opts);
    clock.set(weekAt(0, 11, 10));
    expect(perf(averey)).toBeCloseTo(1, 5); // 65 minutes out
    clock.set(weekAt(0, 11, 20));
    expect(perf(averey)).toBeCloseTo(0.93, 5);
    expect(averey.status().modifiers.map((m) => m.id)).toContain("hangry");
    clock.set(weekAt(0, 12, 14));
    expect(perf(averey)).toBeCloseTo(0.93, 5);
    clock.set(weekAt(0, 12, 50)); // fed
    expect(perf(averey)).toBeCloseTo(1, 5);
  });

  it("ignores breakfast and dinner", () => {
    const { averey, clock } = makeAverey(
      {
        breaks: {
          meals: [
            { centerHour: 7.75, minutes: [20, 20], jitterHours: 0 },
            { centerHour: 18.5, minutes: [30, 30], jitterHours: 0 },
          ],
        },
      },
      opts,
    );
    clock.set(weekAt(0, 7, 20));
    expect(perf(averey)).toBeCloseTo(1, 5);
    clock.set(weekAt(0, 17, 55));
    expect(perf(averey)).toBeCloseTo(1, 5);
  });

  it("does nothing when there is no lunch to wait for", () => {
    const { averey, clock } = makeAverey({}, opts);
    clock.set(weekAt(0, 12, 0));
    expect(perf(averey)).toBeCloseTo(1, 5);
  });
});

describe("rushing at the end of the day", () => {
  const opts = { enable: ["eod-rush"] };

  it("ramps down from 4:30 to 6 PM and stays there", () => {
    const { averey, clock } = makeAverey({}, opts);
    clock.set(weekAt(1, 16, 29));
    expect(perf(averey)).toBeCloseTo(1, 5);
    clock.set(weekAt(1, 16, 30));
    expect(perf(averey)).toBeCloseTo(1, 5);
    clock.set(weekAt(1, 17, 15));
    expect(perf(averey)).toBeCloseTo(0.925, 5);
    clock.set(weekAt(1, 18, 0));
    expect(perf(averey)).toBeCloseTo(0.85, 5);
    clock.set(weekAt(1, 20, 0));
    expect(perf(averey)).toBeCloseTo(0.85, 5);
  });

  it("is a different thing from the Friday cliff and can be switched off alone", () => {
    const { averey, clock } = makeAverey({}, { enable: ["eod-rush", "friday"] });
    clock.set(weekAt(4, 18, 0));
    expect(averey.status().modifiers.map((m) => m.id).sort()).toEqual(["eod-rush", "friday"]);
    expect(perf(averey)).toBeCloseTo(0.85 * 0.82, 5);
  });

  it("puts the hurry in the prompt", async () => {
    const { averey, clock } = makeAverey({}, opts);
    clock.set(weekAt(1, 17, 45));
    const r = await averey.run({ task: "do a thing" });
    expect(r.status === "ok" && r.trace.systemPrompt).toContain("watching the clock");
  });
});

describe("seasonal gloom", () => {
  const opts = { enable: ["seasonal"] };

  it("applies in winter months only", () => {
    const { averey, clock } = makeAverey({}, opts);
    clock.set(Date.UTC(2026, 10, 10, 12)); // November
    expect(perf(averey)).toBeCloseTo(0.95, 5);
    clock.set(Date.UTC(2027, 0, 10, 12)); // January
    expect(perf(averey)).toBeCloseTo(0.95, 5);
    clock.set(Date.UTC(2027, 2, 10, 12)); // March
    expect(perf(averey)).toBeCloseTo(1, 5);
    clock.set(Date.UTC(2027, 6, 10, 12)); // July
    expect(perf(averey)).toBeCloseTo(1, 5);
  });

  it("uses local months, so southern hemisphere callers can flip it", () => {
    // 02:00 UTC on March 1 is still February at UTC-5.
    const ts = Date.UTC(2027, 2, 1, 2);
    const west = makeAverey({ utcOffsetMinutes: -300 }, opts);
    west.clock.set(ts);
    expect(perf(west.averey)).toBeCloseTo(0.95, 5);
    const utc = makeAverey({}, opts);
    utc.clock.set(ts);
    expect(perf(utc.averey)).toBeCloseTo(1, 5);
    const south = makeAverey({ seasonal: { months: [5, 6, 7, 8] } }, opts);
    south.clock.set(Date.UTC(2027, 5, 10, 12));
    expect(perf(south.averey)).toBeCloseTo(0.95, 5);
  });

  it("rejects months that are not 1 to 12", () => {
    expect(() => resolveConfig({ seasonal: { months: [0, 13] } })).toThrow(/seasonal\.months/);
    expect(() => resolveConfig({ allergies: { months: [3.5] } })).toThrow(/allergies\.months/);
  });
});

describe("allergy season", () => {
  const opts = { enable: ["allergies"] };

  it("hits on rolled days in the configured months", () => {
    const { averey, clock } = makeAverey({ allergies: { chancePerDay: 1 } }, opts);
    clock.set(Date.UTC(2027, 3, 14, 10)); // April
    expect(perf(averey)).toBeCloseTo(0.9, 5);
    expect(averey.status().modifiers.map((m) => m.id)).toContain("allergies");
  });

  it("never happens outside the months, or at chance 0", () => {
    const { averey, clock } = makeAverey({ allergies: { chancePerDay: 1 } }, opts);
    clock.set(Date.UTC(2026, 10, 10, 10)); // November
    expect(perf(averey)).toBeCloseTo(1, 5);
    const none = makeAverey({ allergies: { chancePerDay: 0 } }, opts);
    none.clock.set(Date.UTC(2027, 3, 14, 10));
    expect(perf(none.averey)).toBeCloseTo(1, 5);
  });

  it("is a seeded mix of good and bad days that repeats for a seed", () => {
    const days = (seed: string) => {
      const s = new Schedule(seed, resolveConfig({ utcOffsetMinutes: 0 }));
      const start = dayIndexOf(Date.UTC(2027, 3, 1), 0);
      return Array.from({ length: 30 }, (_, i) => s.plan(start + i).allergies);
    };
    const a = days("alice");
    expect(a).toEqual(days("alice"));
    expect(a).toContain(true);
    expect(a).toContain(false);
    expect(days("bob")).not.toEqual(a);
  });

  it("did not reshuffle any other part of the day's plan", () => {
    const base = resolveConfig({ utcOffsetMinutes: 0, allergies: { chancePerDay: 0 } });
    const full = resolveConfig({ utcOffsetMinutes: 0, allergies: { chancePerDay: 1 } });
    const day = dayIndexOf(Date.UTC(2027, 3, 14), 0);
    const a = new Schedule("seed", base).plan(day);
    const b = new Schedule("seed", full).plan(day);
    expect(a.allergies).toBe(false);
    expect(b.allergies).toBe(true);
    expect({ ...b, allergies: false }).toEqual(a);
  });
});

describe("sports hangover", () => {
  const opts = { enable: ["sports"] };

  it("makes Monday morning rough after a big game, and only Monday morning", () => {
    const { averey, clock } = makeAverey({ sports: { chancePerWeekend: 1 } }, opts);
    clock.set(weekAt(0, 9));
    expect(perf(averey)).toBeCloseTo(0.88, 5);
    expect(averey.status().modifiers.map((m) => m.id)).toContain("sports");
    clock.set(weekAt(0, 12)); // noon: recovered
    expect(perf(averey)).toBeCloseTo(1, 5);
    clock.set(weekAt(1, 9)); // Tuesday
    expect(perf(averey)).toBeCloseTo(1, 5);
    clock.set(weekAt(5, 9)); // Saturday
    expect(perf(averey)).toBeCloseTo(1, 5);
  });

  it("is a seeded coin flip per weekend, not every one", () => {
    const mondays = (seed: string) => {
      const s = new Schedule(seed, resolveConfig({ utcOffsetMinutes: 0 }));
      const first = dayIndexOf(MONDAY_9AM, 0);
      return Array.from({ length: 40 }, (_, w) => s.plan(first + w * 7).sports);
    };
    const a = mondays("fan");
    expect(a).toEqual(mondays("fan"));
    expect(a).toContain(true);
    expect(a).toContain(false);
  });

  it("never at chance 0, and never on other weekdays even at chance 1", () => {
    const none = makeAverey({ sports: { chancePerWeekend: 0 } }, opts);
    none.clock.set(weekAt(0, 9));
    expect(perf(none.averey)).toBeCloseTo(1, 5);
    const s = new Schedule("x", resolveConfig({ utcOffsetMinutes: 0, sports: { chancePerWeekend: 1 } }));
    const first = dayIndexOf(MONDAY_9AM, 0);
    expect([0, 1, 2, 3, 4, 5, 6].map((i) => s.plan(first + i).sports)).toEqual([
      true, false, false, false, false, false, false,
    ]);
  });

  it("puts the hangover in the prompt", async () => {
    const { averey, clock } = makeAverey({ sports: { chancePerWeekend: 1 } }, opts);
    clock.set(weekAt(0, 9));
    const r = await averey.run({ task: "do a thing" });
    expect(r.status === "ok" && r.trace.systemPrompt).toContain("the big game");
  });
});

describe("daylight saving Monday", () => {
  const opts = { enable: ["dst"] };

  it("is an hour off the Monday after the US fall back, then fine", () => {
    const { averey, clock } = makeAverey({}, opts);
    clock.set(weekAt(0, 9)); // Mon 2026-11-02, day after the Nov 1 switch
    expect(perf(averey)).toBeCloseTo(0.92, 5);
    expect(averey.status().modifiers.map((m) => m.id)).toContain("dst");
    clock.set(weekAt(1, 9)); // Tuesday
    expect(perf(averey)).toBeCloseTo(1, 5);
    clock.set(weekAt(7, 9)); // the next Monday
    expect(perf(averey)).toBeCloseTo(1, 5);
  });

  it("hits the US spring forward Monday too", () => {
    const { averey, clock } = makeAverey({}, opts);
    clock.set(Date.UTC(2027, 2, 15, 9)); // second Sunday of March 2027 is the 14th
    expect(perf(averey)).toBeCloseTo(0.92, 5);
    clock.set(Date.UTC(2027, 2, 8, 9)); // first Monday of March
    expect(perf(averey)).toBeCloseTo(1, 5);
  });

  it("follows EU dates when asked", () => {
    const { averey, clock } = makeAverey({ dst: { region: "EU" } }, opts);
    clock.set(Date.UTC(2026, 9, 26, 9)); // last Sunday of October is the 25th
    expect(perf(averey)).toBeCloseTo(0.92, 5);
    clock.set(weekAt(0, 9)); // US date, not EU
    expect(perf(averey)).toBeCloseTo(1, 5);
  });

  it("can be disabled in config, and rejects an unknown region", () => {
    const off = makeAverey({ dst: { enabled: false } }, opts);
    off.clock.set(weekAt(0, 9));
    expect(perf(off.averey)).toBeCloseTo(1, 5);
    expect(() => resolveConfig({ dst: { region: "MARS" as never } })).toThrow(/dst\.region/);
  });

  it("never moves Averey's clock", async () => {
    const { averey, clock } = makeAverey({}, opts);
    clock.set(weekAt(0, 9));
    const before = clock.now();
    await averey.run({ task: "x", effortMinutes: 1 });
    expect(clock.now() - before).toBe(60_000);
  });
});
