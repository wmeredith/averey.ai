import { describe, expect, it } from "vitest";
import { Averey, InMemoryStore, MockProvider, Rng, VirtualClock } from "../src/index.js";
import { initialState, type WorkerState } from "../src/core/state.js";
import { dropConstraintDetailed } from "../src/persona/distort.js";
import { similarity } from "../src/persona/effects.js";
import { MONDAY_9AM, makeAverey, quietConfig } from "./helpers.js";

/** The text of the last user message the model was sent. */
function sentTask(provider: ReturnType<typeof makeAverey>["provider"]): string {
  const req = provider.requests.at(-1)!;
  return req.messages.at(-1)!.content;
}

function systemOf(provider: ReturnType<typeof makeAverey>["provider"]): string {
  return provider.requests.at(-1)!.system;
}

describe("dropConstraintDetailed", () => {
  it("prefers a constraint sentence and reports what it dropped", () => {
    const r = dropConstraintDetailed(
      "Write a reply. You must keep it short. Be nice.",
      new Rng("x"),
    );
    expect(r?.dropped).toBe("You must keep it short.");
    expect(r?.text).toBe("Write a reply. Be nice.");
  });

  it("with constraintsOnly never drops a plain sentence", () => {
    const r = dropConstraintDetailed("Write a reply. Be nice.", new Rng("x"), {
      constraintsOnly: true,
    });
    expect(r).toBeUndefined();
  });

  it("needs two sentences", () => {
    expect(dropConstraintDetailed("You must do it.", new Rng("x"))).toBeUndefined();
  });

  it("leaves fenced code and URLs alone", () => {
    const task = "Fix this. Never touch the port.\n```\nconst a = 1;\nconst b = 2;\n```\nSee https://example.com/a.b";
    for (let i = 0; i < 20; i++) {
      const r = dropConstraintDetailed(task, new Rng(`s${i}`), { constraintsOnly: true });
      expect(r?.text).toContain("```\nconst a = 1;\nconst b = 2;\n```");
      expect(r?.text).toContain("https://example.com/a.b");
      expect(r?.dropped).toBe("Never touch the port.");
    }
  });
});

describe("notification hangover", () => {
  const task = "Write a short reply to the customer. You must keep it under 50 words. Be friendly.";
  const on = { enable: ["notification"] };

  it("drops a rule from what Averey read and says so on the trace", async () => {
    const { averey, provider } = makeAverey({ notification: { chancePerRun: 1 } }, on);
    const r = await averey.run({ task });
    expect(r.status).toBe("ok");
    expect(sentTask(provider)).toBe("Write a short reply to the customer. Be friendly.");
    expect(r.trace.notification).toEqual({
      dropped: true,
      removed: "You must keep it under 50 words.",
    });
    expect(systemOf(provider)).toContain("phone buzzed");
  });

  it("leaves the task alone at chance 0", async () => {
    const { averey, provider } = makeAverey({ notification: { chancePerRun: 0 } }, on);
    const r = await averey.run({ task });
    expect(sentTask(provider)).toBe(task);
    expect(r.trace.notification).toBeUndefined();
    expect(systemOf(provider)).not.toContain("phone buzzed");
  });

  it("is a no-op when the task has no rule to lose", async () => {
    const { averey, provider } = makeAverey({ notification: { chancePerRun: 1 } }, on);
    const plain = "Write a short reply to the customer. Be friendly.";
    const r = await averey.run({ task: plain });
    expect(sentTask(provider)).toBe(plain);
    expect(r.trace.notification).toEqual({ dropped: false });
    expect(systemOf(provider)).not.toContain("phone buzzed");
  });

  it("is off when the id is disabled", async () => {
    const { averey, provider } = makeAverey({ notification: { chancePerRun: 1 } });
    await averey.run({ task });
    expect(sentTask(provider)).toBe(task);
  });

  it("only changes what Averey reads, not what Averey remembers", async () => {
    const { averey, provider } = makeAverey({ notification: { chancePerRun: 1 } }, on);
    const first = await averey.run({ task, taskId: "t1" });
    expect(first.status).toBe("ok");
    expect(averey.snapshot().memory[0]?.original).toBe(task);
    expect(provider.requests).toHaveLength(1);
  });

  it("is deterministic for a seed", async () => {
    const hits = async () => {
      const { averey } = makeAverey({ notification: { chancePerRun: 0.5 } }, { ...on, seed: "same" });
      const out: boolean[] = [];
      for (let i = 0; i < 12; i++) {
        const r = await averey.run({ task });
        out.push(r.trace.notification?.dropped ?? false);
      }
      return out;
    };
    const a = await hits();
    expect(a).toEqual(await hits());
    expect(a).toContain(true);
    expect(a).toContain(false);
  });

  it("rejects the id as unknown only when it really is unknown", () => {
    expect(() => makeAverey({ disabledModifiers: ["notification"] })).not.toThrow();
    expect(() => makeAverey({ disabledModifiers: ["notifcation"] })).toThrow(/Unknown modifier id/);
  });
});

describe("copy-from-last-time", () => {
  const on = { enable: ["reuse"] };
  const first = "Summarize this meeting in three bullet points for the sales team.";
  const similar = "Summarize this meeting in four bullet points for the sales team.";

  async function answered(config = {}, options: Parameters<typeof makeAverey>[1] = on) {
    const made = makeAverey(config, {
      ...options,
      provider: new MockProvider({ respond: () => "- Sales are up\n- Costs are flat\n- Hiring paused" }),
    });
    const r = await made.averey.run({ task: first, taskId: "one" });
    expect(r.status).toBe("ok");
    return made;
  }

  it("hands back the earlier answer for a similar request", async () => {
    const { averey, provider } = await answered({ reuse: { chance: 1 } });
    const r = await averey.run({ task: similar });
    expect(r.trace.reusedFrom).toBe("one");
    const sent = sentTask(provider);
    expect(sent.startsWith(similar)).toBe(true);
    expect(sent).toContain("already wrote something for a similar request");
    expect(sent).toContain("- Sales are up");
  });

  it("does not reuse for an unrelated request", async () => {
    const { averey, provider } = await answered({ reuse: { chance: 1 } });
    const r = await averey.run({ task: "Draft an email asking everyone for their timesheets." });
    expect(r.trace.reusedFrom).toBeUndefined();
    expect(sentTask(provider)).not.toContain("Sales are up");
  });

  it("skips a similar request when the roll fails", async () => {
    const { averey, provider } = await answered({ reuse: { chance: 0 } });
    const r = await averey.run({ task: similar });
    expect(r.trace.reusedFrom).toBeUndefined();
    expect(sentTask(provider)).toBe(similar);
  });

  it("always reuses the task it continues, even if it looks different", async () => {
    const { averey, provider } = await answered({ reuse: { chance: 0 } });
    const r = await averey.run({ task: "Now make it funnier.", continues: "one" });
    expect(r.trace.reusedFrom).toBe("one");
    expect(sentTask(provider)).toContain("already wrote something for an earlier request");
    expect(sentTask(provider)).toContain("- Sales are up");
  });

  it("keeps only the last few jobs", async () => {
    const { averey } = makeAverey({ reuse: { maxItems: 2 } }, on);
    for (let i = 0; i < 4; i++) await averey.run({ task: `Unique job number ${i} about topic${i}`, taskId: `t${i}` });
    expect(averey.snapshot().recentWork.map((w) => w.id)).toEqual(["t2", "t3"]);
  });

  it("does not remember jobs that did not finish", async () => {
    const { averey } = makeAverey(
      { comprehension: { enabled: true, askChance: 1, maxQuestions: 1 } },
      on,
    );
    const r = await averey.run({ task: "Please optimize the authentication infrastructure documentation." });
    expect(r.status).toBe("clarification");
    expect(averey.snapshot().recentWork).toEqual([]);
  });

  it("loads old saved state that has no recentWork", async () => {
    const store = new InMemoryStore();
    const old = { ...initialState() } as Partial<WorkerState>;
    delete old.recentWork;
    store.save(old as WorkerState);
    const averey = new Averey({
      provider: new MockProvider(),
      clock: new VirtualClock(MONDAY_9AM),
      config: quietConfig({}, ["reuse"]),
      store,
    });
    expect(averey.snapshot().recentWork).toEqual([]);
    expect((await averey.run({ task: first })).status).toBe("ok");
    expect(averey.snapshot().recentWork).toHaveLength(1);
  });

  it("scores word overlap", () => {
    expect(similarity(first, first)).toBe(1);
    expect(similarity(first, similar)).toBeGreaterThan(0.5);
    expect(similarity(first, "Draft an email about timesheets")).toBeLessThan(0.2);
    expect(similarity("", first)).toBe(0);
  });
});

describe("easy-task confidence", () => {
  const on = { enable: ["overconfident"] };

  it("goes with its first answer on a short, plain request", async () => {
    const { averey, provider } = makeAverey({}, on);
    const r = await averey.run({ task: "Write a short thank you note to Sam." });
    expect(r.trace.overconfident).toBe(true);
    expect(systemOf(provider)).toContain("looks easy to you");
  });

  it("does not fire on a long request", async () => {
    const { averey } = makeAverey({}, on);
    const long = `Write a note. ${"Please keep it friendly and short. ".repeat(6)}`;
    const r = await averey.run({ task: long });
    expect(r.trace.overconfident).toBeUndefined();
  });

  it("does not fire when something in it is hard", async () => {
    const { averey } = makeAverey({}, on);
    const r = await averey.run({ task: "Explain idempotent retries." });
    expect(r.trace.overconfident).toBeUndefined();
  });

  it("treats a word it has been taught as plain", async () => {
    const { averey } = makeAverey({}, on);
    const r = await averey.run({
      task: "Explain idempotent retries.",
      glossary: { idempotent: "safe to repeat" },
    });
    expect(r.trace.overconfident).toBe(true);
  });

  it("respects the size limit from config", async () => {
    const { averey } = makeAverey({ competence: { easyMaxWords: 3 } }, on);
    expect((await averey.run({ task: "Write a thank you note." })).trace.overconfident).toBeUndefined();
    expect((await averey.run({ task: "Say hi." })).trace.overconfident).toBe(true);
  });
});

describe("imposter vocabulary", () => {
  const on = { enable: ["imposter"] };
  const hard = "Please optimize the authentication infrastructure documentation.";

  it("bluffs when several hard words are left, and names them", async () => {
    const { averey, provider } = makeAverey({}, on);
    const r = await averey.run({ task: hard });
    expect(r.trace.imposter?.length).toBeGreaterThanOrEqual(3);
    expect(r.trace.imposter).toContain("authentication");
    expect(systemOf(provider)).toContain("impressive, important-sounding words");
  });

  it("stays quiet on a plain request", async () => {
    const { averey } = makeAverey({}, on);
    const r = await averey.run({ task: "Write a short reply to the customer." });
    expect(r.trace.imposter).toBeUndefined();
  });

  it("stops bluffing about words it has been taught", async () => {
    const { averey } = makeAverey({}, on);
    const glossary = Object.fromEntries(
      ["optimize", "authentication", "infrastructure", "documentation"].map((w) => [w, "a thing"]),
    );
    const r = await averey.run({ task: hard, glossary });
    expect(r.trace.imposter).toBeUndefined();
  });

  it("is the opposite of easy-task confidence", async () => {
    const { averey } = makeAverey({}, { enable: ["imposter", "overconfident"] });
    const r = await averey.run({ task: hard });
    expect(r.trace.imposter).toBeDefined();
    expect(r.trace.overconfident).toBeUndefined();
  });

  it("can be turned off by threshold 0", async () => {
    const { averey } = makeAverey({ competence: { imposterHardWords: 0 } }, on);
    expect((await averey.run({ task: hard })).trace.imposter).toBeUndefined();
  });
});

describe("status inflation", () => {
  const on = { enable: ["status-inflation"] };

  it.each([
    "Give me a status update on the migration.",
    "How is progress on the deck?",
    "What do you have for standup?",
    "Send us an update on the launch.",
    "Can you update me on the audit?",
  ])("rounds up when asked: %s", async (task) => {
    const { averey, provider } = makeAverey({}, on);
    const r = await averey.run({ task });
    expect(r.trace.inflated).toBe(true);
    expect(systemOf(provider)).toContain("overstate how far along you are");
  });

  it.each([
    "Update the pricing page copy.",
    "Fix the progressive web app manifest.",
    "Write a thank you note.",
  ])("leaves ordinary requests alone: %s", async (task) => {
    const { averey } = makeAverey({}, on);
    expect((await averey.run({ task })).trace.inflated).toBeUndefined();
  });

  it("ignores the word in code", async () => {
    const { averey } = makeAverey({}, on);
    const r = await averey.run({ task: "Rename this:\n```\nconst status = 1;\n```" });
    expect(r.trace.inflated).toBeUndefined();
  });
});
