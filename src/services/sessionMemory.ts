import type { IMessage, ISession, ISessionMemorySummary, ITransactionContextMemory } from '../models/Session.js';

export const DEFAULT_SESSION_SUMMARY: ISessionMemorySummary = {
  sessionSummary: '',
  activeIntent: 'general_chat',
  knownParameters: {},
  pendingClarifications: [],
  pendingTransactionId: null,
};

export function normalizeSessionSummary(summary?: Partial<ISessionMemorySummary> | null): ISessionMemorySummary {
  return {
    sessionSummary: summary?.sessionSummary ?? DEFAULT_SESSION_SUMMARY.sessionSummary,
    activeIntent: summary?.activeIntent ?? DEFAULT_SESSION_SUMMARY.activeIntent,
    knownParameters: summary?.knownParameters ?? {},
    pendingClarifications: Array.isArray(summary?.pendingClarifications) ? summary.pendingClarifications : [],
    pendingTransactionId: summary?.pendingTransactionId ?? null,
  };
}

export function normalizeTransactionContext(context?: Partial<ITransactionContextMemory> | null): ITransactionContextMemory {
  return {
    activeTransactionIntent: context?.activeTransactionIntent,
    sourceAsset: context?.sourceAsset,
    sourceNetwork: context?.sourceNetwork,
    destinationAsset: context?.destinationAsset,
    destinationNetwork: context?.destinationNetwork,
    amount: context?.amount,
    recipientAddress: context?.recipientAddress,
    quoteId: context?.quoteId ?? null,
    preparationId: context?.preparationId ?? null,
    quoteExpiry: context?.quoteExpiry ?? null,
    preparationExpiry: context?.preparationExpiry ?? null,
    transactionStatus: context?.transactionStatus,
    outstandingUserAction: context?.outstandingUserAction ?? null,
  };
}

export function extractKnownParametersFromText(message: string, current: Record<string, unknown> = {}): Record<string, unknown> {
  const next = { ...current };
  const lower = message.toLowerCase();

  const amountMatch = message.match(/(?:make it|for|swap|send|transfer|amount|of)\s+(\d+(?:\.\d+)?)\b/i);
  if (amountMatch && amountMatch[1]) {
    next.amount = amountMatch[1];
  }

  const sourceAssetMatch = message.match(/\b(USDC|USDT|ETH|NEAR|BTC|SOL)\b/i);
  if (sourceAssetMatch && sourceAssetMatch[1]) {
    next.sourceAsset = sourceAssetMatch[1].toUpperCase();
  }

  const destinationAssetMatch = message.match(/to\s+(USDC|USDT|ETH|NEAR|BTC|SOL)\b/i);
  if (destinationAssetMatch && destinationAssetMatch[1]) {
    next.destinationAsset = destinationAssetMatch[1].toUpperCase();
  }

  if (/\b(Base|Ethereum|Arbitrum|Optimism|Polygon|NEAR|Solana)\b/i.test(message)) {
    const network = message.match(/\b(Base|Ethereum|Arbitrum|Optimism|Polygon|NEAR|Solana)\b/i)?.[1];
    if (network) {
      next.sourceNetwork = network;
    }
  }

  const destinationNetworkMatch = message.match(/to\s+(Base|Ethereum|Arbitrum|Optimism|Polygon|NEAR|Solana)\b/i);
  if (destinationNetworkMatch && destinationNetworkMatch[1]) {
    next.destinationNetwork = destinationNetworkMatch[1];
  }

  const recipientMatch = message.match(/0x[a-fA-F0-9]{20,}/);
  if (recipientMatch && recipientMatch[0]) {
    next.recipientAddress = recipientMatch[0];
  }

  if (/make it\s+\d+/i.test(message) || /instead/i.test(lower)) {
    next.lastChange = 'amount';
  }

  if (/use\s+base|on\s+base|base\s+network/i.test(lower)) {
    next.sourceNetwork = 'Base';
  }

  if (/confirm|approve|proceed/i.test(lower)) {
    next.outstandingUserAction = 'confirm';
  }

  return next;
}

export function buildSessionSummaryFromMessages(
  messages: Array<Pick<IMessage, 'role' | 'content'>>, 
  previousSummary?: Partial<ISessionMemorySummary> | null,
): ISessionMemorySummary {
  const summary = normalizeSessionSummary(previousSummary);
  const knownParameters = { ...(summary.knownParameters ?? {}) };

  for (const message of messages) {
    const parsed = extractKnownParametersFromText(message.content, knownParameters);
    Object.assign(knownParameters, parsed);
  }

  const lastUserMessage = [...messages].reverse().find((message) => message.role === 'user');
  const intent = /swap|transfer|send|quote|prepare|confirm|status|check|vendor|purchase/i.test(lastUserMessage?.content ?? '')
    ? 'transfer_execute_request'
    : summary.activeIntent ?? 'general_chat';

  const referenceSummary = Object.keys(knownParameters).length > 0
    ? `The conversation has established ${Object.entries(knownParameters).map(([key, value]) => `${key}=${String(value)}`).join(', ')}.`
    : 'The session is active and awaiting the next user instruction.';

  const sessionSummary = `${referenceSummary} ${summary.sessionSummary || 'Session is ongoing.'}`.trim();

  return {
    sessionSummary,
    activeIntent: intent,
    knownParameters,
    pendingClarifications: Array.isArray(summary.pendingClarifications) ? summary.pendingClarifications : [],
    pendingTransactionId: summary.pendingTransactionId ?? null,
  };
}

export function buildConversationContext(session?: Partial<ISession> | null, recentLimit = 12) {
  const messages = Array.isArray(session?.messages) ? session.messages.slice(-recentLimit) : [];
  const summary = normalizeSessionSummary(session?.sessionSummary ?? DEFAULT_SESSION_SUMMARY);
  const transactionContext = normalizeTransactionContext(session?.transactionContext ?? {});

  return {
    recentMessages: messages.map((message) => ({
      role: message.role,
      content: message.content,
      timestamp: message.timestamp,
    })),
    sessionSummary: summary,
    activeTransactionContext: transactionContext,
  };
}

export function buildGeminiContextPrompt(
  session: Partial<ISession> | null | undefined,
  latestMessage: string,
): string {
  const context = buildConversationContext(session, 12);
  const summary = context.sessionSummary;
  const transaction = context.activeTransactionContext;
  const recentMessages = context.recentMessages
    .map((message) => `${message.role}: ${message.content}`)
    .join('\n');

  const summaryText = [
    'SESSION CONTEXT',
    summary.sessionSummary ? `Summary: ${summary.sessionSummary}` : 'Summary: No memory summary yet.',
    `Active intent: ${summary.activeIntent ?? 'general_chat'}`,
    `Known parameters: ${JSON.stringify(summary.knownParameters ?? {})}`,
    `Pending clarifications: ${JSON.stringify(summary.pendingClarifications ?? [])}`,
    `Transaction context: ${JSON.stringify(transaction ?? {})}`,
    'RECENT MESSAGE HISTORY',
    recentMessages || 'No prior messages stored.',
    'LATEST USER MESSAGE',
    latestMessage,
  ].join('\n');

  return summaryText;
}
