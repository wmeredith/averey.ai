# Averey.ai

An average intelligence harness. It wraps any LLM with a simulated average human worker: one who reads at a 7th-8th grade level, needs coffee, takes breaks, gets sick, holds grudges for a day, and misremembers what you asked.

This is a harness, not a prompt. The behavior is enforced in code (a clock, state, a seeded RNG), so it is reproducible and testable. The model only sees the *results* as prompt text and API settings.

```ts
import { Averey, AnthropicProvider } from "averey";

const averey = new Averey({
  provider: new AnthropicProvider(), // reads ANTHROPIC_API_KEY
  seed: "alice",                     // same seed, same bad days
});

const res = await averey.run({ task: "Summarize this meeting in three bullets." });

if (res.status === "ok") console.log(res.output, res.trace.performance);
if (res.status === "away") console.log(res.message);             // "Back around 2:15 PM."
if (res.status === "clarification") console.log(res.question);   // 'Sorry, what does "idempotent" mean?'
```

`runWhenAvailable` handles both detours for you: it waits out breaks and, given `onClarification`, answers questions and retries.

```ts
const res = await averey.runWhenAvailable(
  { task, history, signal },   // history: earlier turns; signal: AbortSignal to cancel
  { onClarification: async (question, words) => explain(words) },  // return undefined to stop and ask the user
);
// res.taskId can be passed as `continues` later; res.trace.truncated says if the reply hit the token limit.
```

## How a call works

1. **Availability gate.** Bathroom, meal, social media, the daily online argument, and salary research are scheduled blocks. During one, `run` returns `away` with a return time and does not call the model. `runWhenAvailable` waits it out.
2. **Modifiers.** Independent effects multiply into one `performance` number (see below).
3. **Comprehension.** Long unfamiliar words are asked about (`clarification`), misread as a similar common word, or skimmed. Pass `glossary` to answer; Averey remembers.
4. **Memory.** Tasks are stored. `continues: "<taskId>"` recalls an earlier task, which may have drifted (a number changed, a constraint dropped, blended with another task). The trace shows the original and the recalled version.
5. **Levers.** Lower performance means higher temperature, a smaller `max_tokens`, less of your `context` actually read, and more typos (never inside code fences). Providers that reject `temperature` are compensated for in the prompt.
6. **Persona prompt.** The system prompt describes Averey's condition right now, built from the active modifiers.

## What is modeled

| Trait | Mechanism | Modifier id |
| --- | --- | --- |
| 7-8th grade reader, asks about or misreads words | comprehension filter | n/a |
| Bathroom, meal, social media breaks | scheduled `away` blocks | n/a |
| Pissy until coffee (about 20 min after first engagement each day) | multiplier plus grumpy hint | `pissy` |
| 8 hours of work per rolling 24h, exponential decay beyond | `exp(-k * hoursOver)` | `hours` |
| Overtired days (-33%) | seeded daily roll | `tired` |
| Salary research, may help or hurt | occasional block, outcome weighted by stress | `salary` |
| Sick 3 times a year for 3-6 days | yearly plan, `-35%` | `sick` |
| Sick Averey degrades others | `exposeToIllness`, `AvereyTeam.send`, `interactionPenalty()` | `exposed` |
| 20 min/day arguing online, -15% for an hour after | scheduled block | `argument` |
| Compliment boost for 24h, 96h if sincere | sincerity scorer (heuristic or LLM) | `compliment` |
| Budget stress | slow-drifting daily value, small penalty | `stress` |
| Post-lunch crash (-12% for 90 min after a midday meal) | derived from the meal block | `lunch-dip` |
| Misremembers tasks | lossy memory | n/a |
| Defensive after being wrong, apologizes a day or two later | `reportError()` | `defensive`, `apology` |
| Implicit bias | see below | n/a |

Every number lives in `src/config.ts` and can be overridden per instance; invalid values throw at construction with every problem listed. Switch any effect off with `disabledModifiers: ["tired"]` (unknown ids throw). Add your own effects per instance:

```ts
new Averey({
  provider,
  modifiers: {
    monday: ({ now }) => isMonday(now)
      ? { id: "monday", label: "Monday", multiplier: 0.9, hints: ["It is Monday and you are slow to get going."] }
      : null,
  },
});
```

## Telling Averey things

```ts
await averey.receiveCompliment("Your refund explanation was clear and saved me an hour", "refund policy");
averey.reportError("the totals were wrong");  // defensive for 24-48h, then (usually) apologizes
```

## Implicit bias (optional, off by default)

`AvereyTeam` can model implicit bias among peers. It is intentionally narrow:

- It ships with an **empty profile** and is disabled. You supply the labels and weights.
- It only changes the *probability that Averey second-guesses a peer's message*. Labels are never sent to the model, and no biased or offensive text is generated.
- Averey "mostly tries to overcome it": each decision has a `selfCorrectionRate` chance to cancel the bias.
- Every decision is written to `team.auditLog`, and `team.biasReport()` gives second-guess rates per group, so you can measure disparity and test mitigation.

```ts
const team = new AvereyTeam()
  .add("receiver", new Averey({ provider, config: {
    bias: { enabled: true, strength: 0.15, selfCorrectionRate: 0.6,
            profile: [{ attribute: "group", value: "B", weight: 1 }] },
  }}))
  .addExternal("ann", { group: "A" })
  .addExternal("bo", { group: "B" });

await team.send("bo", "receiver", "Can you check these numbers?");
console.table(team.biasReport());
```

## Time, state, and simulation

- Use a `VirtualClock` to fast-forward. Runs advance it by their effort automatically.
- `FileStateStore("./.averey-state.json")` keeps hours worked, compliments, grudges, and memory across restarts. Without it, every new process is a fresh morning (no coffee yet). A corrupt file logs a warning and starts fresh.
- Calls are booked back to back, like one person working through a queue, so a burst of requests adds hours gradually instead of all at once.
- `averey.status()` shows current performance, active modifiers, hours worked, and availability without making a call.
- Every result has a `trace` (modifiers, levers, comprehension, memory, typo count, system prompt).

```sh
npm run simulate -- --days 14 --seed demo      # daily summary
npm run simulate -- --days 3 --verbose         # performance timeline
```

## Providers

Implement `LLMProvider` (`complete(request)` plus `capabilities`) to add one; honor `request.signal` and set `truncated` on the response if you can. `AnthropicProvider` talks to the Messages API over `fetch` with no SDK. It retries rate limits, overload, and 5xx errors (`maxRetries`, default 2, honoring `retry-after`) and times out each attempt (`timeoutMs`, default 60s). If your model rejects `temperature`, pass `supportsTemperature: false`. `MockProvider` is for tests.

## Development

```sh
npm install
npm test
npm run typecheck
```
