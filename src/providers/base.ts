export interface ProviderCallParams {
  model: string;
  messages: { role: string; content: string; tool_call_id?: string; tool_calls?: any[] }[];
  maxTokens?: number;
  temperature?: number;
  responseFormat?: 'json' | 'text';
  tools?: { type: 'function'; function: { name: string; description: string; parameters: object } }[];
  apiKey?: string;
  baseUrl?: string;
  signal?: AbortSignal;
}

export interface ProviderCallResponse {
  text: string;
  toolCalls?: { id: string; name: string; arguments: any }[];
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  model?: string;
}

export interface StyrProvider {
  readonly name: string;
  call(params: ProviderCallParams): Promise<ProviderCallResponse>;
}
