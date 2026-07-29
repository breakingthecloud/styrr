import { TextBlock, ToolUseBlock, ToolResultBlock, type ContentBlock, type Message } from '@strands-agents/sdk';
import type { ToolSpec, SystemContentBlock } from '@strands-agents/sdk';
import type { StyrToolSchema } from '@carloscortezcloud/styrr-llm';

interface StyrrMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_calls?: { id: string; name: string; arguments: any }[];
}

export function messagesToStyrr(messages: Message[], systemPrompt?: string): StyrrMessage[] {
  const result: StyrrMessage[] = [];

  if (systemPrompt) {
    result.push({ role: 'system', content: systemPrompt });
  }

  for (const msg of messages) {
    if (msg.role === 'user') {
      const text = extractTextContent(msg.content);
      const toolResult = extractToolResult(msg.content);
      if (toolResult) {
        result.push({
          role: 'tool',
          content: toolResult.text,
          tool_call_id: toolResult.toolUseId,
        });
      } else {
        result.push({ role: 'user', content: text });
      }
    } else if (msg.role === 'assistant') {
      const text = extractTextContent(msg.content);
      const toolUses = extractToolUses(msg.content);

      if (toolUses.length > 0) {
        result.push({
          role: 'assistant',
          content: text,
          tool_calls: toolUses.map(tu => ({
            id: tu.toolUseId,
            name: tu.name,
            arguments: tu.input,
          })),
        });
      } else {
        result.push({ role: 'assistant', content: text });
      }
    }
  }

  return result;
}

export function systemPromptToText(systemPrompt: string | SystemContentBlock[]): string {
  if (typeof systemPrompt === 'string') return systemPrompt;
  return systemPrompt
    .filter((block): block is TextBlock => block instanceof TextBlock)
    .map((block: TextBlock) => block.text)
    .join('');
}

function extractTextContent(content: ContentBlock[]): string {
  return content
    .filter((block): block is TextBlock => block instanceof TextBlock)
    .map(block => block.text)
    .join('');
}

function extractToolResult(content: ContentBlock[]): { text: string; toolUseId: string } | null {
  for (const block of content) {
    if (block instanceof ToolResultBlock) {
      const text = block.content
        .filter((c): c is TextBlock => c instanceof TextBlock)
        .map(c => c.text)
        .join('');
      return { text, toolUseId: block.toolUseId };
    }
  }
  return null;
}

function extractToolUses(content: ContentBlock[]): { toolUseId: string; name: string; input: any }[] {
  return content
    .filter((block): block is ToolUseBlock => block instanceof ToolUseBlock)
    .map(block => ({
      toolUseId: block.toolUseId,
      name: block.name,
      input: block.input,
    }));
}

export function toolSpecsToStyrr(specs: ToolSpec[]): StyrToolSchema[] {
  return specs.map(spec => ({
    type: 'function' as const,
    function: {
      name: spec.name,
      description: spec.description,
      parameters: (spec.inputSchema || {}) as object,
    },
  }));
}
