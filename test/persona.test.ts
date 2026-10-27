import { describe, expect, it } from "vitest";
import {
  AvereyTeam,
  FileStateStore,
  Averey,
  LossyMemory,
  MockProvider,
  Rng,
  VirtualClock,
  computeLevers,
  findHardWords,
  injectTypos,
  isHardWord,
  resolveConfig,
} from "../src/index.js";
import { DAY, HOUR } from "../src/core/time.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeAverey, MONDAY_9AM, quietConfig } from "./helpers.js";

describe("comprehension", () => {
  it("flags long unfamiliar words and ignores everyday ones", () => {
    expect(isHardWord("idempotent")).toBe(true);
    expect(isHardWord("authentication")).toBe(true);
    expect(isHardWord("tomorrow")).toBe(false);
    expect(isHardWord("friend")).toBe(false);
    expect(isHardWord("cat")).toBe(false);
  });

  it("ignores code, urls, and names", () => {
    const hard = findHardWords(
      "Ask Bartholomew about `polymorphism` at https://example.com/internationalization",
      new Set(),
      5,
    );
    expect(hard).toEqual([]);
  });

  it("asks for clarification instead of working, then remembers the answer", async () => {
    const { averey, provider } = makeAverey({
      comprehension: { enabled: true, askChance: 1, maxQuestions: 1 },
    });
    const task = "Please make this function idempotent.";
    const first = await averey.run({ task });
    expect(first.status).toBe("clarification");
    expect(provider.requests).toHaveLength(0);
    if (first.status === "clarification") {
      expect(first.question).toContain("idempotent");
    }

    const second = await averey.run({
      task,
      glossary: { idempotent: "safe to run twice with the same result" },
    });
    expect(second.status).toBe("ok");
    expect(provider.requests[0]?.messages[0]?.content).toContain("safe to run twice");

    // Learned for next time, even without the glossary.
    const third = await averey.run({ task: "Is it idempotent yet?" });
    expect(third.status).toBe("ok");
  });

  it("can misread a word and works from the misreading", async () => {
    const { averey, provider } = makeAverey({
      comprehension: { enabled: true, askChance: 0, misreadChance: 1 },
    });
    const res = await averey.run({ task: "Document the authentication flow." });
    expect(res.status).toBe("ok");
    expect(res.trace.comprehension?.misread.length).toBeGreaterThan(0);
    const sent = provider.requests[0]!.messages[0]!.content;
    expect(sent).not.toContain("authentication");
  });
});

describe("levers", () => {
  const cfg = resolveConfig();
  it("gives worse performance more randomness, fewer tokens, less context", () => {
    const good = computeLevers(1, cfg, { temperature: true, maxTokens: true });
    const bad = computeLevers(0.4, cfg, { temperature: true, maxTokens: true });
    expect(bad.temperature!).toBeGreaterThan(good.temperature!);
    expect(bad.maxTokens).toBeLessThan(good.maxTokens);
    expect(bad.contextFraction).toBeLessThan(good.contextFraction);
    expect(bad.typoRate).toBeGreaterThan(good.typoRate);
  });

  it("compensates in the prompt when temperature is unsupported", () => {
    const l = computeLevers(0.5, cfg, { temperature: false, maxTokens: true });
    expect(l.temperature).toBeUndefined();
    expect(l.compensationHints.length).toBeGreaterThan(0);
  });

  it("caps temperature", () => {
    const l = computeLevers(0.05, cfg, { temperature: true, maxTokens: true });
    expect(l.temperature).toBeLessThanOrEqual(cfg.levers.maxTemperature);
  });
});

describe("run: prompt and model call", () => {
  it("applies persona, hints, and levers to the provider request", async () => {
    const { averey, provider } = makeAverey({ tired: { chancePerDay: 1 } });
    const res = await averey.run({ task: "Write a short note." });
    expect(res.status).toBe("ok");
    const req = provider.requests[0]!;
    expect(req.system).toContain("7th to 8th grade");
    expect(req.system).toContain("overtired");
    expect(req.temperature).toBeGreaterThan(0.7);
    expect(req.maxTokens).toBeLessThan(1024);
  });

  it("does not send temperature to providers that reject it", async () => {
    const provider = new MockProvider({ capabilities: { temperature: false } });
    const { averey } = makeAverey({ tired: { chancePerDay: 1 } }, { provider });
    await averey.run({ task: "Write a short note." });
    expect(provider.requests[0]!.temperature).toBeUndefined();
    expect(provider.requests[0]!.system).toContain("first idea");
  });

  it("only reads part of the context when performing badly", async () => {
    const { averey, provider } = makeAverey({ tired: { chancePerDay: 1 } });
    const context = "x".repeat(1000);
    await averey.run({ task: "Summarize.", context });
    const sent = provider.requests[0]!.messages[0]!.content;
    const xs = (sent.match(/x/g) ?? []).length;
    expect(xs).toBeLessThan(1000);
    expect(xs).toBeGreaterThan(300);
  });

  it("returns away during a break and does not call the model", async () => {
    const { averey, clock, provider } = makeAverey({
      breaks: { bathroom: { count: [4, 4], minutes: [5, 5] } },
    });
    const block = averey.schedule.planAt(clock.now()).blocks.find((b) => b.kind === "bathroom")!;
    clock.set(block.start + 60_000);
    const res = await averey.run({ task: "Hello?" });
    expect(res.status).toBe("away");
    expect(provider.requests).toHaveLength(0);
    if (res.status === "away") {
      expect(res.backAt).toBeGreaterThanOrEqual(block.end);
      expect(res.message).toMatch(/Back around/);
    }
  });

  it("runWhenAvailable waits out a break on a virtual clock", async () => {
    const { averey, clock } = makeAverey({
      breaks: { bathroom: { count: [4, 4], minutes: [5, 5] } },
    });
    const block = averey.schedule.planAt(clock.now()).blocks.find((b) => b.kind === "bathroom")!;
    clock.set(block.start + 60_000);
    const res = await averey.runWhenAvailable({ task: "Hello?" });
    expect(res.status).toBe("ok");
    expect(clock.now()).toBeGreaterThanOrEqual(block.end);
  });

  it("logs work against the 24h window", async () => {
    const { averey } = makeAverey();
    await averey.run({ task: "one", effortMinutes: 90 });
    expect(averey.status().hoursWorked24h).toBeCloseTo(1.5, 5);
  });
});

describe("typos", () => {
  it("adds none at rate 0 and some at a high rate, leaving code alone", () => {
    const text = "Please remember to restart the server after deploying.\n```\nrestart --server\n```";
    expect(injectTypos(text, 0, new Rng(1)).text).toBe(text);
    const out = injectTypos(text, 1, new Rng(1));
    expect(out.count).toBeGreaterThan(0);
    expect(out.text).toContain("```\nrestart --server\n```");
    expect(out.text).not.toBe(text);
  });
});

describe("defensiveness", () => {
  it("is defensive for 1-2 days, then apologizes once", async () => {
    const { averey, clock } = makeAverey({
      defensive: { apologyChance: 1 },
    });
    await averey.run({ task: "first" });
    const d = averey.reportError("the totals were wrong");
    expect(d.until - clock.now()).toBeGreaterThanOrEqual(24 * HOUR);
    expect(d.until - clock.now()).toBeLessThanOrEqual(48 * HOUR);

    const during = await averey.run({ task: "can you fix it" });
    expect(during.trace.modifiers.map((m) => m.id)).toContain("defensive");
    expect(during.status === "ok" && during.trace.systemPrompt).toContain("defensive");

    clock.set(d.until + HOUR);
    const after = await averey.run({ task: "how is it going" });
    expect(after.trace.modifiers.map((m) => m.id)).toContain("apology");
    expect(after.status === "ok" && after.trace.systemPrompt).toContain("apologizing");

    const later = await averey.run({ task: "and now" });
    expect(later.trace.modifiers.map((m) => m.id)).not.toContain("apology");
  });

  it("sometimes never apologizes", async () => {
    const { averey, clock } = makeAverey({ defensive: { apologyChance: 0 } });
    const d = averey.reportError("oops");
    clock.set(d.until + HOUR);
    const r = await averey.run({ task: "hi" });
    expect(r.trace.modifiers.map((m) => m.id)).not.toContain("apology");
  });
});

describe("memory", () => {
  const cfg = resolveConfig().memory;

  function recallMany(distortChanceBoost: number) {
    let distorted = 0;
    const n = 300;
    for (let i = 0; i < n; i++) {
      const items = [
        {
          id: "a",
          original: "Send 12 invoices to the client. Never send them before Friday. Use the blue template.",
          current: "Send 12 invoices to the client. Never send them before Friday. Use the blue template.",
          storedAt: 0,
          distortions: [],
        },
        { id: "b", original: "Order 4 pizzas.", current: "Order 4 pizzas.", storedAt: 0, distortions: [] },
      ];
      const mem = new LossyMemory(items, { ...cfg, baseDistortChance: distortChanceBoost });
      const r = mem.recall("a", { performance: 1, stress: 0.5, now: 0, rng: new Rng(i) })!;
      if (r.distorted) {
        distorted++;
        expect(r.recalled).not.toBe(r.original);
      } else {
        expect(r.recalled).toBe(r.original);
      }
      expect(items[0]!.original).toContain("Send 12 invoices");
    }
    return distorted / n;
  }

  it("never distorts at probability zero, always at one", () => {
    expect(recallMany(0)).toBe(0);
    // distortion probability is capped at 0.9
    expect(recallMany(1)).toBeGreaterThan(0.8);
  });

  it("recalls a distorted version and reports the discrepancy in the trace", async () => {
    const { averey, provider } = makeAverey({
      memory: { baseDistortChance: 1, maxItems: 50 },
    });
    await averey.run({
      taskId: "invoices",
      task: "Send 12 invoices to the client. Never send them before Friday.",
    });
    const res = await averey.run({
      task: "Okay, go ahead and do that.",
      continues: "invoices",
    });
    expect(res.status).toBe("ok");
    expect(res.trace.memory?.distorted).toBe(true);
    expect(res.trace.memory?.original).toContain("12 invoices");
    expect(provider.requests[1]!.messages[0]!.content).toContain(
      "What you remember about the earlier job",
    );
  });

  it("distorts more when tired", () => {
    const items = [{ id: "a", original: "x", current: "x", storedAt: 0, distortions: [] }];
    const mem = new LossyMemory(items, cfg);
    const rested = mem.distortChance(items[0]!, { performance: 1, stress: 0.5, now: 0, rng: new Rng(1) });
    const tired = mem.distortChance(items[0]!, { performance: 0.5, stress: 0.5, now: 0, rng: new Rng(1) });
    expect(tired).toBeGreaterThan(rested);
  });
});

describe("persistence", () => {
  it("survives a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "averey-"));
    try {
      const path = join(dir, "state.json");
      const clock = new VirtualClock(MONDAY_9AM);
      const make = () =>
        new Averey({
          provider: new MockProvider(),
          clock,
          seed: "persist",
          store: new FileStateStore(path),
          config: quietConfig({ disabledModifiers: ["stress", "pissy"] }),
        });
      const a = make();
      await a.run({ task: "work", effortMinutes: 120 });
      await a.receiveCompliment("good job");
      const b = make();
      expect(b.status().hoursWorked24h).toBeCloseTo(2, 5);
      expect(b.status().modifiers.map((m) => m.id)).toContain("compliment");
      clock.advance(DAY * 2);
      expect(b.status().hoursWorked24h).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("team", () => {
  function makeTeam(config = {}) {
    const clock = new VirtualClock(MONDAY_9AM);
    const mk = (seed: string) =>
      new Averey({
        provider: new MockProvider(),
        clock,
        seed,
        config: quietConfig({ disabledModifiers: ["stress", "pissy"], ...config }),
      });
    return { clock, mk };
  }

  it("spreads illness to whoever talks to a sick member", async () => {
    const { clock, mk } = makeTeam({ sickness: { episodesPerYear: 3 } });
    const sick = mk("sick-one");
    // Put the clock inside sick-one's illness and outside healthy-one's.
    const [ep] = sick.schedule.episodes(2026);
    clock.set(ep!.startDay * DAY + 10 * HOUR);
    const noEpisodes = new Averey({
      provider: new MockProvider(),
      clock,
      seed: "healthy",
      config: quietConfig({ disabledModifiers: ["stress", "pissy"], sickness: { episodesPerYear: 0 } }),
    });

    const team = new AvereyTeam().add("sick", sick).add("pat", noEpisodes);
    expect(noEpisodes.status().modifiers.map((m) => m.id)).not.toContain("exposed");
    const res = await team.send("sick", "pat", "can you review this?");
    expect(res.status).toBe("ok");
    expect(noEpisodes.status().modifiers.map((m) => m.id)).toContain("exposed");
    expect(sick.interactionPenalty()).toBe(0.9);
  });

  it("does not spread illness from a healthy member", async () => {
    const { mk } = makeTeam();
    const a = mk("a");
    const b = mk("b");
    const team = new AvereyTeam().add("a", a).add("b", b);
    await team.send("a", "b", "hello");
    expect(b.status().modifiers.map((m) => m.id)).not.toContain("exposed");
  });

  describe("implicit bias", () => {
    const profile = [{ attribute: "group", value: "B", weight: 1 }];

    async function runTeam(biasConfig: Record<string, unknown>) {
      const { mk } = makeTeam({ bias: biasConfig });
      const receiver = mk("receiver");
      const team = new AvereyTeam()
        .add("receiver", receiver)
        .addExternal("ann", { group: "A" })
        .addExternal("bo", { group: "B" });
      for (let i = 0; i < 400; i++) {
        await team.send(i % 2 ? "ann" : "bo", "receiver", `question ${i}`, { effortMinutes: 0 });
        // keep clock moving without piling up work
      }
      return team;
    }

    it("does nothing when disabled (default)", async () => {
      const team = await runTeam({ enabled: false, profile });
      for (const e of team.auditLog) {
        expect(e.rawBias).toBe(0);
      }
      const rates = Object.fromEntries(team.biasReport().map((r) => [r.group, r.secondGuessRate]));
      expect(Math.abs(rates["group=A"]! - rates["group=B"]!)).toBeLessThan(0.1);
    });

    it("creates an audited disparity when enabled, and self-correction shrinks it", async () => {
      const uncorrected = await runTeam({
        enabled: true,
        profile,
        strength: 0.4,
        selfCorrectionRate: 0,
        baselineSecondGuess: 0.1,
      });
      const corrected = await runTeam({
        enabled: true,
        profile,
        strength: 0.4,
        selfCorrectionRate: 0.75,
        baselineSecondGuess: 0.1,
      });
      const gap = (team: AvereyTeam) => {
        const r = Object.fromEntries(team.biasReport().map((x) => [x.group, x.secondGuessRate]));
        return r["group=B"]! - r["group=A"]!;
      };
      expect(gap(uncorrected)).toBeGreaterThan(0.2);
      expect(gap(corrected)).toBeLessThan(gap(uncorrected));
      const entry = corrected.auditLog.find((e) => e.labels.group === "B" && e.selfCorrected);
      expect(entry).toBeDefined();
      expect(entry!.effectiveBias).toBe(0);
    });

    it("never shows group labels to the model", async () => {
      const provider = new MockProvider();
      const receiver = new Averey({
        provider,
        clock: new VirtualClock(MONDAY_9AM),
        seed: "r",
        config: quietConfig({
          disabledModifiers: ["stress", "pissy"],
          bias: { enabled: true, profile, strength: 1, selfCorrectionRate: 0, baselineSecondGuess: 1 },
        }),
      });
      const team = new AvereyTeam().add("r", receiver).addExternal("bo", { group: "B" });
      await team.send("bo", "r", "please check this");
      const req = provider.requests[0]!;
      expect(req.system).toContain("double check");
      expect(req.system).not.toMatch(/group|\bB\b/);
      expect(JSON.stringify(req.messages)).not.toMatch(/group/);
    });
  });
});
