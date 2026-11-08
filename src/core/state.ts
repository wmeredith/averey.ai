import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface WorkInterval {
  start: number;
  end: number;
}

export interface ComplimentRecord {
  at: number;
  sincere: boolean;
  score: number;
  text: string;
}

export interface DefensiveState {
  /** When the defensiveness fades. */
  until: number;
  error: string;
  /** Whether Averey will eventually come around and apologize. */
  apologizes: boolean;
  apologized: boolean;
}

export interface MemoryItem {
  id: string;
  original: string;
  current: string;
  storedAt: number;
  distortions: string[];
}

export interface WorkerState {
  version: 1;
  /** dayIndex -> first engagement timestamp that day. */
  firstEngagement: Record<string, number>;
  workLog: WorkInterval[];
  compliments: ComplimentRecord[];
  defensive: DefensiveState | null;
  /** Exposed to a sick coworker until this time. */
  exposedUntil: number;
  /** Words Averey has been told the meaning of. */
  learnedWords: Record<string, string>;
  memory: MemoryItem[];
}

export function initialState(): WorkerState {
  return {
    version: 1,
    firstEngagement: {},
    workLog: [],
    compliments: [],
    defensive: null,
    exposedUntil: 0,
    learnedWords: {},
    memory: [],
  };
}

export interface StateStore {
  load(): WorkerState | undefined;
  save(state: WorkerState): void;
}

export class InMemoryStore implements StateStore {
  private snapshot: string | undefined;

  load(): WorkerState | undefined {
    return this.snapshot ? (JSON.parse(this.snapshot) as WorkerState) : undefined;
  }

  save(state: WorkerState): void {
    this.snapshot = JSON.stringify(state);
  }
}

/** Persists state to a JSON file so "the day" survives restarts. */
export class FileStateStore implements StateStore {
  private lastWritten: string | undefined;

  constructor(
    private readonly path: string,
    private readonly onCorrupt: (path: string, error: unknown) => void = (p, e) =>
      console.warn(
        `averey: could not read state from ${p} (${e instanceof Error ? e.message : String(e)}). Starting fresh; the file will be overwritten on the next save.`,
      ),
  ) {}

  load(): WorkerState | undefined {
    if (!existsSync(this.path)) return undefined;
    try {
      const text = readFileSync(this.path, "utf8");
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("not a JSON object");
      }
      this.lastWritten = text;
      return parsed as WorkerState;
    } catch (error) {
      this.onCorrupt(this.path, error);
      return undefined;
    }
  }

  save(state: WorkerState): void {
    const text = JSON.stringify(state);
    if (text === this.lastWritten) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, this.path);
    this.lastWritten = text;
  }
}

/** Fill in any fields a stored (older/partial) state is missing. */
export function hydrate(stored: Partial<WorkerState> | undefined): WorkerState {
  return { ...initialState(), ...(stored ?? {}), version: 1 };
}

export function hoursWorkedIn(
  log: WorkInterval[],
  now: number,
  windowMs: number,
): number {
  const from = now - windowMs;
  let total = 0;
  for (const w of log) {
    const s = Math.max(w.start, from);
    const e = Math.min(w.end, now);
    if (e > s) total += e - s;
  }
  return total / 3_600_000;
}
