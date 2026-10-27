import {
  type AvereyConfig,
  type DeepPartial,
  resolveConfig,
} from "./config.js";
import { type Clock, SystemClock, VirtualClock } from "./core/clock.js";
import { type SeedPart, rngFor } from "./core/rng.js";
import {
  type AwayReason,
  type Availability,
  Schedule,
  type SickStatus,
} from "./core/schedule.js";
import {
  type DefensiveState,
  InMemoryStore,
  type StateStore,
  type WorkerState,
  hoursWorkedIn,
  hydrate,
} from "./core/state.js";
import { DAY, HOUR, MIN, formatTime } from "./core/time.js";
import { type Levers, computeLevers } from "./levers.js";
import { LossyMemory, type RecallResult } from "./memory.js";
import { type Modifier, computeModifiers } from "./modifiers.js";
import { interpret } from "./persona/comprehension.js";
import { awayMessage, buildSystemPrompt, injectTypos } from "./persona/prompt.js";
import type { LLMProvider } from "./providers/types.js";
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
}

export interface RunInput {
  task: string;
  /** Id used to remember this task. Generated if omitted. */
  taskId?: string;
  /** Id of an earlier task this one continues. Averey recalls it from memory. */
  continues?: string;
  /** Background material. Averey only "reads" part of it when performing poorly. */
  context?: string;
  /** Simulated minutes of work this run represents. */
  effortMinutes?: number;
  /** Meanings for words Averey asked about. Averey remembers them. */
  glossary?: Record<string, string>;
  /** Extra condition hints, used by AvereyTeam. */
  extraHints?: string[];
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
  typos?: number;
  durationMinutes?: number;
  systemPrompt?: string;
}

export type RunResult =
  | { status: "ok"; output: string; trace: Trace }
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

export interface Status {
  at: number;
  performance: number;
  modifiers: TraceModifier[];
  hoursWorked24h: number;
  sick: SickStatus;
  availability: Availability;
}

function clampText(text: string, fraction: number): string {
  if (fraction >= 1 || text.length === 0) return text;
  const keep = Math.max(1, Math.floor(text.length * fraction));
  return keep >= text.length ? text : `...${text.slice(text.length - keep)}`;
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
  private state: WorkerState;
  private runCounter = 0;

  constructor(options: AvereyOptions) {
    this.config = resolveConfig(options.config);
    this.clock = options.clock ?? new SystemClock();
    this.provider = options.provider;
    this.seed = options.seed ?? "averey";
    this.store = options.store ?? new InMemoryStore();
    this.sincerity = options.sincerity ?? new HeuristicSincerityScorer();
    this.schedule = new Schedule(this.seed, this.config);
    this.state = hydrate(this.store.load());
  }

  get name(): string {
    return this.config.name;
  }

  /** A read-only copy of internal state, mostly for debugging and tests. */
  snapshot(): WorkerState {
    return JSON.parse(JSON.stringify(this.state)) as WorkerState;
  }

  // ---- inspection ---------------------------------------------------------

  availability(at: number = this.clock.now()): Availability {
    return this.schedule.availability(at);
  }

  isSick(at: number = this.clock.now()): boolean {
    return this.schedule.sickAt(at).sick;
  }

  status(at: number = this.clock.now()): Status {
    const { performance, modifiers } = this.modifiersAt(at);
    return {
      at,
      performance,
      modifiers: toTraceModifiers(modifiers),
      hoursWorked24h: this.hoursWorkedAt(at),
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
    if (!avail.available) {
      const rng = rngFor(this.seed, "away", now);
      return {
        status: "away",
        reason: avail.reason,
        backAt: avail.backAt,
        message: awayMessage(
          avail.reason,
          formatTime(avail.backAt, this.config.utcOffsetMinutes),
          rng,
        ),
        trace: this.baseTrace(now),
      };
    }

    this.registerEngagement(now);
    const rng = rngFor(this.seed, "run", now, this.runCounter++);

    for (const [word, meaning] of Object.entries(input.glossary ?? {})) {
      this.state.learnedWords[word.toLowerCase()] = meaning;
    }

    const { performance, modifiers } = this.modifiersAt(now);
    const trace: Trace = {
      ...this.baseTrace(now),
      performance,
      modifiers: toTraceModifiers(modifiers),
    };

    // 1. Comprehension: Averey may ask what a word means instead of working.
    const known = new Set(Object.keys(this.state.learnedWords));
    const understood = interpret(
      input.task,
      known,
      performance,
      this.config.comprehension,
      rng,
    );
    trace.comprehension = {
      asked: understood.asked,
      misread: understood.misread,
      skimmed: understood.skimmed,
    };
    if (understood.question) {
      this.persist();
      return {
        status: "clarification",
        question: understood.question,
        words: understood.asked,
        trace,
      };
    }

    // 2. Memory: remember this task, and recall (maybe wrongly) any earlier one.
    const memory = new LossyMemory(this.state.memory, this.config.memory);
    const taskId = input.taskId ?? `task-${now}-${this.runCounter}`;
    memory.store(taskId, input.task, now);
    let recalled: RecallResult | undefined;
    if (input.continues) {
      recalled = memory.recall(input.continues, {
        performance,
        stress: this.schedule.planAt(now).stress,
        now,
        rng,
      });
      trace.memory = recalled;
    }

    // 3. Levers: how performance changes the actual model call.
    const levers = computeLevers(performance, this.config, this.provider.capabilities);
    trace.levers = levers;

    // 4. Build the prompt and call the model.
    const hints = [
      ...modifiers.flatMap((m) => m.hints),
      ...levers.compensationHints,
      ...(input.extraHints ?? []),
    ];
    if (understood.skimmed.length > 0) {
      hints.push(
        `Some words in the request are over your head (${understood.skimmed.map((w) => `"${w}"`).join(", ")}). You are not sure what they mean and you just kind of go along with it.`,
      );
    }
    const system = buildSystemPrompt({ name: this.config.name, hints });
    trace.systemPrompt = system;

    const parts: string[] = [understood.text];
    const notes = Object.entries(input.glossary ?? {}).map(
      ([w, meaning]) => `"${w}" means ${meaning}.`,
    );
    if (notes.length > 0) parts.push(`(You were told: ${notes.join(" ")})`);
    if (recalled) {
      parts.push(
        `What you remember about the earlier job: ${recalled.recalled}`,
      );
    }
    if (input.context) {
      parts.push(
        `Background:\n${clampText(input.context, levers.contextFraction)}`,
      );
    }

    const response = await this.provider.complete({
      system,
      messages: [{ role: "user", content: parts.join("\n\n") }],
      temperature: levers.temperature,
      maxTokens: this.provider.capabilities.maxTokens ? levers.maxTokens : undefined,
    });

    // 5. Output: tired people make typos.
    const typos = injectTypos(response.text, levers.typoRate, rng);
    trace.typos = typos.count;

    // 6. Book the work and clear the apology, now that the call succeeded.
    const effort = input.effortMinutes ?? this.config.defaultEffortMinutes;
    const elapsed = (this.clock.now() - now) / MIN;
    const duration = Math.max(effort, elapsed);
    trace.durationMinutes = duration;
    this.state.workLog.push({ start: now, end: now + duration * MIN });
    if (modifiers.some((m) => m.id === "apology") && this.state.defensive) {
      this.state.defensive.apologized = true;
    }
    if (this.clock instanceof VirtualClock) this.clock.advanceMinutes(duration);
    this.prune(this.clock.now());
    this.persist();

    return { status: "ok", output: typos.text, trace };
  }

  /**
   * Like `run`, but waits out breaks. On a VirtualClock it jumps ahead; on a
   * real clock it sleeps, up to `maxWaitMs`, otherwise returns the away result.
   */
  async runWhenAvailable(
    input: RunInput,
    options: { maxWaitMs?: number } = {},
  ): Promise<RunResult> {
    const maxWait = options.maxWaitMs ?? HOUR;
    for (let i = 0; i < 20; i++) {
      const result = await this.run(input);
      if (result.status !== "away") return result;
      if (this.clock instanceof VirtualClock) {
        this.clock.set(result.backAt);
        continue;
      }
      const wait = result.backAt - this.clock.now();
      if (wait > maxWait) return result;
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, wait)));
    }
    return this.run(input);
  }

  // ---- internals ----------------------------------------------------------

  private modifiersAt(at: number) {
    return computeModifiers({
      now: at,
      config: this.config,
      state: this.state,
      schedule: this.schedule,
    });
  }

  private hoursWorkedAt(at: number): number {
    return hoursWorkedIn(
      this.state.workLog,
      at,
      this.config.hours.windowHours * HOUR,
    );
  }

  private baseTrace(at: number): Trace {
    const { performance, modifiers } = this.modifiersAt(at);
    return {
      at,
      performance,
      modifiers: toTraceModifiers(modifiers),
      hoursWorked24h: this.hoursWorkedAt(at),
    };
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
