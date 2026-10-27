export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

/**
 * A clock you control. Lets tests and simulations fast-forward through
 * days, sick weeks, and years without waiting.
 */
export class VirtualClock implements Clock {
  private t: number;

  constructor(start: number | Date = Date.now()) {
    this.t = start instanceof Date ? start.getTime() : start;
  }

  now(): number {
    return this.t;
  }

  set(ts: number): void {
    this.t = ts;
  }

  advance(ms: number): void {
    this.t += ms;
  }

  advanceMinutes(minutes: number): void {
    this.t += minutes * 60_000;
  }

  advanceHours(hours: number): void {
    this.t += hours * 3_600_000;
  }
}
