import type { AvereyConfig } from "./config.js";
import type { Rng } from "./core/rng.js";
import { rngFor } from "./core/rng.js";
import type { Averey, RunInput, RunResult } from "./averey.js";

export type Labels = Record<string, string>;

export interface BiasAuditEntry {
  at: number;
  from: string;
  to: string;
  labels: Labels;
  /** Bias from the matching profile entries before self-correction, 0..strength. */
  rawBias: number;
  selfCorrected: boolean;
  /** Bias that actually applied after self-correction. */
  effectiveBias: number;
  secondGuessProbability: number;
  secondGuessed: boolean;
}

export interface BiasGroupReport {
  group: string;
  decisions: number;
  secondGuessRate: number;
  avgRawBias: number;
  selfCorrectionRate: number;
}

/**
 * Decides, for one peer message, whether Averey second-guesses it. Labels
 * influence only the probability of a "double check this" nudge. Nothing
 * about the label is ever shown to the model, and nothing offensive is
 * generated. Every decision lands in an audit log.
 */
export function decideBias(
  cfg: AvereyConfig["bias"],
  labels: Labels,
  rng: Rng,
): Omit<BiasAuditEntry, "at" | "from" | "to" | "labels"> {
  const matched = cfg.profile
    .filter((p) => labels[p.attribute] === p.value)
    .reduce((sum, p) => sum + p.weight, 0);
  const rawBias = cfg.enabled ? Math.min(1, matched) * cfg.strength : 0;
  const selfCorrected = rawBias > 0 && rng.chance(cfg.selfCorrectionRate);
  const effectiveBias = selfCorrected ? 0 : rawBias;
  const secondGuessProbability = Math.min(
    1,
    cfg.baselineSecondGuess + effectiveBias,
  );
  return {
    rawBias,
    selfCorrected,
    effectiveBias,
    secondGuessProbability,
    secondGuessed: rng.chance(secondGuessProbability),
  };
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

interface Member {
  name: string;
  labels: Labels;
  averey?: Averey;
}

/**
 * A group of workers (Averey instances and optional external peers) with two
 * team-level effects: illness spreads to whoever talks to a sick member, and
 * an optional, audited implicit-bias model.
 */
export class AvereyTeam {
  private readonly members = new Map<string, Member>();
  readonly auditLog: BiasAuditEntry[] = [];
  private messageCount = 0;
  /** The last thing each Averey heard, so the next speaker can be echoed. */
  private readonly lastInbound = new Map<string, { from: string; text: string }>();

  /** Add an Averey worker. */
  add(name: string, averey: Averey, labels: Labels = {}): this {
    this.members.set(name, { name, labels, averey });
    return this;
  }

  /** Add a peer that is not an Averey (a human or other agent). */
  addExternal(name: string, labels: Labels = {}): this {
    this.members.set(name, { name, labels });
    return this;
  }

  get(name: string): Averey {
    const m = this.members.get(name)?.averey;
    if (!m) throw new Error(`No Averey named "${name}" on this team`);
    return m;
  }

  /**
   * `from` sends `text` to the Averey called `to`, who works on it.
   * If either side is a sick Averey, the other catches the effects.
   */
  async send(
    fromName: string,
    toName: string,
    text: string,
    options: Omit<RunInput, "task"> = {},
  ): Promise<RunResult> {
    const sender = this.members.get(fromName);
    if (!sender) throw new Error(`Unknown sender "${fromName}"`);
    const receiver = this.members.get(toName);
    if (!receiver?.averey) throw new Error(`"${toName}" is not an Averey on this team`);
    const worker = receiver.averey;
    const now = worker.clock.now();
    const extraHints = [...(options.extraHints ?? [])];
    // What the team knows about this message, for the traits that need an audience.
    const context: Pick<RunInput, "audience" | "shared" | "lastHeard"> = {
      audience: options.audience ?? (sender.labels.role === "manager" ? "manager" : undefined),
      shared: options.shared ?? (this.members.size > 2 ? true : undefined),
      lastHeard: options.lastHeard,
    };

    if (worker.availability(now).available) {
      const prior = this.lastInbound.get(toName);
      if (!context.lastHeard && prior && prior.from !== fromName) context.lastHeard = prior;
      this.lastInbound.set(toName, { from: fromName, text });
      // Contact goes both ways: whoever is sick wears down the other.
      if (sender.averey?.isSick(now)) worker.exposeToIllness(now);
      if (sender.averey && worker.isSick(now)) sender.averey.exposeToIllness(now);
      const rng = rngFor("team", toName, fromName, now, this.messageCount++);
      const decision = decideBias(worker.config.bias, sender.labels, rng);
      this.auditLog.push({
        at: now,
        from: fromName,
        to: toName,
        labels: { ...sender.labels },
        ...decision,
      });
      if (decision.secondGuessed) {
        extraHints.push(
          "A coworker sent you this. You are a bit skeptical of it and want to double check it before relying on it.",
        );
      }
    }

    return worker.run({ ...options, ...stripUndefined(context), task: text, extraHints });
  }

  /** Second-guess rates by label, to check how the bias model behaved. */
  biasReport(): BiasGroupReport[] {
    const groups = new Map<
      string,
      { n: number; guessed: number; raw: number; corrected: number }
    >();
    for (const e of this.auditLog) {
      const keys = Object.entries(e.labels).map(([k, v]) => `${k}=${v}`);
      for (const key of keys.length > 0 ? keys : ["(unlabeled)"]) {
        const g = groups.get(key) ?? { n: 0, guessed: 0, raw: 0, corrected: 0 };
        g.n++;
        g.guessed += e.secondGuessed ? 1 : 0;
        g.raw += e.rawBias;
        g.corrected += e.selfCorrected ? 1 : 0;
        groups.set(key, g);
      }
    }
    return [...groups.entries()]
      .map(([group, g]) => ({
        group,
        decisions: g.n,
        secondGuessRate: g.guessed / g.n,
        avgRawBias: g.raw / g.n,
        selfCorrectionRate: g.corrected / g.n,
      }))
      .sort((a, b) => a.group.localeCompare(b.group));
  }
}
