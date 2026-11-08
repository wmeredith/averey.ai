import { describe, expect, it } from "vitest";
import {
  Averey,
  DEFAULT_CONFIG,
  MockProvider,
  Schedule,
  VirtualClock,
  resolveConfig,
  type LifeEventConfig,
} from "../src/index.js";
import { hourRangesOf } from "../src/config.js";
import { HOUR, MIN, dayIndexOf, localHour } from "../src/core/time.js";
import { MONDAY_9AM, makeAverey, quietConfig } from "./helpers.js";

const monday = (hour: number, minute = 0) => Date.UTC(2026, 10, 2, hour, minute);

const puzzle: LifeEventConfig = {
  id: "puzzle",
  chancePerDay: 1,
  minutes: [8, 8],
  hourRange: [10, 12],
  away: true,
  awayLines: ["Finishing a puzzle."],
};

function blockOf(averey: Averey, kind: string, at = MONDAY_9AM) {
  return averey.schedule.planAt(at).blocks.find((b) => b.kind === kind);
}

describe("life events: placement", () => {
  it("places an event inside its hour range with a duration from its range", () => {
    for (let i = 0; i < 25; i++) {
      const { averey } = makeAverey(
        { events: [{ ...puzzle, minutes: [6, 12] }] },
        { seed: `p${i}` },
      );
      const block = blockOf(averey, "puzzle")!;
      expect(block).toBeDefined();
      const h = localHour(block.start, 0);
      expect(h).toBeGreaterThanOrEqual(10);
      expect(localHour(block.end, 0)).toBeLessThanOrEqual(12);
      const minutes = (block.end - block.start) / MIN;
      expect(minutes).toBeGreaterThanOrEqual(6);
      expect(minutes).toBeLessThanOrEqual(12);
      expect(block.away).toBe(true);
    }
  });

  it("rolls its chance per day, repeatably for a seed", () => {
    const cfg = resolveConfig({ ...quietConfig({ events: [{ ...puzzle, chancePerDay: 0.5 }] }) });
    const days = (seed: string) => {
      const s = new Schedule(seed, cfg);
      const start = dayIndexOf(MONDAY_9AM, 0);
      return Array.from({ length: 40 }, (_, i) => s.plan(start + i).blocks.some((b) => b.kind === "puzzle"));
    };
    const a = days("x");
    expect(a).toEqual(days("x"));
    expect(a).toContain(true);
    expect(a).toContain(false);
  });

  it("never happens at chance 0, or when its id is disabled", () => {
    const none = makeAverey({ events: [{ ...puzzle, chancePerDay: 0 }] });
    expect(blockOf(none.averey, "puzzle")).toBeUndefined();
    const off = makeAverey({ events: [puzzle], disabledModifiers: ["puzzle"] });
    expect(blockOf(off.averey, "puzzle")).toBeUndefined();
  });

  it("gives each event its own rolls, and leaves the built-in breaks alone", () => {
    const other: LifeEventConfig = { ...puzzle, id: "package", hourRange: [14, 16] };
    const base = { breaks: { bathroom: { count: [4, 4] as [number, number] }, social: { count: [3, 3] as [number, number] } } };
    const solo = makeAverey({ ...base, events: [puzzle] }, { seed: "same" });
    const pair = makeAverey({ ...base, events: [other, puzzle] }, { seed: "same" });
    const none = makeAverey({ ...base, events: [] }, { seed: "same" });
    expect(blockOf(pair.averey, "puzzle")).toEqual(blockOf(solo.averey, "puzzle"));
    const builtins = (a: Averey) =>
      a.schedule.planAt(MONDAY_9AM).blocks.filter((b) => !["puzzle", "package"].includes(b.kind));
    expect(builtins(solo.averey)).toEqual(builtins(none.averey));
    expect(builtins(pair.averey)).toEqual(builtins(none.averey));
  });

  it("never overlaps anything else on a busy default day", () => {
    const s = new Schedule("busy", resolveConfig({ utcOffsetMinutes: 0 }));
    const start = dayIndexOf(MONDAY_9AM, 0);
    let events = 0;
    for (let d = 0; d < 60; d++) {
      const blocks = s.plan(start + d).blocks;
      events += blocks.filter((b) => b.kind === "games").length;
      for (let i = 1; i < blocks.length; i++) {
        expect(blocks[i]!.start).toBeGreaterThanOrEqual(blocks[i - 1]!.end);
      }
    }
    expect(events).toBeGreaterThan(10);
  });
});

describe("life events: away", () => {
  it("makes Averey unavailable with the event's own line and a return time", async () => {
    const { averey, clock, provider } = makeAverey({ events: [puzzle] });
    const block = blockOf(averey, "puzzle")!;
    clock.set(block.start + MIN);
    const r = await averey.run({ task: "do a thing" });
    expect(r.status).toBe("away");
    if (r.status !== "away") return;
    expect(r.reason).toBe("puzzle");
    expect(r.backAt).toBe(block.end);
    expect(r.message).toMatch(/^Finishing a puzzle\. Back around /);
    expect(provider.requests).toHaveLength(0);
    clock.set(block.end);
    expect((await averey.run({ task: "do a thing" })).status).toBe("ok");
  });

  it("falls back to a generic line when an event has none", async () => {
    const { awayLines: _, ...bare } = puzzle;
    const { averey, clock } = makeAverey({ events: [bare] });
    clock.set(blockOf(averey, "puzzle")!.start + MIN);
    const r = await averey.run({ task: "x" });
    expect(r.status === "away" && r.message).toMatch(/Back around/);
  });

  it("is not fooled by an event id that looks like an object property", async () => {
    const { averey, clock } = makeAverey({ events: [{ ...puzzle, id: "constructor", awayLines: undefined }] });
    clock.set(blockOf(averey, "constructor")!.start + MIN);
    const r = await averey.run({ task: "x" });
    expect(r.status === "away" && r.message).toMatch(/Back around/);
  });

  it("ships a morning puzzle break by default", async () => {
    const provider = new MockProvider();
    const clock = new VirtualClock(MONDAY_9AM);
    const averey = new Averey({ provider, clock, config: { utcOffsetMinutes: 0 }, seed: "games" });
    let found: ReturnType<typeof blockOf>;
    for (let d = 0; d < 30 && !found; d++) {
      found = averey.schedule.planAt(MONDAY_9AM + d * 24 * HOUR).blocks.find((b) => b.kind === "games");
      if (found) clock.set(found.start + MIN);
    }
    expect(found).toBeDefined();
    const r = await averey.run({ task: "hi" });
    expect(r.status === "away" && r.reason).toBe("games");
    expect(r.status === "away" && r.message).toMatch(/puzzle|phone thing/);
    expect(localHour(found!.start, 0)).toBeGreaterThanOrEqual(8);
    expect(localHour(found!.end, 0)).toBeLessThanOrEqual(10.5);
  });
});

describe("life events: effects", () => {
  const sso: LifeEventConfig = {
    id: "sso",
    label: "locked out of SSO",
    chancePerDay: 1,
    minutes: [10, 10],
    hourRange: [10, 12],
    away: true,
    aftermathMinutes: 30,
    multiplier: 0.9,
    hint: "You just fought with the login screen and you are still fuming.",
  };

  it("applies an aftermath after an away event, then lets go", async () => {
    const { averey, clock } = makeAverey({ events: [sso] });
    const block = blockOf(averey, "sso")!;
    clock.set(block.start + MIN);
    expect(averey.status().modifiers.map((m) => m.id)).not.toContain("sso");
    clock.set(block.end + MIN);
    const mod = averey.status().modifiers.find((m) => m.id === "sso");
    expect(mod?.multiplier).toBe(0.9);
    expect(mod?.label).toBe("locked out of SSO (aftermath)");
    expect(averey.status().performance).toBeCloseTo(0.9, 5);
    const r = await averey.run({ task: "do a thing" });
    expect(r.status === "ok" && r.trace.systemPrompt).toContain("fought with the login screen");
    clock.set(block.end + 31 * MIN);
    expect(averey.status().modifiers.map((m) => m.id)).not.toContain("sso");
  });

  const fish: LifeEventConfig = {
    id: "fish",
    label: "someone microwaved fish",
    chancePerDay: 1,
    minutes: [30, 30],
    hourRange: [13, 15],
    away: false,
    multiplier: 0.95,
    hint: "Someone microwaved fish and you are in a terrible mood.",
  };

  it("lets a present event color the day without taking Averey away", async () => {
    const { averey, clock } = makeAverey({ events: [fish] });
    const block = blockOf(averey, "fish")!;
    expect(block.away).toBe(false);
    clock.set(block.start + 5 * MIN);
    expect(averey.availability()).toEqual({ available: true });
    const mod = averey.status().modifiers.find((m) => m.id === "fish");
    expect(mod?.label).toBe("someone microwaved fish");
    const r = await averey.run({ task: "do a thing", effortMinutes: 1 });
    expect(r.status).toBe("ok");
    expect(r.status === "ok" && r.trace.systemPrompt).toContain("microwaved fish");
  });

  it("stops a present event when it ends, if it has no aftermath", () => {
    const { averey, clock } = makeAverey({ events: [fish] });
    clock.set(blockOf(averey, "fish")!.end + MIN);
    expect(averey.status().modifiers.map((m) => m.id)).not.toContain("fish");
  });

  it("an event with no effect adds no modifier", () => {
    const { averey, clock } = makeAverey({ events: [puzzle] });
    const block = blockOf(averey, "puzzle")!;
    clock.set(block.end + MIN);
    expect(averey.status().modifiers).toEqual([]);
  });

  it("can have its effect switched off by id", () => {
    const { averey, clock } = makeAverey({
      events: [sso],
      disabledModifiers: ["stress", "pissy", "sso"],
    });
    expect(blockOf(averey, "sso")).toBeUndefined(); // not even placed
    clock.set(monday(11));
    expect(averey.status().modifiers).toEqual([]);
  });
});

describe("life events: config checks", () => {
  const bad = (events: unknown[]) => () =>
    resolveConfig({ events: events as LifeEventConfig[] });

  it("rejects ids that reuse a built-in break or each other", () => {
    expect(bad([{ ...puzzle, id: "meal" }])).toThrow(/already a built-in break/);
    expect(bad([{ ...puzzle, id: "asleep" }])).toThrow(/already a built-in break/);
    expect(bad([puzzle, puzzle])).toThrow(/used twice/);
    expect(bad([{ ...puzzle, id: " " }])).toThrow(/non-empty/);
  });

  it("rejects impossible numbers", () => {
    expect(bad([{ ...puzzle, chancePerDay: 2 }])).toThrow(/chancePerDay/);
    expect(bad([{ ...puzzle, minutes: [9, 3] }])).toThrow(/minutes/);
    expect(bad([{ ...puzzle, hourRange: [12, 10] }])).toThrow(/hourRange/);
    expect(bad([{ ...puzzle, hourRange: [20, 26] }])).toThrow(/within 0\.\.24/);
    expect(bad([{ ...puzzle, aftermathMinutes: -1 }])).toThrow(/aftermathMinutes/);
  });

  it("rejects an event id that clashes with a modifier", () => {
    expect(() => makeAverey({ events: [{ ...puzzle, id: "friday" }] })).toThrow(
      /clashes with a modifier/,
    );
  });

  it("accepts event ids in disabledModifiers and rejects typos", () => {
    expect(() => makeAverey({ events: [puzzle], disabledModifiers: ["puzzle"] })).not.toThrow();
    expect(() => makeAverey({ events: [puzzle], disabledModifiers: ["puzle"] })).toThrow(
      /Unknown modifier id.*puzle/,
    );
  });

  it("replaces the default events when events is set", () => {
    expect(resolveConfig({ events: [] }).events).toEqual([]);
    expect(resolveConfig({}).events.map((e) => e.id)).toContain("games");
  });
});

describe("default office events", () => {
  const byId = (id: string) => DEFAULT_CONFIG.events.find((e) => e.id === id)!;
  const forced = (id: string): LifeEventConfig => ({ ...byId(id), chancePerDay: 1 });
  const ids = ["snack", "package", "sso", "parent-call", "hot-desk", "cake", "fish"];

  it("ships all of them next to the puzzle break", () => {
    expect(DEFAULT_CONFIG.events.map((e) => e.id)).toEqual(["games", ...ids]);
  });

  it("gives every away event lines of its own", () => {
    for (const e of DEFAULT_CONFIG.events.filter((x) => x.away)) {
      expect(e.awayLines?.length, e.id).toBeGreaterThan(0);
    }
  });

  it.each(ids)("%s lands in its window, for its duration", (id) => {
    const event = forced(id);
    const windows = hourRangesOf(event);
    for (let i = 0; i < 30; i++) {
      const { averey } = makeAverey({ events: [event] }, { seed: `${id}${i}` });
      const block = blockOf(averey, id)!;
      expect(block, `${id} seed ${i}`).toBeDefined();
      expect(block.away).toBe(event.away);
      const minutes = (block.end - block.start) / MIN;
      expect(minutes).toBeGreaterThanOrEqual(event.minutes[0] - 1e-9);
      expect(minutes).toBeLessThanOrEqual(event.minutes[1] + 1e-9);
      if (windows.length > 0) {
        const start = localHour(block.start, 0);
        const end = localHour(block.end, 0);
        expect(windows.some(([lo, hi]) => start >= lo && end <= hi), `${id} ${start}-${end}`).toBe(true);
      }
    }
  });

  it("snack happens mid-morning or mid-afternoon, never in between", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const { averey } = makeAverey({ events: [forced("snack")] }, { seed: `s${i}` });
      const h = localHour(blockOf(averey, "snack")!.start, 0);
      seen.add(h < 12 ? "morning" : "afternoon");
      expect(h < 11 || h >= 14.5).toBe(true);
    }
    expect([...seen].sort()).toEqual(["afternoon", "morning"]);
  });

  it("sso leaves Averey fuming for 45 minutes", async () => {
    const { averey, clock } = makeAverey({ events: [forced("sso")] });
    const block = blockOf(averey, "sso")!;
    clock.set(block.end + 44 * MIN);
    expect(averey.status().performance).toBeCloseTo(0.93, 5);
    const r = await averey.run({ task: "do a thing" });
    expect(r.status === "ok" && r.trace.systemPrompt).toContain("fuming at the login screen");
    clock.set(block.end + 46 * MIN);
    expect(averey.status().performance).toBeCloseTo(1, 5);
  });

  it("cake takes Averey away, then a sugar crash follows", () => {
    const { averey, clock } = makeAverey({ events: [forced("cake")] });
    const block = blockOf(averey, "cake")!;
    clock.set(block.start + MIN);
    expect(averey.availability().available).toBe(false);
    clock.set(block.end + 10 * MIN);
    const mod = averey.status().modifiers.find((m) => m.id === "cake");
    expect(mod?.multiplier).toBe(0.9);
    expect(averey.status().modifiers.find((m) => m.id === "cake")?.label).toContain("aftermath");
    clock.set(block.end + 50 * MIN);
    expect(averey.status().modifiers.map((m) => m.id)).not.toContain("cake");
  });

  it("fish keeps Averey at their desk but in a foul mood", async () => {
    const { averey, clock } = makeAverey({ events: [forced("fish")] });
    const block = blockOf(averey, "fish")!;
    clock.set(block.start + 5 * MIN);
    expect(averey.availability().available).toBe(true);
    expect(averey.status().performance).toBeCloseTo(0.96, 5);
    const r = await averey.run({ task: "do a thing", effortMinutes: 1 });
    expect(r.status === "ok" && r.trace.systemPrompt).toContain("microwaved fish");
    expect(r.status === "ok" && r.trace.systemPrompt).toContain("hostile");
  });

  it("each away event answers in its own words", async () => {
    for (const id of ["package", "parent-call", "hot-desk", "snack"]) {
      const event = forced(id);
      const { averey, clock } = makeAverey({ events: [event] });
      clock.set(blockOf(averey, id)!.start + 30_000);
      const r = await averey.run({ task: "hi" });
      expect(r.status, id).toBe("away");
      const message = r.status === "away" ? r.message : "";
      expect(event.awayLines!.some((l) => message.startsWith(l)), `${id}: ${message}`).toBe(true);
    }
  });

  it("checks every window of a multi-window hourRange", () => {
    const bad = () =>
      resolveConfig({ events: [{ ...puzzle, hourRange: [[9, 10], [12, 11]] }] });
    expect(bad).toThrow(/hourRange\[1\]/);
    expect(() => resolveConfig({ events: [{ ...puzzle, hourRange: [] }] })).not.toThrow();
  });
});
