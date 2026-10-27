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
  constructor(private readonly path: string) {}

  load(): WorkerState | undefined {
    if (!existsSync(this.path)) return undefined;
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as WorkerState;
    } catch {
      return undefined;
    }
  }

  save(state: WorkerState): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, this.path);
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
