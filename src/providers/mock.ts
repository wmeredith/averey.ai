import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  ProviderCapabilities,
} from "./types.js";

export interface MockProviderOptions {
  respond?: (request: LLMRequest) => string | Promise<string>;
  capabilities?: Partial<ProviderCapabilities>;
}

/** A provider for tests and simulations. Records every request it sees. */
export class MockProvider implements LLMProvider {
  readonly name = "mock";
  readonly capabilities: ProviderCapabilities;
  readonly requests: LLMRequest[] = [];
  private readonly respond: (r: LLMRequest) => string | Promise<string>;

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
    return { text: await this.respond(request) };
  }
}
