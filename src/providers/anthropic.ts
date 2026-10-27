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
  fetch?: typeof fetch;
}

interface AnthropicResponse {
  content?: { type: string; text?: string }[];
  error?: { message?: string };
}

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  readonly capabilities: ProviderCapabilities;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
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

    const res = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as AnthropicResponse;
    if (!res.ok) {
      throw new Error(
        `Anthropic request failed (${res.status}): ${json.error?.message ?? "unknown error"}`,
      );
    }
    const text = (json.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
    return { text, raw: json };
  }
}
