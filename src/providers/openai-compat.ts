import type { StyrProvider, ProviderCallParams, ProviderCallResponse } from './base.js';

export class OpenAICompatProvider implements StyrProvider {
  readonly name = 'openai-compat';

  async call(params: ProviderCallParams): Promise<ProviderCallResponse> {
    const { model, messages, maxTokens, temperature, responseFormat, tools, signal } = params;
    const baseUrl = params.baseUrl || 'https://openrouter.ai/api/v1';
    const apiKey = params.apiKey || '';

    const normalizedMessages = messages.map(m => {
      const msg: any = { role: m.role, content: m.content };
      if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
      if (m.tool_calls?.length) {
        msg.tool_calls = m.tool_calls.map((tc: any) => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name || tc.function?.name,
            arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments || tc.function?.arguments || {}),
          },
        }));
      }
      return msg;
    });

    const body: any = {
      model,
      messages: normalizedMessages,
      max_tokens: maxTokens ?? 4096,
      temperature: temperature ?? 0.7,
    };

    if (tools?.length) body.tools = tools;
    if (responseFormat === 'json') body.response_format = { type: 'json_object' };

    const response = await fetch(`${baseUrl}/chat/completions`, {
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
      const err: any = new Error(`${response.status}: ${errBody.slice(0, 200)}`);
      err.status = response.status;
      throw err;
    }

    const data = await response.json() as any;
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
