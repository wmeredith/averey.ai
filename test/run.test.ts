import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  Averey,
  AvereyTeam,
  FileStateStore,
  InMemoryStore,
  MODIFIERS,
  MockProvider,
  VirtualClock,
  findHardWords,
  isHardWord,
  resolveConfig,
} from "../src/index.js";
import { DAY, HOUR } from "../src/core/time.js";
import { makeAverey, MONDAY_9AM, quietConfig } from "./helpers.js";

describe("run pipeline", () => {
  it("saves what Averey heard even when the model call fails", async () => {
    const store = new InMemoryStore();
    const provider = new MockProvider({
      respond: () => {
        throw new Error("network down");
      },
    });
    const averey = new Averey({
      provider,
      clock: new VirtualClock(MONDAY_9AM),
      seed: "fail",
      store,
      config: quietConfig(),
    });
    await expect(
      averey.run({ taskId: "t1", task: "Order lunch.", glossary: { lunch: "midday meal" } }),
    ).rejects.toThrow("network down");
    const saved = store.load()!;
    expect(saved.memory.map((m) => m.id)).toContain("t1");
    expect(saved.learnedWords.lunch).toBe("midday meal");
    expect(saved).toEqual(averey.snapshot());
    expect(saved.workLog).toHaveLength(0);
  });

  it("sends conversation history before the task, and the abort signal", async () => {
    const { averey, provider } = makeAverey();
    const controller = new AbortController();
    await averey.run({
      task: "And the second one?",
      history: [
        { role: "user", content: "List two colors." },
        { role: "assistant", content: "Red and blue." },
      ],
      signal: controller.signal,
    });
    const req = provider.requests[0]!;
    expect(req.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(req.messages[2]!.content).toContain("second one");
    expect(req.signal).toBe(controller.signal);
  });

  it("flags truncated replies in the trace", async () => {
    const provider = new MockProvider({ respond: () => ({ text: "Here is the st", truncated: true }) });
    const { averey } = makeAverey({}, { provider });
    const res = await averey.run({ task: "Write a long story." });
    expect(res.trace.truncated).toBe(true);
  });

  it("reads the start of long context and cuts at a word", async () => {
    const { averey, provider } = makeAverey({ tired: { chancePerDay: 1 } });
    const context = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
    await averey.run({ task: "Summarize.", context });
    const sent = provider.requests[0]!.messages[0]!.content;
    const background = sent.slice(sent.indexOf("Background:\n") + "Background:\n".length);
    expect(background.startsWith("word0 word1")).toBe(true);
    expect(background).toMatch(/word\d+ \.\.\.$/);
    expect(background).not.toContain("word199");
  });

  it("answers clarifications through runWhenAvailable", async () => {
    const { averey, provider } = makeAverey({
      comprehension: { enabled: true, askChance: 1, maxQuestions: 1 },
    });
    const asked: string[][] = [];
    const res = await averey.runWhenAvailable(
      { task: "Make the job idempotent and explain the polymorphism." },
      {
        onClarification: (_q, words) => {
          asked.push(words);
          return Object.fromEntries(words.map((w) => [w, "something simple"]));
        },
      },
    );
    expect(res.status).toBe("ok");
    expect(asked.flat().sort()).toEqual(["idempotent", "polymorphism"]);
    expect(provider.requests).toHaveLength(1);
  });

  it("hands the clarification back when the callback has no answer", async () => {
    const { averey } = makeAverey({ comprehension: { enabled: true, askChance: 1 } });
    const res = await averey.runWhenAvailable(
      { task: "Make it idempotent." },
      { onClarification: () => undefined },
    );
    expect(res.status).toBe("clarification");
  });

  it("replaces a task when its id is reused with new text", async () => {
    const { averey } = makeAverey();
    await averey.run({ taskId: "order", task: "Order 4 pizzas." });
    await averey.run({ taskId: "order", task: "Order 6 salads." });
    const res = await averey.run({ task: "Go ahead.", continues: "order" });
    expect(res.trace.memory?.original).toBe("Order 6 salads.");
    expect(averey.snapshot().memory.filter((m) => m.id === "order")).toHaveLength(1);
  });
});

describe("comprehension word list", () => {
  it("treats everyday office words as known", () => {
    for (const w of [
      "summarize", "spreadsheet", "paragraph", "calendar", "delivery", "quarterly",
      "timesheets", "friendlier", "entries", "summarizing", "scheduled",
    ]) {
      expect(isHardWord(w), w).toBe(false);
    }
    expect(isHardWord("idempotent")).toBe(true);
    expect(isHardWord("polymorphism")).toBe(true);
  });

  it("treats a capitalized word at the start of a line as a word, not a name", () => {
    expect(findHardWords("Notes:\nIdempotent retries are required.", new Set(), 5)).toContain("idempotent");
    expect(findHardWords("Ask Bartholomew today.", new Set(), 5)).toEqual([]);
  });
});

describe("modifiers and config", () => {
  it("accepts custom per-instance modifiers without touching the global registry", async () => {
    const { averey } = makeAverey();
    const custom = new Averey({
      provider: new MockProvider(),
      clock: new VirtualClock(MONDAY_9AM),
      config: quietConfig(),
      modifiers: {
        "dentist-day": () => ({ id: "dentist-day", label: "dentist at 4", multiplier: 0.8, hints: ["You have the dentist at 4."] }),
      },
    });
    expect(custom.status().performance).toBeCloseTo(0.8, 5);
    expect(averey.status().performance).toBeCloseTo(1, 5);
    expect(Object.isFrozen(MODIFIERS)).toBe(true);
    expect("dentist-day" in MODIFIERS).toBe(false);
  });

  it("rejects unknown ids in disabledModifiers", () => {
    expect(() => makeAverey({ disabledModifiers: ["tierd"] })).toThrow(/Unknown modifier id.*tierd/);
  });

  it("rejects invalid config with every problem listed", () => {
    const build = () =>
      resolveConfig({
        sickness: { minDays: 6, maxDays: 3 },
        tired: { chancePerDay: 1.5 },
      });
    expect(build).toThrow(/sickness\.minDays \(6\) must be <= sickness\.maxDays/);
    expect(build).toThrow(/tired\.chancePerDay must be between 0 and 1/);
  });
});

describe("FileStateStore", () => {
  it("warns about a corrupt file instead of silently starting over", () => {
    const dir = mkdtempSync(join(tmpdir(), "averey-"));
    try {
      const path = join(dir, "state.json");
      writeFileSync(path, "{not json");
      const warnings: string[] = [];
      const store = new FileStateStore(path, (p) => warnings.push(p));
      expect(store.load()).toBeUndefined();
      expect(warnings).toEqual([path]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes compact JSON and skips writes when nothing changed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "averey-"));
    try {
      const path = join(dir, "state.json");
      const store = new FileStateStore(path);
      const averey = new Averey({
        provider: new MockProvider(),
        clock: new VirtualClock(MONDAY_9AM),
        store,
        config: quietConfig(),
      });
      await averey.run({ task: "work" });
      expect(readFileSync(path, "utf8")).not.toContain("\n");
      const before = statSync(path).mtimeMs;
      averey.exposeToIllness(-DAY); // exposure would end at epoch 0: no state change
      expect(statSync(path).mtimeMs).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("team contagion", () => {
  it("runs both ways: a sick receiver wears down the sender", async () => {
    const clock = new VirtualClock(MONDAY_9AM);
    const sick = new Averey({
      provider: new MockProvider(),
      clock,
      seed: "sick-one",
      config: quietConfig({ sickness: { episodesPerYear: 3 } }),
    });
    const [ep] = sick.schedule.episodes(2026);
    clock.set(ep!.startDay * DAY + 10 * HOUR);
    const healthy = new Averey({ provider: new MockProvider(), clock, seed: "healthy", config: quietConfig() });

    const team = new AvereyTeam().add("sick", sick).add("pat", healthy);
    await team.send("pat", "sick", "can you look at this?");
    expect(healthy.status().modifiers.map((m) => m.id)).toContain("exposed");
  });
});
