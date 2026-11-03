import { GoogleGenAI, Content, Part, FunctionCall } from '@google/genai';
import { Response } from 'express';
import { config } from '../config.js';
import { agentTools } from './tools.js';
import { SYSTEM_PROMPT } from './prompts.js';
import { fetchPage } from '../services/webFetcher.js';
import { Quote } from '../models/Quote.js';

const ai = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });

// ── SSE helpers ──────────────────────────────────────────────────────────────

export type SSEEventType =
  | 'session'
  | 'text'
  | 'tool_call'
  | 'tool_result'
  | 'quote'
  | 'error'
  | 'done';

export function sendSSE(res: Response, type: SSEEventType, data: unknown): void {
  res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
}

// ── Tool dispatcher ──────────────────────────────────────────────────────────

async function dispatchTool(
  fc: FunctionCall,
  ctx: { sessionId: string; userId: string; budgetId?: string; res: Response },
): Promise<unknown> {
  const { name, args } = fc;

  if (name === 'fetch_page') {
    const url = (args as Record<string, string>).url;
    sendSSE(ctx.res, 'tool_call', { name, args: { url } });
    const result = await fetchPage(url);
    sendSSE(ctx.res, 'tool_result', { name, preview: result.text.slice(0, 200) + '...' });
    return result;
  }

  if (name === 'create_quote') {
    const a = args as {
      provider: string;
      description: string;
      price: number;
      currency: string;
      sourceUrl: string;
    };
    sendSSE(ctx.res, 'tool_call', { name, args: a });

    const quote = await Quote.create({
      sessionId: ctx.sessionId,
      userId: ctx.userId,
      budgetId: ctx.budgetId,
      provider: a.provider,
      description: a.description,
      price: a.price,
      currency: a.currency.toUpperCase(),
      sourceUrl: a.sourceUrl,
      status: 'pending',
    });

    const quotePayload = {
      quoteId: quote._id.toString(),
      provider: quote.provider,
      description: quote.description,
      price: quote.price,
      currency: quote.currency,
      sourceUrl: quote.sourceUrl,
      status: quote.status,
    };

    sendSSE(ctx.res, 'quote', quotePayload);
    sendSSE(ctx.res, 'tool_result', { name, quoteId: quote._id.toString() });

    return { quoteId: quote._id.toString(), status: 'created' };
  }

  return { error: `Unknown tool: ${name}` };
}

// ── Agent runner ─────────────────────────────────────────────────────────────

export interface RunnerOptions {
  goal: string;
  sessionId: string;
  userId: string;
  budgetId?: string;
  history: Content[];
  res: Response;
}

const MAX_ITERATIONS = 6;

export async function runAgent(opts: RunnerOptions): Promise<void> {
  const { goal, sessionId, userId, budgetId, res } = opts;

  const chat = ai.chats.create({
    model: config.GEMINI_MODEL,
    config: {
      systemInstruction: SYSTEM_PROMPT,
      tools: [
        ...agentTools,
        { googleSearch: {} },
      ],
      toolConfig: {
        includeServerSideToolInvocations: true,
      } as any,
    },
  });

  let nextMessage: any = goal;

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const stream = await chat.sendMessageStream({
      message: nextMessage,
    });

    const functionCalls: FunctionCall[] = [];

    for await (const chunk of stream) {
      const candidate = chunk.candidates?.[0];
      if (!candidate?.content?.parts) continue;

      for (const part of candidate.content.parts as Part[]) {
        if ('text' in part && part.text) {
          sendSSE(res, 'text', { text: part.text });
        }
        if ('functionCall' in part && part.functionCall) {
          functionCalls.push(part.functionCall as FunctionCall);
        }
      }
    }

    // No function calls → agent has finalized its recommendation
    if (functionCalls.length === 0) break;

    // Execute each tool call and collect results
    const toolResultParts: Part[] = [];

    for (const fc of functionCalls) {
      let result: unknown;
      try {
        result = await dispatchTool(fc, { sessionId, userId, budgetId, res });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sendSSE(res, 'error', { tool: fc.name, message });
        result = { error: message };
      }

      toolResultParts.push({
        functionResponse: {
          name: fc.name,
          response: { result },
        },
      });
    }

    // Next iteration sends the tool result parts back into the chat session
    nextMessage = toolResultParts;
  }

  sendSSE(res, 'done', {});
}
