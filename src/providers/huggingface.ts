import type { StyrProvider, ProviderCallParams, ProviderCallResponse } from './base.js';
import type { StyrStreamEvent } from '../stream.js';
import { openAIStreamToEvents } from '../stream.js';

export class HuggingFaceProvider implements StyrProvider {
  readonly name = 'huggingface';

  async call(params: ProviderCallParams): Promise<ProviderCallResponse> {
    const { model, messages, maxTokens, temperature, tools, signal } = params;
    const apiKey = params.apiKey || '';
    const baseUrl = params.baseUrl || 'https://api-inference.huggingface.co';

    const modelId = model.replace('huggingface/', '');

    const prompt = buildPrompt(modelId, messages);

    const body: Record<string, any> = {
      inputs: prompt,
      parameters: {
        max_new_tokens: maxTokens ?? 4096,
        temperature: temperature ?? 0.7,
        return_full_text: false,
      },
    };

    if (tools?.length) {
      body.parameters.tools = tools.map(t => ({
        type: 'function',
        function: {
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
        },
      }));
    }

    const response = await fetch(`${baseUrl}/models/${modelId}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      const err: any = new Error(`HuggingFace ${response.status}: ${errBody.slice(0, 200)}`);
      err.status = response.status;
      throw err;
    }

    const data = await response.json() as any;

    if (Array.isArray(data)) {
      return { text: data[0]?.generated_text || '' };
    }

    const choice = data.choices?.[0];
    const text = choice?.message?.content || '';
    const toolCalls = choice?.message?.tool_calls?.map((tc: any) => ({
      id: tc.id,
      name: tc.function?.name,
      arguments: tryParseJSON(tc.function?.arguments),
    }));

    return {
      text,
      toolCalls: toolCalls?.length ? toolCalls : undefined,
      usage: data.usage ? {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens,
      } : undefined,
    };
  }

  async *stream(params: ProviderCallParams): AsyncGenerator<StyrStreamEvent> {
    const result = await this.call(params);
    yield { type: 'text_delta', text: result.text };
    yield { type: 'done', modelUsed: params.model, usage: result.usage };
  }
}

function buildPrompt(modelId: string, messages: { role: string; content: string }[]): string {
  const sysMsg = messages.find(m => m.role === 'system');
  const otherMsgs = messages.filter(m => m.role !== 'system');

  let prompt = '';
  if (sysMsg) prompt += `<|system|>\n${sysMsg.content}\n`;

  for (const msg of otherMsgs) {
    if (msg.role === 'user') {
      prompt += `<|user|>\n${msg.content}\n`;
    } else if (msg.role === 'assistant') {
      prompt += `<|assistant|>\n${msg.content}\n`;
    }
  }

  prompt += `<|assistant|>\n`;
  return prompt;
}

function tryParseJSON(text: string | undefined): any {
  if (!text) return undefined;
  try {
    const cleaned = text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
    return JSON.parse(cleaned);
  } catch {
    return undefined;
  }
}
