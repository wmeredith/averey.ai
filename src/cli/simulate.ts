/**
 * Runs Averey through a synthetic stretch of workdays on a fast-forward
 * clock and prints how performance moves around.
 *
 *   npm run simulate -- --days 14 --seed alice --verbose
 */
import { Averey } from "../averey.js";
import { VirtualClock } from "../core/clock.js";
import { Rng } from "../core/rng.js";
import { HOUR, MIN, dayIndexOf, formatDate, formatTime } from "../core/time.js";
import { MockProvider } from "../providers/mock.js";

interface Args {
  days: number;
  seed: string;
  verbose: boolean;
  start: string;
  /** Local hour the day of requests stops. */
  end: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { days: 7, seed: "averey", verbose: false, start: "2026-11-02", end: 17.5 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--days") args.days = Number(argv[++i]);
    else if (a === "--seed") args.seed = String(argv[++i]);
    else if (a === "--start") args.start = String(argv[++i]);
    else if (a === "--end") args.end = Number(argv[++i]);
    else if (a === "--verbose" || a === "-v") args.verbose = true;
    else if (a === "--help" || a === "-h") {
      console.log("Usage: simulate [--days N] [--seed S] [--start YYYY-MM-DD] [--end HOUR] [--verbose]");
      process.exit(0);
    }
  }
  if (!Number.isFinite(args.days) || args.days < 1) args.days = 7;
  if (!Number.isFinite(args.end)) args.end = 17.5;
  return args;
}

const TASKS = [
  "Write a short reply to the customer about the late shipment.",
  "Summarize this meeting in three bullet points.",
  "Please optimize the authentication infrastructure documentation.",
  "Draft an email asking the team to send their timesheets by Friday.",
  "Figure out how many boxes we need if each holds 12 items and we have 150 items.",
  "Rewrite this paragraph so it sounds friendlier.",
  "Check the spreadsheet for duplicate entries and list them.",
  "Explain our refund policy in simple terms.",
];

const OFFSET = 0;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [y, m, d] = args.start.split("-").map(Number) as [number, number, number];
  const clock = new VirtualClock(Date.UTC(y, m - 1, d, 6, 30));
  const provider = new MockProvider({
    respond: (r) => `Done: ${(r.messages[0]?.content ?? "").split("\n")[0]?.slice(0, 60)}`,
  });
  const averey = new Averey({
    provider,
    clock,
    seed: args.seed,
    config: { utcOffsetMinutes: OFFSET },
  });
  const rng = new Rng(`sim|${args.seed}`);

  console.log(`Averey simulation: ${args.days} days from ${args.start}, seed "${args.seed}"\n`);
  console.log("Day              Tasks  Away  Asked  AvgPerf  MinPerf  MaxHrs  Notes");
  console.log("---------------  -----  ----  -----  -------  -------  ------  -----");

  const firstDay = dayIndexOf(clock.now(), OFFSET);
  for (let day = 0; day < args.days; day++) {
    const dayIdx = firstDay + day;
    const dayEnd = dayIdx * 24 * HOUR + args.end * HOUR;
    let tasks = 0;
    let away = 0;
    let asked = 0;
    let perfSum = 0;
    let perfMin = Infinity;
    let maxHrs = 0;
    const notes = new Set<string>();

    // Wake up at 8:30 local.
    clock.set(dayIdx * 24 * HOUR + 8.5 * HOUR);

    if (day === 1) {
      const c = await averey.receiveCompliment(
        "I noticed how clearly you explained the refund policy, thank you.",
        "Explain our refund policy in simple terms.",
      );
      notes.add(c.sincere ? "sincere compliment" : "compliment");
    }
    if (day === 3) {
      averey.reportError("the box count was wrong");
      notes.add("told they were wrong");
    }

    while (clock.now() < dayEnd) {
      const status = averey.status();
      if (args.verbose) {
        const mods = status.modifiers.filter((x) => x.id !== "stress").map((x) => x.id).join(",");
        console.log(
          `  ${formatDate(clock.now(), OFFSET)} ${formatTime(clock.now(), OFFSET).padStart(8)}  perf ${status.performance.toFixed(2)}  ${mods}`,
        );
      }
      const task = rng.pick(TASKS);
      let result = await averey.run({ task, effortMinutes: 25 });

      if (result.status === "clarification") {
        asked++;
        const glossary = Object.fromEntries(result.words.map((w) => [w, "a fancy word for something simple"]));
        result = await averey.run({ task, glossary, effortMinutes: 25 });
      }
      if (result.status === "away") {
        away++;
        clock.set(result.backAt);
        continue;
      }
      if (result.status !== "ok") continue;

      tasks++;
      perfSum += result.trace.performance;
      perfMin = Math.min(perfMin, result.trace.performance);
      maxHrs = Math.max(maxHrs, result.trace.hoursWorked24h);
      for (const mod of result.trace.modifiers) {
        if (["tired", "sick", "exposed", "defensive", "apology"].includes(mod.id)) notes.add(mod.id);
      }
      // Idle gap before the next request.
      clock.advance(rng.range(0, 20) * MIN);
    }

    const avg = tasks > 0 ? perfSum / tasks : 0;
    console.log(
      `${formatDate(dayIdx * 24 * HOUR, OFFSET).padEnd(15)}  ${String(tasks).padStart(5)}  ${String(away).padStart(4)}  ${String(asked).padStart(5)}  ${avg.toFixed(2).padStart(7)}  ${(Number.isFinite(perfMin) ? perfMin : 0).toFixed(2).padStart(7)}  ${maxHrs.toFixed(1).padStart(6)}  ${[...notes].join(", ")}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
