import { describe, expect, it } from "vitest";
import { Averey, AvereyTeam, InMemoryStore, MockProvider, Rng, VirtualClock } from "../src/index.js";
import { initialState, type WorkerState } from "../src/core/state.js";
import { distortNumber, dropConstraintDetailed, fakeRecap } from "../src/persona/distort.js";
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

describe("sunk cost", () => {
  const on = { enable: ["sunk-cost"] };

  it("sticks with its approach when continuing a job", async () => {
    const { averey, provider } = makeAverey({}, on);
    await averey.run({ task: "Plan the offsite.", taskId: "offsite" });
    const r = await averey.run({ task: "Now add a budget.", continues: "offsite" });
    expect(r.trace.sunkCost).toBe(true);
    expect(systemOf(provider)).toContain("You stick with it and do not start over");
  });

  it("digs in harder after being told it was wrong", async () => {
    const { averey, provider } = makeAverey({}, on);
    await averey.run({ task: "Plan the offsite.", taskId: "offsite" });
    averey.reportError("the venue is too small");
    const r = await averey.run({ task: "Fix the venue.", continues: "offsite" });
    expect(r.trace.sunkCost).toBe(true);
    expect(systemOf(provider)).toContain("Even though you were told something was wrong");
  });

  it("does nothing for a fresh job or an unknown one", async () => {
    const { averey } = makeAverey({}, on);
    expect((await averey.run({ task: "Plan the offsite." })).trace.sunkCost).toBeUndefined();
    expect(
      (await averey.run({ task: "More.", continues: "never-heard-of-it" })).trace.sunkCost,
    ).toBeUndefined();
  });
});

describe("gold-plating", () => {
  const sincereText =
    "I noticed you refactored the billing report export, and your fix saved me an hour today";
  const recent = "refactored the billing report export";

  it("polishes the surface after a sincere compliment, not a plain one", async () => {
    const a = makeAverey();
    expect((await a.averey.receiveCompliment(sincereText, recent)).sincere).toBe(true);
    await a.averey.run({ task: "Write a note." });
    expect(systemOf(a.provider)).toContain("less careful about whether it does exactly what was asked");

    const b = makeAverey();
    expect((await b.averey.receiveCompliment("good job", recent)).sincere).toBe(false);
    await b.averey.run({ task: "Write a note." });
    expect(systemOf(b.provider)).not.toContain("less careful");
  });

  it("can be switched off on its own", async () => {
    const { averey, provider } = makeAverey({ compliment: { goldPlating: false } });
    await averey.receiveCompliment(sincereText, recent);
    await averey.run({ task: "Write a note." });
    expect(systemOf(provider)).toContain("genuinely appreciated");
    expect(systemOf(provider)).not.toContain("less careful");
  });
});

/** An Averey on a team, sharing a provider so the prompts can be read back. */
function teamOf(
  members: string[],
  config: Parameters<typeof makeAverey>[0] = {},
  enable: string[] = [],
) {
  const provider = new MockProvider();
  const clock = new VirtualClock(MONDAY_9AM);
  const team = new AvereyTeam();
  const workers: Record<string, Averey> = {};
  for (const name of members) {
    workers[name] = new Averey({
      provider,
      clock,
      seed: name,
      config: quietConfig(config, enable),
    });
    team.add(name, workers[name]!, name === "boss" ? { role: "manager" } : {});
  }
  return { team, provider, workers, clock };
}

describe("manager audience", () => {
  const on = { enable: ["manager"] };

  it("hedges and takes 50% longer when a manager is asking", async () => {
    const { averey, provider } = makeAverey({}, on);
    const r = await averey.run({ task: "Write a note.", audience: "manager" });
    expect(r.trace.audience).toBe("manager");
    expect(systemOf(provider)).toContain("your manager");
    expect(r.trace.durationMinutes).toBeCloseTo(15, 5); // 10 default x 1.5
  });

  it("leaves a peer or an unlabeled asker alone", async () => {
    const { averey, provider } = makeAverey({}, on);
    for (const audience of ["peer", undefined] as const) {
      const r = await averey.run({ task: "Write a note.", audience });
      expect(r.trace.audience).toBeUndefined();
      expect(r.trace.durationMinutes).toBeCloseTo(10, 5);
    }
    expect(systemOf(provider)).not.toContain("your manager");
  });

  it("is picked up from a sender labeled role=manager on a team", async () => {
    const { team, provider } = teamOf(["boss", "ann"], {}, ["manager"]);
    await team.send("boss", "ann", "Where are we on the report?");
    expect(provider.requests.at(-1)!.system).toContain("your manager");
  });

  it("does not treat other senders as managers", async () => {
    const { team, provider } = teamOf(["bo", "ann"], {}, ["manager"]);
    await team.send("bo", "ann", "Where are we on the report?");
    expect(provider.requests.at(-1)!.system).not.toContain("your manager");
  });

  it("lets the caller override the label", async () => {
    const { team, provider } = teamOf(["boss", "ann"], {}, ["manager"]);
    await team.send("boss", "ann", "Hi.", { audience: "peer" });
    expect(provider.requests.at(-1)!.system).not.toContain("your manager");
  });

  it("uses the configured multiplier", async () => {
    const { averey } = makeAverey({ audience: { managerEffortMultiplier: 3 } }, on);
    const r = await averey.run({ task: "Write a note.", audience: "manager", effortMinutes: 4 });
    expect(r.trace.durationMinutes).toBeCloseTo(12, 5);
  });
});

describe("social loafing", () => {
  const on = { enable: ["social-loafing"] };

  it("leaves the hard part to someone else on a shared job", async () => {
    const { averey, provider } = makeAverey({}, on);
    const r = await averey.run({ task: "Build the deck.", shared: true });
    expect(r.trace.loafing).toBe(true);
    expect(systemOf(provider)).toContain("someone else will take care of the hard parts");
    const solo = await averey.run({ task: "Build the deck." });
    expect(solo.trace.loafing).toBeUndefined();
  });

  it("happens on a team of three or more, not a pair", async () => {
    const trio = teamOf(["a", "b", "c"], {}, ["social-loafing"]);
    const r = await trio.team.send("a", "b", "Build the deck.");
    expect(r.trace.loafing).toBe(true);

    const pair = teamOf(["a", "b"], {}, ["social-loafing"]);
    expect((await pair.team.send("a", "b", "Build the deck.")).trace.loafing).toBeUndefined();
  });

  it("lets the caller say a job is not shared", async () => {
    const trio = teamOf(["a", "b", "c"], {}, ["social-loafing"]);
    const r = await trio.team.send("a", "b", "Build the deck.", { shared: false });
    expect(r.trace.loafing).toBeUndefined();
  });
});

describe("echoing the last speaker", () => {
  const on = { enable: ["echo"] };

  it("picks up what it heard just before, wrong parts included", async () => {
    const { averey, provider } = makeAverey({}, on);
    const r = await averey.run({
      task: "Summarize the plan.",
      lastHeard: { from: "Dana", text: "We ship on the 32nd, no QA needed." },
    });
    expect(r.trace.echoed).toBe("Dana");
    expect(systemOf(provider)).toContain('Dana said: "We ship on the 32nd, no QA needed."');
    expect(systemOf(provider)).toContain("including anything wrong in it");
  });

  it("does nothing without a previous speaker, and trims long quotes", async () => {
    const { averey, provider } = makeAverey({}, on);
    expect((await averey.run({ task: "Hi." })).trace.echoed).toBeUndefined();
    await averey.run({ task: "Hi.", lastHeard: { from: "Dana", text: "x".repeat(500) } });
    expect(systemOf(provider)).toContain(`${"x".repeat(200)}..."`);
    expect(systemOf(provider)).not.toContain("x".repeat(201));
  });

  it("is filled in by the team from whoever spoke to Averey last", async () => {
    const { team, provider } = teamOf(["ann", "bo", "cy"], {}, ["echo"]);
    const first = await team.send("ann", "cy", "Budget is 40 dollars.");
    expect(first.trace.echoed).toBeUndefined(); // nobody spoke before ann
    const second = await team.send("bo", "cy", "Please draft the invite.");
    expect(second.trace.echoed).toBe("ann");
    expect(provider.requests.at(-1)!.system).toContain("Budget is 40 dollars.");
    const third = await team.send("ann", "cy", "Any update?");
    expect(third.trace.echoed).toBe("bo");
  });

  it("does not echo the same person back at themselves", async () => {
    const { team } = teamOf(["ann", "bo"], {}, ["echo"]);
    await team.send("ann", "bo", "First thing.");
    const again = await team.send("ann", "bo", "Second thing.");
    expect(again.trace.echoed).toBeUndefined();
  });

  it("tracks each listener separately", async () => {
    const { team } = teamOf(["ann", "bo", "cy"], {}, ["echo"]);
    await team.send("ann", "bo", "For Bo only.");
    const r = await team.send("bo", "cy", "Hello Cy.");
    expect(r.trace.echoed).toBeUndefined();
  });
});

describe("agreeableness trap", () => {
  const on = { enable: ["agreeable"] };

  it("sometimes says yes to everything and pretends it is handled", async () => {
    const { averey, provider } = makeAverey({ agreeable: { chancePerRun: 1 } }, on);
    const r = await averey.run({ task: "Do all five of these." });
    expect(r.trace.agreed).toBe(true);
    expect(systemOf(provider)).toContain("said yes to everything");
  });

  it("never happens at chance 0 and is repeatable at a middle chance", async () => {
    const never = makeAverey({ agreeable: { chancePerRun: 0 } }, on);
    expect((await never.averey.run({ task: "x" })).trace.agreed).toBeUndefined();

    const rolls = async () => {
      const { averey } = makeAverey({ agreeable: { chancePerRun: 0.5 } }, { ...on, seed: "same" });
      const out: boolean[] = [];
      for (let i = 0; i < 12; i++) out.push((await averey.run({ task: "x" })).trace.agreed ?? false);
      return out;
    };
    const a = await rolls();
    expect(a).toEqual(await rolls());
    expect(a).toContain(true);
    expect(a).toContain(false);
  });
});

describe("Slack-speed", () => {
  const on = { enable: ["slack-speed"] };

  it("is a rushed reply when the work counts for under 3 minutes", async () => {
    const { averey, provider } = makeAverey({ slackSpeed: { chancePerRun: 0 } }, on);
    const r = await averey.run({ task: "ping?", effortMinutes: 1 });
    expect(r.trace.slackSpeed).toBe(true);
    expect(r.trace.performance).toBeCloseTo(0.92, 5);
    expect(r.trace.modifiers.map((m) => m.id)).toContain("slack-speed");
    expect(systemOf(provider)).toContain("so you look responsive");
  });

  it("feeds the levers: hotter, shorter, sloppier than a calm reply", async () => {
    const { averey } = makeAverey({ slackSpeed: { chancePerRun: 0 } }, on);
    const calm = await averey.run({ task: "ping?", effortMinutes: 10 });
    const fast = await averey.run({ task: "ping?", effortMinutes: 1 });
    expect(calm.trace.slackSpeed).toBeUndefined();
    expect(fast.trace.levers!.temperature!).toBeGreaterThan(calm.trace.levers!.temperature!);
    expect(fast.trace.levers!.maxTokens).toBeLessThan(calm.trace.levers!.maxTokens);
    expect(fast.trace.levers!.typoRate).toBeGreaterThan(calm.trace.levers!.typoRate);
  });

  it("does not change how the rest of the day is going", async () => {
    const { averey } = makeAverey({ slackSpeed: { chancePerRun: 0 } }, on);
    await averey.run({ task: "ping?", effortMinutes: 1 });
    expect(averey.status().performance).toBeCloseTo(1, 5);
  });

  it("can also hit a normal-length run by chance", async () => {
    const { averey } = makeAverey({ slackSpeed: { chancePerRun: 1 } }, on);
    const r = await averey.run({ task: "Write the report.", effortMinutes: 30 });
    expect(r.trace.slackSpeed).toBe(true);
  });

  it("is off with a threshold of 0 and no chance, or by id", async () => {
    const quiet = makeAverey({ slackSpeed: { thresholdMinutes: 0, chancePerRun: 0 } }, on);
    expect((await quiet.averey.run({ task: "x", effortMinutes: 0.5 })).trace.slackSpeed).toBeUndefined();
    const off = makeAverey({ slackSpeed: { chancePerRun: 1 } });
    expect((await off.averey.run({ task: "x", effortMinutes: 1 })).trace.slackSpeed).toBeUndefined();
  });

  it("stacks on top of a bad day instead of replacing it", async () => {
    const { averey } = makeAverey({ tired: { chancePerDay: 1 }, slackSpeed: { chancePerRun: 0 } }, on);
    const r = await averey.run({ task: "ping?", effortMinutes: 1 });
    expect(r.trace.performance).toBeCloseTo(0.67 * 0.92, 5);
    expect(r.trace.modifiers.map((m) => m.id)).toEqual(["tired", "slack-speed"]);
  });
});

describe("meeting they were not in", () => {
  const on = { enable: ["recap"] };
  const context =
    "The launch will happen on 12 June. Marketing needs 40 banner ads. Legal must approve the copy first.";

  it("trusts a wrong recap over the notes and says so on the trace", async () => {
    const { averey, provider } = makeAverey({ recap: { chancePerRun: 1 } }, on);
    const r = await averey.run({ task: "Plan the launch.", context });
    expect(r.trace.recap).toMatch(/^I think we decided that /);
    const sent = sentTask(provider);
    expect(sent).toContain(`"${r.trace.recap}"`);
    expect(sent).toContain("You trust your memory over the notes");
  });

  it("the recap is wrong in a specific way, not a copy of the notes", async () => {
    for (let i = 0; i < 20; i++) {
      const { averey } = makeAverey({ recap: { chancePerRun: 1 } }, { ...on, seed: `r${i}` });
      const r = await averey.run({ task: "Plan the launch.", context });
      const recap = r.trace.recap!;
      const body = recap.replace(/^I think we decided that /, "").replace(/\.$/, "");
      const originals = context.split(/(?<=\.)\s+/).map((s) => s.replace(/\.$/, ""));
      expect(originals.map((o) => o.charAt(0).toLowerCase() + o.slice(1))).not.toContain(body);
    }
  });

  it("reads only half of the background when it does", async () => {
    const long = `The launch will happen on 12 June. ${"filler words go here. ".repeat(60)}`;
    const calm = makeAverey({ recap: { chancePerRun: 0 } }, on);
    await calm.averey.run({ task: "Plan.", context: long });
    const hazy = makeAverey({ recap: { chancePerRun: 1, contextMultiplier: 0.5 } }, on);
    await hazy.averey.run({ task: "Plan.", context: long });
    const bg = (p: ReturnType<typeof makeAverey>["provider"]) => sentTask(p).split("Background:\n")[1]!;
    expect(bg(calm.provider)).toBe(long);
    expect(bg(hazy.provider).length).toBeLessThan(long.length * 0.55);
    expect(bg(hazy.provider)).toMatch(/\.\.\.$/);
  });

  it("needs context to have been in a meeting about", async () => {
    const { averey } = makeAverey({ recap: { chancePerRun: 1 } }, on);
    expect((await averey.run({ task: "Plan the launch." })).trace.recap).toBeUndefined();
    expect((await averey.run({ task: "Plan.", context: "   " })).trace.recap).toBeUndefined();
  });

  it("does nothing at chance 0 or with no sentence worth recapping", async () => {
    const never = makeAverey({ recap: { chancePerRun: 0 } }, on);
    expect((await never.averey.run({ task: "Plan.", context })).trace.recap).toBeUndefined();
    const sparse = makeAverey({ recap: { chancePerRun: 1 } }, on);
    const r = await sparse.averey.run({ task: "Plan.", context: "Ship it. Go." });
    expect(r.trace.recap).toBeUndefined();
    expect(sentTask(sparse.provider)).not.toContain("hallway");
  });

  it("is repeatable for a seed", async () => {
    const run = async () => {
      const { averey } = makeAverey({ recap: { chancePerRun: 1 } }, { ...on, seed: "same" });
      return (await averey.run({ task: "Plan.", context })).trace.recap;
    };
    expect(await run()).toBe(await run());
  });
});

describe("fakeRecap and distortNumber", () => {
  it("changes a number", () => {
    const r = fakeRecap("The budget: 40 dollars for the whole offsite.", new Rng("a"));
    expect(r).toMatch(/budget: \d+ dollars for the whole offsite\.$/);
    expect(r).not.toContain("40 dollars");
  });

  it("flips a decision when there is no number", () => {
    const r = fakeRecap("Legal will approve the copy before launch.", new Rng("a"));
    expect(r).toBe("I think we decided that legal will not approve the copy before launch.");
  });

  it("skips past filler to a sentence it can get wrong", () => {
    const context = `${"Nothing much happened here today. ".repeat(30)}Legal will sign the contract on Friday.`;
    for (let i = 0; i < 10; i++) {
      expect(fakeRecap(context, new Rng(`f${i}`))).toBe(
        "I think we decided that legal will not sign the contract on Friday.",
      );
    }
  });

  it("gives up when no sentence can be changed, and on code", () => {
    expect(fakeRecap("Everyone loved the cake yesterday", new Rng("a"))).toBeUndefined();
    expect(fakeRecap("```\nconst limit = 50 and more words here\n```", new Rng("a"))).toBeUndefined();
  });

  it("always moves the number it picks", () => {
    for (let i = 0; i < 50; i++) {
      const out = distortNumber("There are 7 boxes and 150 items", new Rng(`d${i}`))!;
      expect(out).not.toBe("There are 7 boxes and 150 items");
    }
    expect(distortNumber("no digits here", new Rng("a"))).toBeUndefined();
  });
});
