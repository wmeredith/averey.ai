export interface ProviderCapabilities {
  /** Whether the model accepts a temperature setting. */
  temperature: boolean;
  /** Whether the model accepts a max output tokens setting. */
  maxTokens: boolean;
}

export interface LLMMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LLMRequest {
  system: string;
  messages: LLMMessage[];
  temperature?: number;
  maxTokens?: number;
}

export interface LLMResponse {
  text: string;
  raw?: unknown;
}

export interface LLMProvider {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  complete(request: LLMRequest): Promise<LLMResponse>;
}
