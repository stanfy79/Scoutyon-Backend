export type ChatIntent =
  | 'general_chat'
  | 'vendor_discovery'
  | 'vendor_verification'
  | 'vendor_quote_request'
  | 'transfer_quote_request'
  | 'transfer_execute_request'
  | 'transfer_prepare_request'
  | 'transfer_confirm_request'
  | 'transfer_status_request';

export type ChatStatus =
  | 'quote_ready'
  | 'preparation_ready'
  | 'awaiting_confirmation'
  | 'awaiting_wallet_authorization'
  | 'processing'
  | 'settled'
  | 'failed'
  | 'clarification_required';

export interface ChatIntentClassification {
  intent: ChatIntent;
  status: ChatStatus;
  requiresUserAction: boolean;
  requiresExplicitConfirmation: boolean;
  missingFields?: string[];
  responseText: string;
  data?: Record<string, unknown>;
}

function buildResult(
  intent: ChatIntent,
  status: ChatStatus,
  responseText: string,
  options: {
    requiresUserAction?: boolean;
    requiresExplicitConfirmation?: boolean;
    missingFields?: string[];
    data?: Record<string, unknown>;
  } = {},
): ChatIntentClassification {
  return {
    intent,
    status,
    requiresUserAction: options.requiresUserAction ?? false,
    requiresExplicitConfirmation: options.requiresExplicitConfirmation ?? false,
    missingFields: options.missingFields,
    responseText,
    data: options.data,
  };
}

export function classifyChatIntent(message: string): ChatIntentClassification {
  const text = message.trim();
  if (!text) {
    return buildResult('general_chat', 'clarification_required', 'I need a bit more detail before I can help with that.', {
      requiresUserAction: true,
      missingFields: ['message'],
    });
  }

  const lower = text.toLowerCase();

  const transferQuoteIndicators = /(how much|estimate|quote|rate|fees?|cost.*(near|eth|usdc)|what.*(rate|fee)|can i get.*for|what.*(quote|fees?))/i;
  const transferExecuteIndicators = /(swap|transfer|send|exchange|move).*(usdc|near|eth|token|asset|crypto)|\b(send|transfer|swap)\s+\d+\b|\b(make it|use base|use near|make that)\b/i;
  const transferPrepareIndicators = /(prepare|proceed|continue|let's proceed|go ahead|continue with the quote|prepare that|prepare the transaction|do the swap|continue this)/i;
  const transferConfirmIndicators =
    /^(?:confirm|i confirm|approve|authorize|yes(?:,?\s+i)?\s+(?:confirm|approve|authorize)|confirm (?:(?:the|this) )?(?:transfer|swap|transaction)|approve (?:(?:the|this) )?(?:transfer|swap|transaction)|authorize (?:(?:the|this) )?(?:transfer|swap|transaction)|send it)[.! ]*$/i;
  const transferStatusIndicators = /(check|status|last transfer|last swap|has it arrived|where is my transfer|transaction status|what about the fees\?|how much did it cost)/i;

  if (transferConfirmIndicators.test(lower)) {
    return buildResult(
      'transfer_confirm_request',
      'awaiting_confirmation',
      'I can continue once the stored payment preparation is validated and the wallet authorization is still valid.',
      { requiresUserAction: true, requiresExplicitConfirmation: true },
    );
  }

  if (transferPrepareIndicators.test(lower)) {
    return buildResult(
      'transfer_prepare_request',
      'preparation_ready',
      'I will retrieve the most recent valid quote and prepare the transfer for review.',
      { requiresUserAction: true },
    );
  }

  if (transferStatusIndicators.test(lower)) {
    return buildResult(
      'transfer_status_request',
      'processing',
      'I can check the current status of the latest transfer or quote once I have the relevant payment record.',
      { requiresUserAction: true },
    );
  }

  if (transferQuoteIndicators.test(lower) && /(near|eth|usdc|base|swap|transfer|quote)/i.test(lower)) {
    return buildResult(
      'transfer_quote_request',
      'quote_ready',
      'I can generate a transfer quote if you provide the source asset, destination asset, and amount.',
      { requiresUserAction: true, missingFields: ['sourceAsset', 'destinationAsset', 'sourceAmount'] },
    );
  }

  if (transferExecuteIndicators.test(lower)) {
    const missingFields: string[] = [];
    if (!/(usdc|near|eth|token|asset|crypto)/i.test(lower)) missingFields.push('sourceAsset');
    if (!/(to\s+(near|eth|usdc)|for\s+(near|eth|usdc)|into\s+(near|eth|usdc)|on\s+base)/i.test(lower)) missingFields.push('destinationAsset');
    if (!/\d+/.test(lower)) missingFields.push('sourceAmount');

    return buildResult(
      'transfer_execute_request',
      missingFields.length > 0 ? 'clarification_required' : 'quote_ready',
      missingFields.length > 0
        ? 'I need a few transaction details before I can prepare the transfer: ' + missingFields.join(', ') + '.'
        : 'I can get a live NEAR Intents quote for the requested swap.',
      {
        requiresUserAction: missingFields.length > 0,
        requiresExplicitConfirmation: false,
        missingFields: missingFields.length > 0 ? missingFields : undefined,
      },
    );
  }

  if (/verify|legit|trustworthy|reliable|registration|check whether this business|risks of buying|is this supplier legitimate|vendor verification/i.test(lower)) {
    return buildResult(
      'vendor_verification',
      'clarification_required',
      'I can verify the vendor once you share the company name, website, or vendor record to review.',
      { requiresUserAction: true, missingFields: ['vendorNameOrUrl'] },
    );
  }

  if (/quote|quotation|compare prices|compare.*offers|get me .* quotation|show.*suppliers|supplier|vendor.*(find|search|look for)|business.*(find|search|look for)/i.test(lower) || /(under \$|budget|deliver to|within \d+\s*(usd|eur|gbp)|supplier for|vendors for)/i.test(lower)) {
    return buildResult(
      'vendor_quote_request',
      'quote_ready',
      'I can prepare a vendor quotation request and compare candidate suppliers once the required items and budget are clear.',
      { requiresUserAction: true, missingFields: ['requirement', 'budget'] },
    );
  }

  if (/(find|search|look for|supplier|vendors?|companies?|providers?|businesses?)/i.test(lower)) {
    return buildResult(
      'vendor_discovery',
      'clarification_required',
      'I can help discover candidate vendors if you tell me the product or service you need and your budget or location.',
      { requiresUserAction: true, missingFields: ['requirement', 'budgetOrLocation'] },
    );
  }

  return buildResult(
    'general_chat',
    'clarification_required',
    'I can help with vendor discovery, quotations, or cross-chain transfer workflows. Tell me which one you want to do.',
    { requiresUserAction: false },
  );
}
