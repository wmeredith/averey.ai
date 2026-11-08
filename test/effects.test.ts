import { describe, expect, it } from "vitest";
import { Rng } from "../src/index.js";
import { dropConstraintDetailed } from "../src/persona/distort.js";
import { makeAverey } from "./helpers.js";

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
