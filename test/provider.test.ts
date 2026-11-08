import { describe, expect, it } from "vitest";
import { AnthropicProvider } from "../src/index.js";

type Reply = { status: number; body: string; headers?: Record<string, string> };

function fakeFetch(replies: Reply[]) {
  const calls: RequestInit[] = [];
  const impl = (async (_url: string, init: RequestInit) => {
    calls.push(init);
    const r = replies[Math.min(calls.length - 1, replies.length - 1)]!;
    return new Response(r.body, { status: r.status, headers: r.headers });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const OK = JSON.stringify({ content: [{ type: "text", text: "hi" }], stop_reason: "end_turn" });
const request = { system: "s", messages: [{ role: "user" as const, content: "x" }] };

describe("AnthropicProvider", () => {
  it("returns text and reports truncation", async () => {
    const cut = JSON.stringify({ content: [{ type: "text", text: "half" }], stop_reason: "max_tokens" });
    const ok = new AnthropicProvider({ apiKey: "k", fetch: fakeFetch([{ status: 200, body: OK }]).impl });
    expect(await ok.complete(request)).toMatchObject({ text: "hi", truncated: false });
    const short = new AnthropicProvider({ apiKey: "k", fetch: fakeFetch([{ status: 200, body: cut }]).impl });
    expect(await short.complete(request)).toMatchObject({ text: "half", truncated: true });
  });

  it("gives a readable error for a non-JSON error page", async () => {
    const { impl } = fakeFetch([{ status: 400, body: "<html>Bad Gateway</html>" }]);
    const p = new AnthropicProvider({ apiKey: "k", fetch: impl, maxRetries: 0 });
    await expect(p.complete(request)).rejects.toThrow(/\(400\): <html>Bad Gateway/);
  });

  it("retries overload and rate limits, honoring retry-after", async () => {
    const { impl, calls } = fakeFetch([
      { status: 529, body: JSON.stringify({ error: { message: "overloaded" } }), headers: { "retry-after": "0.01" } },
      { status: 429, body: "{}", headers: { "retry-after": "0.01" } },
      { status: 200, body: OK },
    ]);
    const p = new AnthropicProvider({ apiKey: "k", fetch: impl, maxRetries: 2 });
    expect((await p.complete(request)).text).toBe("hi");
    expect(calls).toHaveLength(3);
  });

  it("gives up after maxRetries and does not retry client errors", async () => {
    const overloaded = fakeFetch([{ status: 529, body: JSON.stringify({ error: { message: "overloaded" } }), headers: { "retry-after": "0.01" } }]);
    const p = new AnthropicProvider({ apiKey: "k", fetch: overloaded.impl, maxRetries: 1 });
    await expect(p.complete(request)).rejects.toThrow(/529.*overloaded/);
    expect(overloaded.calls).toHaveLength(2);

    const bad = fakeFetch([{ status: 400, body: JSON.stringify({ error: { message: "bad request" } }) }]);
    const q = new AnthropicProvider({ apiKey: "k", fetch: bad.impl, maxRetries: 3 });
    await expect(q.complete(request)).rejects.toThrow(/bad request/);
    expect(bad.calls).toHaveLength(1);
  });

  it("passes an abort signal to fetch", async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: OK }]);
    const p = new AnthropicProvider({ apiKey: "k", fetch: impl });
    const controller = new AbortController();
    await p.complete({ ...request, signal: controller.signal });
    const sent = calls[0]!.signal!;
    expect(sent.aborted).toBe(false);
    controller.abort();
    expect(sent.aborted).toBe(true);
  });
});
