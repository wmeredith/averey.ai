import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  ProviderCapabilities,
} from "./types.js";

export interface AnthropicProviderOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  /** Some newer models reject `temperature`. Set false to never send it. */
  supportsTemperature?: boolean;
  /** Per-attempt timeout. Default 60s. */
  timeoutMs?: number;
  /** Retries for rate limits, overload, and 5xx errors. Default 2. */
  maxRetries?: number;
  fetch?: typeof fetch;
}

interface AnthropicResponse {
  content?: { type: string; text?: string }[];
  stop_reason?: string;
  error?: { message?: string };
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504, 529]);

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function retryDelayMs(res: Response, attempt: number): number {
  const header = Number(res.headers.get("retry-after"));
  if (Number.isFinite(header) && header > 0) return Math.min(header * 1000, 60_000);
  return Math.min(500 * 2 ** attempt, 8_000) * (0.75 + Math.random() * 0.5);
}

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  readonly capabilities: ProviderCapabilities;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AnthropicProviderOptions = {}) {
    const key = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!key) {
      throw new Error(
        "AnthropicProvider needs an apiKey option or the ANTHROPIC_API_KEY env var.",
      );
    }
    this.apiKey = key;
    this.model = options.model ?? process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5";
    this.baseUrl = options.baseUrl ?? "https://api.anthropic.com";
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.fetchImpl = options.fetch ?? fetch;
    this.capabilities = {
      temperature: options.supportsTemperature ?? true,
      maxTokens: true,
    };
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      system: request.system,
      messages: request.messages,
      // The API requires max_tokens on every request.
      max_tokens: request.maxTokens ?? 1024,
    };
    if (this.capabilities.temperature && request.temperature !== undefined) {
      body.temperature = request.temperature;
    }

    for (let attempt = 0; ; attempt++) {
      const signals = [AbortSignal.timeout(this.timeoutMs)];
      if (request.signal) signals.push(request.signal);
      const res = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.any(signals),
      });

      const raw = await res.text();
      let json: AnthropicResponse | undefined;
      try {
        json = JSON.parse(raw) as AnthropicResponse;
      } catch {
        json = undefined;
      }

      if (!res.ok) {
        if (RETRYABLE.has(res.status) && attempt < this.maxRetries) {
          await sleep(retryDelayMs(res, attempt), request.signal);
          continue;
        }
        const detail = json?.error?.message ?? (raw.slice(0, 200) || res.statusText);
        throw new Error(`Anthropic request failed (${res.status}): ${detail}`);
      }
      if (!json) {
        throw new Error(`Anthropic returned a non-JSON response: ${raw.slice(0, 200)}`);
      }

      const text = (json.content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("");
      return { text, truncated: json.stop_reason === "max_tokens", raw: json };
    }
  }
}
