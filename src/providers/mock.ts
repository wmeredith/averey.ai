import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  ProviderCapabilities,
} from "./types.js";

type Reply = string | LLMResponse;

export interface MockProviderOptions {
  respond?: (request: LLMRequest) => Reply | Promise<Reply>;
  capabilities?: Partial<ProviderCapabilities>;
}

/** A provider for tests and simulations. Records every request it sees. */
export class MockProvider implements LLMProvider {
  readonly name = "mock";
  readonly capabilities: ProviderCapabilities;
  readonly requests: LLMRequest[] = [];
  private readonly respond: (r: LLMRequest) => Reply | Promise<Reply>;

  constructor(options: MockProviderOptions = {}) {
    this.capabilities = {
      temperature: true,
      maxTokens: true,
      ...options.capabilities,
    };
    this.respond =
      options.respond ??
      ((r) => {
        const last = r.messages[r.messages.length - 1]?.content ?? "";
        return `Okay, here is my take on it: ${last.split("\n")[0]}`;
      });
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    this.requests.push(request);
    const reply = await this.respond(request);
    return typeof reply === "string" ? { text: reply } : reply;
  }
}
