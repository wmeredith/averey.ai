/**
 * Smoke test: send one real message through Averey to Anthropic.
 *
 *   npm run hello
 *   npm run hello -- "Explain what a mortgage is."
 *
 * Needs ANTHROPIC_API_KEY (loaded from .env by the npm script).
 */
import { Averey } from "../averey.js";
import { AnthropicProvider } from "../providers/anthropic.js";

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "ANTHROPIC_API_KEY is not set. Put it in .env (ANTHROPIC_API_KEY=sk-ant-...) and save the file.",
    );
    process.exit(1);
  }

  const task = process.argv.slice(2).join(" ") || "Say hi and tell me what you are working on today.";
  const averey = new Averey({ provider: new AnthropicProvider() });

  const result = await averey.runWhenAvailable({ task }, { maxWaitMs: 0 });

  if (result.status === "away") {
    console.log(`Averey is away: ${result.message}`);
    return;
  }
  if (result.status === "clarification") {
    console.log(`Averey asks: ${result.question}`);
    return;
  }

  console.log(result.output);
  console.log("\n--- trace ---");
  console.log(`performance: ${result.trace.performance.toFixed(2)}`);
  for (const m of result.trace.modifiers) {
    console.log(`  ${m.id.padEnd(10)} x${m.multiplier.toFixed(2)}  ${m.label}`);
  }
  const l = result.trace.levers;
  if (l) {
    console.log(
      `levers: temperature=${l.temperature?.toFixed(2) ?? "n/a"} maxTokens=${l.maxTokens} context=${(l.contextFraction * 100).toFixed(0)}%`,
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
