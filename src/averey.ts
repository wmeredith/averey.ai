import {
  type AvereyConfig,
  type DeepPartial,
  resolveConfig,
} from "./config.js";
import { type Clock, SystemClock, VirtualClock } from "./core/clock.js";
import { type Rng, type SeedPart, rngFor } from "./core/rng.js";
import {
  type AwayReason,
  type Availability,
  Schedule,
  type SickStatus,
} from "./core/schedule.js";
import {
  type DefensiveState,
  InMemoryStore,
  type RecentWork,
  type StateStore,
  type WorkerState,
  hoursWorkedIn,
  hydrate,
} from "./core/state.js";
import { DAY, HOUR, MIN, formatTime } from "./core/time.js";
import { type Levers, computeLevers } from "./levers.js";
import { LossyMemory, type RecallResult } from "./memory.js";
import {
  MODIFIERS,
  type Modifier,
  type ModifierFn,
  computeModifiers,
} from "./modifiers.js";
import { type ComprehensionResult, interpret } from "./persona/comprehension.js";
import { type AppliedEffects, TASK_EFFECTS, applyTaskEffects } from "./persona/effects.js";
import { awayMessage, buildSystemPrompt, injectTypos } from "./persona/prompt.js";
import type { LLMMessage, LLMProvider, LLMRequest } from "./providers/types.js";
import {
  HeuristicSincerityScorer,
  type SincerityScorer,
} from "./sincerity.js";

export interface AvereyOptions {
  provider: LLMProvider;
  config?: DeepPartial<AvereyConfig>;
  clock?: Clock;
  /** Seeds every random decision. Same seed, same bad days. */
  seed?: SeedPart;
  store?: StateStore;
  sincerity?: SincerityScorer;
  /** Extra modifiers for this instance. An id that matches a built-in replaces it. */
  modifiers?: Record<string, ModifierFn>;
}

export interface RunInput {
  task: string;
  /** Id used to remember this task. Generated if omitted. */
  taskId?: string;
  /** Id of an earlier task this one continues. Averey recalls it from memory. */
  continues?: string;
  /** Background material. Averey only "reads" part of it when performing poorly. */
  context?: string;
  /** Earlier turns of the conversation, sent to the model before this task. */
  history?: LLMMessage[];
  /** Simulated minutes of work this run represents. */
  effortMinutes?: number;
  /** Meanings for words Averey asked about. Averey remembers them. */
  glossary?: Record<string, string>;
  /** Extra condition hints, used by AvereyTeam. */
  extraHints?: string[];
  /** Who is asking. A manager makes Averey hedge and take longer. */
  audience?: "manager" | "peer";
  /** A job shared with other people, so Averey assumes someone else has the hard part. */
  shared?: boolean;
  /** The message Averey heard just before this one, which Averey may echo. */
  lastHeard?: { from: string; text: string };
  /** Cancels the model call. */
  signal?: AbortSignal;
}

export interface TraceModifier {
  id: string;
  label: string;
  multiplier: number;
}

export interface Trace {
  at: number;
  performance: number;
  modifiers: TraceModifier[];
  hoursWorked24h: number;
  levers?: Levers;
  comprehension?: {
    asked: string[];
    misread: { word: string; as: string }[];
    skimmed: string[];
  };
  memory?: RecallResult;
  /** Set when a phone buzz interrupted the request. */
  notification?: { dropped: boolean; removed?: string };
  /** Id of the earlier task whose answer Averey started from. */
  reusedFrom?: string;
  /** The task looked easy, so Averey did not double check. */
  overconfident?: boolean;
  /** Hard words Averey is bluffing about. */
  imposter?: string[];
  /** Averey was asked for a status and rounded it up. */
  inflated?: boolean;
  /** Averey is sticking with an approach they already chose. */
  sunkCost?: boolean;
  /** Who was asking, when it changed how Averey worked. */
  audience?: "manager";
  /** Averey assumed someone else would handle the hard part. */
  loafing?: boolean;
  /** Whose framing Averey picked up. */
  echoed?: string;
  /** Averey said yes to everything without following it all. */
  agreed?: boolean;
  /** Averey fired back a quick reply to look responsive. */
  slackSpeed?: boolean;
  /** The half-remembered meeting recap Averey trusted over the notes. */
  recap?: string;
  typos?: number;
  /** True when the reply was cut off by the token limit. */
  truncated?: boolean;
  durationMinutes?: number;
  systemPrompt?: string;
}

export type RunResult =
  | {
      status: "ok";
      output: string;
      /** Pass as `continues` in a later run to have Averey recall this task. */
      taskId: string;
      trace: Trace;
    }
  | {
      status: "away";
      reason: AwayReason;
      backAt: number;
      message: string;
      trace: Trace;
    }
  | {
      status: "clarification";
      question: string;
      words: string[];
      trace: Trace;
    };

export interface RunWhenAvailableOptions {
  /** On a real clock, the longest break to sleep through. Default 1 hour. */
  maxWaitMs?: number;
  /**
   * Answers Averey's questions about words. Return meanings to retry with them
   * as a glossary, or undefined to hand the clarification back to the caller.
   */
  onClarification?: (
    question: string,
    words: string[],
  ) => Record<string, string> | undefined | Promise<Record<string, string> | undefined>;
}

export interface Status {
  at: number;
  performance: number;
  modifiers: TraceModifier[];
  hoursWorked24h: number;
  sick: SickStatus;
  availability: Availability;
}

/** The start of the text, cut at a word boundary, like someone who stopped reading. */
function clampText(text: string, fraction: number): string {
  if (fraction >= 1 || text.length === 0) return text;
  const keep = Math.max(1, Math.floor(text.length * fraction));
  if (keep >= text.length) return text;
  const space = text.lastIndexOf(" ", keep);
  const cut = space > keep * 0.8 ? space : keep;
  return `${text.slice(0, cut).trimEnd()} ...`;
}

function toTraceModifiers(mods: Modifier[]): TraceModifier[] {
  return mods.map(({ id, label, multiplier }) => ({ id, label, multiplier }));
}

export class Averey {
  readonly config: AvereyConfig;
  readonly clock: Clock;
  readonly provider: LLMProvider;
  readonly schedule: Schedule;
  private readonly seed: SeedPart;
  private readonly store: StateStore;
  private readonly sincerity: SincerityScorer;
  private readonly modifierRegistry: Readonly<Record<string, ModifierFn>>;
  private readonly eventLines: Record<string, string[]>;
  private state: WorkerState;
  private runCounter = 0;

  constructor(options: AvereyOptions) {
    this.config = resolveConfig(options.config);
    this.clock = options.clock ?? new SystemClock();
    this.provider = options.provider;
    this.seed = options.seed ?? "averey";
    this.store = options.store ?? new InMemoryStore();
    this.sincerity = options.sincerity ?? new HeuristicSincerityScorer();
    this.modifierRegistry = { ...MODIFIERS, ...options.modifiers };
    const reserved = [...Object.keys(this.modifierRegistry), ...Object.keys(TASK_EFFECTS)];
    const clashing = this.config.events.filter((e) => reserved.includes(e.id));
    if (clashing.length > 0) {
      throw new Error(
        `Life event id clashes with a modifier or effect: ${clashing.map((e) => e.id).join(", ")}`,
      );
    }
    const known = [...reserved, ...this.config.events.map((e) => e.id)];
    const unknown = this.config.disabledModifiers.filter((id) => !known.includes(id));
    if (unknown.length > 0) {
      throw new Error(
        `Unknown modifier id in disabledModifiers: ${unknown.join(", ")}. Known: ${known.join(", ")}`,
      );
    }
    this.eventLines = Object.fromEntries(
      this.config.events.filter((e) => e.awayLines?.length).map((e) => [e.id, e.awayLines!]),
    );
    this.schedule = new Schedule(this.seed, this.config);
    this.state = hydrate(this.store.load());
  }

  get name(): string {
    return this.config.name;
  }

  /** A read-only copy of internal state, mostly for debugging and tests. */
  snapshot(): WorkerState {
    return structuredClone(this.state);
  }

  // ---- inspection ---------------------------------------------------------

  availability(at: number = this.clock.now()): Availability {
    return this.schedule.availability(at);
  }

  isSick(at: number = this.clock.now()): boolean {
    return this.schedule.sickAt(at).sick;
  }

  status(at: number = this.clock.now()): Status {
    return {
      ...this.baseTrace(at),
      sick: this.schedule.sickAt(at),
      availability: this.availability(at),
    };
  }

  /**
   * The performance multiplier other (non-Averey) agents should apply to
   * themselves after talking to this one. 1 when healthy.
   */
  interactionPenalty(at: number = this.clock.now()): number {
    return this.isSick(at) ? this.config.sickness.contagionPenalty : 1;
  }

  // ---- things that happen to Averey ---------------------------------------

  async receiveCompliment(
    text: string,
    context?: string,
  ): Promise<{ sincere: boolean; score: number }> {
    const recentWork = [
      ...(context ? [context] : []),
      ...new LossyMemory(this.state.memory, this.config.memory)
        .recent(3)
        .map((m) => m.original),
    ];
    const score = await this.sincerity.score(text, { recentWork });
    const sincere = score >= this.config.compliment.sincerityThreshold;
    this.state.compliments.push({
      at: this.clock.now(),
      sincere,
      score,
      text,
    });
    this.persist();
    return { sincere, score };
  }

  /** The caller tells Averey they got something wrong. */
  reportError(description: string): DefensiveState {
    const now = this.clock.now();
    const rng = rngFor(this.seed, "error", now, this.runCounter++);
    const cfg = this.config.defensive;
    const defensive: DefensiveState = {
      until: now + rng.range(cfg.minHours, cfg.maxHours) * HOUR,
      error: description,
      apologizes: rng.chance(cfg.apologyChance),
      apologized: false,
    };
    this.state.defensive = defensive;
    this.persist();
    return { ...defensive };
  }

  /** Called when Averey has contact with a sick coworker. */
  exposeToIllness(at: number = this.clock.now()): void {
    const until = at + this.config.sickness.contagionHours * HOUR;
    this.state.exposedUntil = Math.max(this.state.exposedUntil, until);
    this.persist();
  }

  // ---- doing work ---------------------------------------------------------

  async run(input: RunInput): Promise<RunResult> {
    const now = this.clock.now();
    const avail = this.schedule.availability(now);
    if (!avail.available) return this.awayResult(avail, now);

    // Before the modifiers, so a word taught on this very run starts its honeymoon.
    this.learnWords(input.glossary, now);
    const rng = rngFor(this.seed, "run", now, this.runCounter++);
    const { performance, modifiers } = this.modifiersAt(now);
    const trace = this.traceOf(now, performance, modifiers);

    // Saved on every path, including a failed model call, so the store
    // always matches what Averey heard and remembered.
    try {
      this.registerEngagement(now);

      const understood = this.comprehend(input.task, performance, rng, trace);
      if (understood.question) {
        return {
          status: "clarification",
          question: understood.question,
          words: understood.asked,
          trace,
        };
      }

      const taskId = input.taskId ?? `task-${now}-${this.runCounter}`;
      const recalled = this.remember(taskId, input, performance, now, rng, trace);
      const effects = applyTaskEffects({
        text: understood.text,
        input,
        state: this.state,
        config: this.config,
        performance,
        now,
        seed: this.seed,
        runIndex: this.runCounter,
      });
      Object.assign(trace, effects.trace);

      // Effects can change how well Averey does this one job (not their day).
      let effective = performance;
      if (effects.modifiers.length > 0) {
        const product = effects.modifiers.reduce((p, m) => p * m.multiplier, 1);
        effective = Math.min(
          this.config.maxPerformance,
          Math.max(this.config.minPerformance, performance * product),
        );
        trace.modifiers = [...trace.modifiers, ...effects.modifiers];
        trace.performance = effective;
      }
      const levers = computeLevers(effective, this.config, this.provider.capabilities);
      trace.levers = levers;

      const request = this.buildRequest(
        input,
        { ...understood, text: effects.text },
        recalled,
        modifiers,
        levers,
        effects,
      );
      trace.systemPrompt = request.system;
      const response = await this.provider.complete(request);
      trace.truncated = response.truncated ?? false;

      const typos = injectTypos(response.text, levers.typoRate, rng);
      trace.typos = typos.count;

      this.bookWork(
        now,
        (input.effortMinutes ?? this.config.defaultEffortMinutes) * effects.effortMultiplier,
        modifiers,
        trace,
      );
      this.keepWork({ id: taskId, task: input.task, output: typos.text, at: now });
      return { status: "ok", output: typos.text, taskId, trace };
    } finally {
      this.persist();
    }
  }

  /**
   * Like `run`, but waits out breaks and, with `onClarification`, answers
   * Averey's questions. On a VirtualClock it jumps ahead; on a real clock it
   * sleeps, up to `maxWaitMs`, otherwise returns the away result.
   */
  async runWhenAvailable(
    input: RunInput,
    options: RunWhenAvailableOptions = {},
  ): Promise<RunResult> {
    const maxWait = options.maxWaitMs ?? HOUR;
    let current = input;
    for (let i = 0; i < 20; i++) {
      const result = await this.run(current);
      if (result.status === "ok") return result;
      if (result.status === "clarification") {
        const answers = await options.onClarification?.(result.question, result.words);
        if (!answers) return result;
        current = { ...current, glossary: { ...current.glossary, ...answers } };
        continue;
      }
      if (this.clock instanceof VirtualClock) {
        this.clock.set(result.backAt);
        continue;
      }
      const wait = result.backAt - this.clock.now();
      if (wait > maxWait) return result;
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, wait)));
    }
    return this.run(current);
  }

  // ---- run stages ---------------------------------------------------------

  private awayResult(
    avail: Extract<Availability, { available: false }>,
    now: number,
  ): RunResult {
    return {
      status: "away",
      reason: avail.reason,
      backAt: avail.backAt,
      message: awayMessage(
        avail.reason,
        formatTime(avail.backAt, this.config.utcOffsetMinutes),
        rngFor(this.seed, "away", now),
        this.eventLines,
      ),
      trace: this.baseTrace(now),
    };
  }

  private learnWords(glossary: Record<string, string> | undefined, now: number): void {
    for (const [word, meaning] of Object.entries(glossary ?? {})) {
      const key = word.toLowerCase();
      const known = this.state.learnedWords[key];
      // Passing the same glossary again is not learning it again.
      if (known?.meaning === meaning) continue;
      this.state.learnedWords[key] = { meaning, at: now };
    }
  }

  /** Averey may ask what a word means, misread it, or skim past it. */
  private comprehend(
    task: string,
    performance: number,
    rng: Rng,
    trace: Trace,
  ): ComprehensionResult {
    const known = new Set(Object.keys(this.state.learnedWords));
    const understood = interpret(task, known, performance, this.config.comprehension, rng);
    trace.comprehension = {
      asked: understood.asked,
      misread: understood.misread,
      skimmed: understood.skimmed,
    };
    return understood;
  }

  /** Stores this task and recalls (maybe wrongly) the one it continues. */
  private remember(
    taskId: string,
    input: RunInput,
    performance: number,
    now: number,
    rng: Rng,
    trace: Trace,
  ): RecallResult | undefined {
    const memory = new LossyMemory(this.state.memory, this.config.memory);
    memory.store(taskId, input.task, now);
    if (!input.continues) return undefined;
    const recalled = memory.recall(input.continues, {
      performance,
      stress: this.schedule.planAt(now).stress,
      now,
      rng,
    });
    trace.memory = recalled;
    return recalled;
  }

  private buildRequest(
    input: RunInput,
    understood: ComprehensionResult,
    recalled: RecallResult | undefined,
    modifiers: Modifier[],
    levers: Levers,
    effects: AppliedEffects,
  ): LLMRequest {
    const hints = [
      ...modifiers.flatMap((m) => m.hints),
      ...levers.compensationHints,
      ...effects.hints,
      ...(input.extraHints ?? []),
    ];
    if (understood.skimmed.length > 0) {
      hints.push(
        `Some words in the request are over your head (${understood.skimmed.map((w) => `"${w}"`).join(", ")}). You are not sure what they mean and you just kind of go along with it.`,
      );
    }

    const parts: string[] = [understood.text];
    const notes = Object.entries(input.glossary ?? {}).map(
      ([w, meaning]) => `"${w}" means ${meaning}.`,
    );
    if (notes.length > 0) parts.push(`(You were told: ${notes.join(" ")})`);
    if (recalled) {
      parts.push(`What you remember about the earlier job: ${recalled.recalled}`);
    }
    parts.push(...effects.notes);
    if (input.context) {
      parts.push(
        `Background:\n${clampText(input.context, levers.contextFraction * effects.contextMultiplier)}`,
      );
    }

    return {
      system: buildSystemPrompt({ name: this.config.name, hints }),
      messages: [
        ...(input.history ?? []),
        { role: "user", content: parts.join("\n\n") },
      ],
      temperature: levers.temperature,
      maxTokens: this.provider.capabilities.maxTokens ? levers.maxTokens : undefined,
      signal: input.signal,
    };
  }

  /** Keeps the most recent finished jobs so a similar request can reuse one. */
  private keepWork(work: RecentWork): void {
    const kept = this.state.recentWork.filter((w) => w.id !== work.id);
    kept.push(work);
    this.state.recentWork = kept.slice(-this.config.reuse.maxItems);
  }

  /** Logs the work, clears a delivered apology, and advances a virtual clock. */
  private bookWork(
    now: number,
    effort: number,
    modifiers: Modifier[],
    trace: Trace,
  ): void {
    const elapsed = (this.clock.now() - now) / MIN;
    const duration = Math.max(effort, elapsed);
    trace.durationMinutes = duration;
    // One person works on one thing at a time: queue behind unfinished work
    // so bursts of calls cannot count the same minutes twice.
    const start = Math.max(now, this.busyUntil());
    const end = start + duration * MIN;
    this.state.workLog.push({ start, end });
    if (modifiers.some((m) => m.id === "apology") && this.state.defensive) {
      this.state.defensive.apologized = true;
    }
    if (this.clock instanceof VirtualClock) {
      this.clock.set(Math.max(this.clock.now(), end));
    }
    this.prune(this.clock.now());
  }

  // ---- internals ----------------------------------------------------------

  private modifiersAt(at: number) {
    return computeModifiers(
      {
        now: at,
        config: this.config,
        state: this.state,
        schedule: this.schedule,
      },
      this.modifierRegistry,
    );
  }

  private hoursWorkedAt(at: number): number {
    return hoursWorkedIn(
      this.state.workLog,
      at,
      this.config.hours.windowHours * HOUR,
    );
  }

  private busyUntil(): number {
    return this.state.workLog.reduce((latest, w) => Math.max(latest, w.end), 0);
  }

  private traceOf(at: number, performance: number, modifiers: Modifier[]): Trace {
    return {
      at,
      performance,
      modifiers: toTraceModifiers(modifiers),
      hoursWorked24h: this.hoursWorkedAt(at),
    };
  }

  private baseTrace(at: number): Trace {
    const { performance, modifiers } = this.modifiersAt(at);
    return this.traceOf(at, performance, modifiers);
  }

  private registerEngagement(now: number): void {
    const day = String(this.schedule.dayIndex(now));
    this.state.firstEngagement[day] ??= now;
  }

  private prune(now: number): void {
    const s = this.state;
    s.workLog = s.workLog.filter((w) => w.end > now - 2 * DAY);
    s.compliments = s.compliments.filter(
      (c) =>
        now - c.at <
        Math.max(
          this.config.compliment.windowHours,
          this.config.compliment.sincereWindowHours,
        ) *
          HOUR,
    );
    const today = this.schedule.dayIndex(now);
    for (const key of Object.keys(s.firstEngagement)) {
      if (Number(key) < today - 3) delete s.firstEngagement[key];
    }
  }

  private persist(): void {
    this.store.save(this.state);
  }
}
