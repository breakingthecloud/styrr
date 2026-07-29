import type { StyrModel } from '../index.js';
import type { StyrProvider } from './base.js';
import { OpenAICompatProvider } from './openai-compat.js';
import { BedrockProvider } from './bedrock.js';
import { HuggingFaceProvider } from './huggingface.js';

export type { StyrProvider, ProviderCallParams, ProviderCallResponse } from './base.js';
export { OpenAICompatProvider } from './openai-compat.js';
export { BedrockProvider } from './bedrock.js';
export { HuggingFaceProvider } from './huggingface.js';

const PROVIDER_MAP: Record<string, new () => StyrProvider> = {
  openrouter: OpenAICompatProvider,
  openai: OpenAICompatProvider,
  nvidia: OpenAICompatProvider,
  ollama: OpenAICompatProvider,
  custom: OpenAICompatProvider,
  bedrock: BedrockProvider,
  huggingface: HuggingFaceProvider,
};

const MODEL_PREFIX_MAP: { prefix: string; provider: string }[] = [
  { prefix: 'anthropic.claude', provider: 'bedrock' },
  { prefix: 'meta.llama', provider: 'bedrock' },
  { prefix: 'mistral.mistral', provider: 'bedrock' },
  { prefix: 'amazon.', provider: 'bedrock' },
  { prefix: 'ai21.', provider: 'bedrock' },
  { prefix: 'cohere.', provider: 'bedrock' },
  { prefix: 'huggingface/', provider: 'huggingface' },
  { prefix: 'gpt-', provider: 'openai' },
  { prefix: 'o1', provider: 'openai' },
  { prefix: 'o3', provider: 'openai' },
  { prefix: 'claude-sonnet', provider: 'openai' },
  { prefix: 'claude-haiku', provider: 'openai' },
  { prefix: 'claude-opus', provider: 'openai' },
  { prefix: 'gemini-', provider: 'openai' },
];

export function getProviderForModel(model: StyrModel): StyrProvider {
  if (model.provider && PROVIDER_MAP[model.provider]) {
    return new PROVIDER_MAP[model.provider]();
  }

  if (model.baseUrl) {
    return new OpenAICompatProvider();
  }

  for (const { prefix, provider } of MODEL_PREFIX_MAP) {
    if (model.id.startsWith(prefix)) {
      return new PROVIDER_MAP[provider]();
    }
  }

  return new OpenAICompatProvider();
}
