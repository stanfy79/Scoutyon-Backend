import { GoogleGenAI, Part, FunctionCall } from "@google/genai";
import { Response } from "express";
import { config } from "../config.js";
import { agentTools } from "./tools.js";
import { SYSTEM_PROMPT } from "./prompts.js";
import { fetchPage } from "../services/webFetcher.js";
import { Quote } from "../models/Quote.js";
import { inspectMerchantPaymentProfile } from "../services/merchantPaymentProfiles.js";
import { discoverVendorsForUser } from "../vendor.service.js";
import { getBudgetSummary, listPurchasesForUser } from "../purchase.service.js";
import { getTokenCatalogue } from "../services/nearTokenRegistry.js";
import { Session, type ISession } from "../models/Session.js";
import { SwapQuote } from "../models/SwapQuote.js";
import { User } from "../models/User.js";
import { PaymentAttempt } from "../models/PaymentAttempt.js";
import { SwapTransfer } from "../models/SwapTransfer.js";
import {
  requestLiveSwapQuote,
  SwapQuoteInputError,
} from "../services/swapQuoteService.js";
import { syncPaymentStatus } from "../services/paymentSettlement.js";
import {
  getSwapTransfer,
  prepareSwapTransfer,
  requestSwapWalletAuthorization,
  syncSwapTransferStatus,
} from "../services/swapTransferService.js";
import {
  buildGeminiContextPrompt,
  buildSessionSummaryFromMessages,
} from "../services/sessionMemory.js";
import { classifyChatIntent } from "./intents.js";

const ai = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });

// ── SSE helpers ──────────────────────────────────────────────────────────────

export type SSEEventType =
  | "session"
  | "intent"
  | "text"
  | "tool_call"
  | "tool_result"
  | "quote"
  | "wallet_action"
  | "error"
  | "done";

export function sendSSE(
  res: Response,
  type: SSEEventType,
  data: unknown,
): void {
  res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
}

async function persistSessionMessage(
  sessionId: string,
  role: "user" | "assistant" | "tool",
  content: string,
  toolName?: string,
): Promise<void> {
  await Session.findByIdAndUpdate(sessionId, {
    $push: {
      messages: {
        role,
        content,
        ...(toolName ? { toolName } : {}),
        timestamp: new Date(),
      },
    },
  });
}

// ── Tool dispatcher ──────────────────────────────────────────────────────────

async function dispatchTool(
  fc: FunctionCall,
  ctx: { sessionId: string; userId: string; budgetId?: string; res: Response },
): Promise<unknown> {
  const { name, args } = fc;

  if (name === "fetch_page") {
    const url = (args as Record<string, string>).url;
    sendSSE(ctx.res, "tool_call", { name, args: { url } });
    const result = await fetchPage(url);
    sendSSE(ctx.res, "tool_result", {
      name,
      preview: result.text.slice(0, 200) + "...",
    });
    return result;
  }

  if (name === "create_quote") {
    const a = args as {
      provider: string;
      description: string;
      price: number;
      currency: string;
      sourceUrl: string;
    };
    sendSSE(ctx.res, "tool_call", { name, args: a });

    let paymentEligibility:
      | "unsupported"
      | "verification_required"
      | "invoice_required" = "verification_required";
    try {
      paymentEligibility = (await inspectMerchantPaymentProfile(a.provider))
        .eligibility;
    } catch {
      sendSSE(ctx.res, "error", {
        tool: "merchant_payment_profile",
        message:
          "Payment verification is unavailable; this quote is research-only until verified.",
      });
    }
    const quote = await Quote.create({
      sessionId: ctx.sessionId,
      userId: ctx.userId,
      budgetId: ctx.budgetId,
      provider: a.provider,
      description: a.description,
      price: a.price,
      currency: a.currency.toUpperCase(),
      sourceUrl: a.sourceUrl,
      status: "pending",
      paymentEligibility,
    });

    const quotePayload = {
      quoteId: quote._id.toString(),
      provider: quote.provider,
      description: quote.description,
      price: quote.price,
      currency: quote.currency,
      sourceUrl: quote.sourceUrl,
      status: quote.status,
      paymentEligibility: quote.paymentEligibility,
    };

    sendSSE(ctx.res, "quote", quotePayload);
    sendSSE(ctx.res, "tool_result", { name, quoteId: quote._id.toString() });

    return { quoteId: quote._id.toString(), status: "created" };
  }

  if (name === "search_vendors") {
    const payload = args as Record<string, unknown>;
    const result = await discoverVendorsForUser(ctx.userId, {
      requirement: String(payload.requirement ?? "Vendor discovery"),
      category:
        typeof payload.category === "string" ? payload.category : undefined,
      keywords: Array.isArray(payload.keywords)
        ? payload.keywords.filter(
            (item): item is string => typeof item === "string",
          )
        : [],
      budget:
        payload.budget && typeof payload.budget === "object"
          ? {
              currency:
                typeof (payload.budget as Record<string, unknown>).currency ===
                "string"
                  ? String((payload.budget as Record<string, unknown>).currency)
                  : undefined,
              minimum:
                typeof (payload.budget as Record<string, unknown>).minimum ===
                "number"
                  ? Number((payload.budget as Record<string, unknown>).minimum)
                  : undefined,
              maximum:
                typeof (payload.budget as Record<string, unknown>).maximum ===
                "number"
                  ? Number((payload.budget as Record<string, unknown>).maximum)
                  : undefined,
            }
          : undefined,
      location:
        typeof payload.location === "string" ? payload.location : undefined,
      specifications: Array.isArray(payload.specifications)
        ? payload.specifications.filter(
            (item): item is string => typeof item === "string",
          )
        : [],
      preferredCharacteristics: Array.isArray(payload.preferredCharacteristics)
        ? payload.preferredCharacteristics.filter(
            (item): item is string => typeof item === "string",
          )
        : [],
      constraints: Array.isArray(payload.constraints)
        ? payload.constraints.filter(
            (item): item is string => typeof item === "string",
          )
        : [],
      candidateUrls: Array.isArray(payload.candidateUrls)
        ? payload.candidateUrls.filter(
            (item): item is string => typeof item === "string",
          )
        : [],
    });
    return result;
  }

  if (name === "list_purchases") {
    return listPurchasesForUser(ctx.userId);
  }

  if (name === "budget_summary") {
    const budgetId = String((args as Record<string, unknown>).budgetId ?? "");
    if (!budgetId) throw new Error("budgetId is required");
    return getBudgetSummary(ctx.userId, budgetId);
  }

  if (name === "supported_assets" || name === "get_supported_assets") {
    return getTokenCatalogue();
  }

  if (name === "get_transfer_quote") {
    const payload = args as Record<string, unknown>;
    const session = await Session.findOne({
      _id: ctx.sessionId,
      userId: ctx.userId,
    }).lean();
    if (!session)
      throw new Error("Session not found for this authenticated user.");
    const memoryParameters = session.sessionSummary?.knownParameters ?? {};
    const transactionContext = session.transactionContext ?? {};
    const hasExplicitTransferParameters = [
      "sourceAsset",
      "destinationAsset",
      "amount",
      "sourceNetwork",
      "destinationNetwork",
      "recipientAddress",
      "refundAddress",
    ].some(
      (key) => typeof payload[key] === "string" && String(payload[key]).trim(),
    );
    if (!hasExplicitTransferParameters && transactionContext.preparationId) {
      const activeTransfer = await SwapTransfer.findOne({
        _id: transactionContext.preparationId,
        userId: ctx.userId,
        sessionId: ctx.sessionId,
      });
      if (
        activeTransfer &&
        ![
          "failed",
          "expired",
          "success",
          "refunded",
          "incomplete_deposit",
        ].includes(activeTransfer.status)
      ) {
        return {
          intent: "transfer_status_request",
          status: activeTransfer.status,
          transfer: await getSwapTransfer(
            ctx.userId,
            ctx.sessionId,
            activeTransfer._id.toString(),
          ),
          message:
            "A general cross-chain transfer is already prepared or in progress. Continue that transfer instead of creating a new quote.",
        };
      }
    }
    const parameter = (key: string, contextKey = key): string | undefined => {
      const value =
        payload[key] ??
        memoryParameters[contextKey] ??
        transactionContext[contextKey as keyof typeof transactionContext];
      return typeof value === "string" && value.trim()
        ? value.trim()
        : undefined;
    };
    const amountValue =
      payload.amount ??
      payload.sourceAmount ??
      memoryParameters.amount ??
      transactionContext.amount;
    const request = {
      sourceAsset: parameter("sourceAsset"),
      destinationAsset: parameter("destinationAsset"),
      amount:
        typeof amountValue === "string" && amountValue.trim()
          ? amountValue.trim()
          : undefined,
      sourceNetwork: parameter("sourceNetwork"),
      destinationNetwork: parameter("destinationNetwork"),
      recipientAddress: parameter("recipientAddress"),
      refundAddress: parameter("refundAddress"),
    };
    const user = await User.findById(ctx.userId).select("walletAddress").lean();

    let result: Awaited<ReturnType<typeof requestLiveSwapQuote>>;
    try {
      result = await requestLiveSwapQuote({
        request,
        tokens: await getTokenCatalogue(),
        walletAddress: user?.walletAddress ?? null,
      });
    } catch (error) {
      if (error instanceof SwapQuoteInputError) {
        return {
          intent: "transfer_quote_request",
          status: "needs_clarification",
          missingFields: error.missingFields,
          message: error.message,
        };
      }
      throw error;
    }

    const persistedQuote = await SwapQuote.create({
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      correlationId: result.quote.correlationId,
      sourceAssetId: result.sourceToken.assetId,
      sourceSymbol: result.sourceToken.symbol,
      sourceBlockchain: result.sourceToken.blockchain,
      sourceDecimals: result.sourceToken.decimals,
      destinationAssetId: result.destinationToken.assetId,
      destinationSymbol: result.destinationToken.symbol,
      destinationBlockchain: result.destinationToken.blockchain,
      destinationDecimals: result.destinationToken.decimals,
      amountIn: result.quote.amountIn,
      requestedAmount: request.amount!,
      amountInFormatted: result.quote.amountInFormatted,
      amountOut: result.quote.amountOut,
      amountOutFormatted: result.quote.amountOutFormatted,
      minAmountOut: result.quote.minAmountOut,
      recipient: result.recipient,
      refundTo: result.refundTo,
      expiresAt: result.quote.expiresAt ?? new Date(Date.now() + 5 * 60 * 1000),
      timeEstimateSeconds: result.quote.timeEstimateSeconds,
      slippageTolerance: config.PAYMENT_SLIPPAGE_BPS,
      providerResponse: result.quote.providerResponse,
      status: "preview",
    });

    await Session.updateOne(
      { _id: ctx.sessionId, userId: ctx.userId },
      {
        $set: {
          "transactionContext.activeTransactionIntent": "cross_chain_swap",
          "transactionContext.sourceAsset": result.sourceToken.symbol,
          "transactionContext.sourceNetwork": result.sourceToken.blockchain,
          "transactionContext.destinationAsset": result.destinationToken.symbol,
          "transactionContext.destinationNetwork":
            result.destinationToken.blockchain,
          "transactionContext.amount": request.amount,
          "transactionContext.recipientAddress": result.recipient,
          "transactionContext.quoteId": persistedQuote._id.toString(),
          "transactionContext.preparationId": null,
          "transactionContext.quoteExpiry":
            result.quote.expiresAt ?? new Date(Date.now() + 5 * 60 * 1000),
          "transactionContext.transactionStatus": "quote_preview",
          "transactionContext.outstandingUserAction": "review_quote",
          "sessionSummary.activeIntent": "transfer_quote_request",
          "sessionSummary.pendingTransactionId": null,
          "sessionSummary.knownParameters.sourceAsset":
            result.sourceToken.symbol,
          "sessionSummary.knownParameters.sourceNetwork":
            result.sourceToken.blockchain,
          "sessionSummary.knownParameters.destinationAsset":
            result.destinationToken.symbol,
          "sessionSummary.knownParameters.destinationNetwork":
            result.destinationToken.blockchain,
          "sessionSummary.knownParameters.amount": request.amount,
          "sessionSummary.knownParameters.recipientAddress": result.recipient,
        },
      },
    );

    const quotePayload = {
      kind: "swap_preview",
      quoteId: persistedQuote._id.toString(),
      correlationId: result.quote.correlationId,
      source: {
        asset: result.sourceToken.symbol,
        network: result.sourceToken.blockchain,
        amount: result.quote.amountInFormatted ?? request.amount,
        amountAtomic: result.quote.amountIn,
      },
      destination: {
        asset: result.destinationToken.symbol,
        network: result.destinationToken.blockchain,
        amount: result.quote.amountOutFormatted,
        amountAtomic: result.quote.amountOut,
        minimumAmount: result.quote.minAmountOut,
      },
      expiresAt: result.quote.expiresAt ?? new Date(Date.now() + 5 * 60 * 1000),
      estimatedTimeSeconds: result.quote.timeEstimateSeconds,
      executable: false,
      feeDisclosure: config.NEAR_INTENTS_JWT
        ? "Fees and route pricing are from the live quote. Network or wallet gas fees may apply separately."
        : "Unauthenticated NEAR Intents quotes include an additional 0.25% service fee. Network or wallet gas fees may apply separately.",
      message:
        "Live NEAR Intents quote preview. A fresh executable quote and explicit wallet authorization are required before funds move.",
    };
    sendSSE(ctx.res, "quote", quotePayload);
    return {
      intent: "transfer_quote_request",
      status: "quote_ready",
      ...quotePayload,
    };
  }

  if (name === "prepare_transfer") {
    const payload = args as Record<string, unknown>;
    const session = await Session.findOne({
      _id: ctx.sessionId,
      userId: ctx.userId,
    }).lean();
    if (!session)
      throw new Error("Session not found for this authenticated user.");
    const quoteId =
      typeof payload.quoteId === "string" && payload.quoteId.trim()
        ? payload.quoteId.trim()
        : session.transactionContext?.quoteId;
    if (!quoteId) {
      return {
        intent: "transfer_prepare_request",
        status: "needs_quote",
        message:
          "There is no active transfer preview in this session. Request and review a quote first.",
      };
    }
    const result = await prepareSwapTransfer({
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      previewId: quoteId,
    });
    if (result.status === "quote_updated" && result.preview) {
      sendSSE(ctx.res, "quote", {
        kind: "swap_preview",
        ...(result.preview as Record<string, unknown>),
      });
    } else if (result.status === "pending_authorization" && result.transfer) {
      sendSSE(ctx.res, "quote", {
        kind: "swap_executable_quote",
        transfer: result.transfer,
      });
    }
    return { intent: "transfer_prepare_request", ...result };
  }

  if (name === "confirm_transaction") {
    const payload = args as Record<string, unknown>;
    const session = await Session.findOne({
      _id: ctx.sessionId,
      userId: ctx.userId,
    }).lean();
    if (!session)
      throw new Error("Session not found for this authenticated user.");
    const transferId =
      typeof payload.transferId === "string" && payload.transferId.trim()
        ? payload.transferId.trim()
        : session.transactionContext?.preparationId;
    if (!transferId) {
      return {
        intent: "transfer_confirm_request",
        status: "needs_preparation",
        message:
          "There is no prepared general swap in this session to authorize.",
      };
    }
    const result = await requestSwapWalletAuthorization({
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      transferId,
      confirm: payload.confirm === true,
    });
    if (result.walletAuthorization)
      sendSSE(ctx.res, "wallet_action", result.walletAuthorization);
    return { intent: "transfer_confirm_request", ...result };
  }

  if (name === "get_transaction_status") {
    const payload = args as Record<string, unknown>;
    const session = await Session.findOne({
      _id: ctx.sessionId,
      userId: ctx.userId,
    }).lean();
    if (!session)
      throw new Error("Session not found for this authenticated user.");
    let paymentId =
      typeof payload.paymentId === "string" ? payload.paymentId.trim() : "";
    if (!paymentId) {
      const rememberedId =
        session.transactionContext?.preparationId ??
        session.sessionSummary?.pendingTransactionId ??
        "";
      if (/^[a-f\d]{24}$/i.test(rememberedId)) {
        const rememberedSwap = await SwapTransfer.findOne({
          _id: rememberedId,
          userId: ctx.userId,
          sessionId: ctx.sessionId,
        })
          .select("_id")
          .lean();
        if (rememberedSwap) paymentId = rememberedId;
        const rememberedPayment = paymentId
          ? null
          : await PaymentAttempt.findOne({
              _id: rememberedId,
              userId: ctx.userId,
            })
              .select("quoteId")
              .lean();
        const belongsToSession = rememberedPayment
          ? await Quote.exists({
              _id: rememberedPayment.quoteId,
              userId: ctx.userId,
              sessionId: ctx.sessionId,
            })
          : false;
        if (belongsToSession) paymentId = rememberedId;
      }
    }

    if (!paymentId) {
      const recentSwaps = await SwapTransfer.find({
        userId: ctx.userId,
        sessionId: ctx.sessionId,
      })
        .sort({ updatedAt: -1 })
        .limit(2)
        .select("_id")
        .lean();
      if (recentSwaps.length === 1) paymentId = recentSwaps[0]!._id.toString();
      if (recentSwaps.length > 1) {
        return {
          intent: "transfer_status_request",
          status: "needs_clarification",
          message:
            "Which cross-chain transfer should I check? Please provide its transfer ID.",
        };
      }
    }

    if (!paymentId) {
      const sessionQuotes = await Quote.find({
        userId: ctx.userId,
        sessionId: ctx.sessionId,
      })
        .select("_id")
        .lean();
      const recentPayments =
        sessionQuotes.length > 0
          ? await PaymentAttempt.find({
              userId: ctx.userId,
              quoteId: { $in: sessionQuotes.map((quote) => quote._id) },
            })
              .sort({ updatedAt: -1 })
              .limit(2)
              .select("_id")
              .lean()
          : [];
      if (recentPayments.length === 0) {
        return {
          intent: "transfer_status_request",
          status: "not_found",
          message: "I could not find a persisted payment to check.",
        };
      }
      if (recentPayments.length > 1) {
        return {
          intent: "transfer_status_request",
          status: "needs_clarification",
          message:
            "Which transfer should I check? Please provide its payment ID.",
        };
      }
      paymentId = String(recentPayments[0]!._id);
    }

    if (!/^[a-f\d]{24}$/i.test(paymentId)) {
      return {
        intent: "transfer_status_request",
        status: "needs_clarification",
        message:
          "I need the payment ID for the prepared transfer you want me to check.",
      };
    }

    const swapTransfer = await SwapTransfer.findOne({
      _id: paymentId,
      userId: ctx.userId,
      sessionId: ctx.sessionId,
    })
      .select("_id")
      .lean();
    if (swapTransfer) {
      const status = await syncSwapTransferStatus(
        ctx.userId,
        ctx.sessionId,
        paymentId,
      );
      const transfer = status.transfer as Record<string, unknown>;
      await Session.updateOne(
        { _id: ctx.sessionId, userId: ctx.userId },
        {
          $set: {
            "transactionContext.preparationId": paymentId,
            "transactionContext.transactionStatus": status.status,
            "transactionContext.outstandingUserAction":
              status.status === "pending_authorization"
                ? "confirm_transfer"
                : null,
          },
        },
      );
      return {
        intent: "transfer_status_request",
        ...status,
        transfer,
        confirmed: status.status === "success",
        message:
          status.status === "success"
            ? "NEAR Intents confirms that this cross-chain transfer settled."
            : `The persisted general transfer status is ${String(status.status)}.`,
      };
    }

    const payment = await syncPaymentStatus(ctx.userId, paymentId);
    await Session.updateOne(
      { _id: ctx.sessionId, userId: ctx.userId },
      {
        $set: {
          "transactionContext.preparationId": payment._id.toString(),
          "transactionContext.transactionStatus": payment.status,
          "transactionContext.outstandingUserAction":
            payment.status === "AWAITING_USER_CONFIRMATION"
              ? "confirm_payment"
              : null,
        },
      },
    );
    return {
      intent: "transfer_status_request",
      status: payment.status,
      paymentId: payment._id.toString(),
      confirmed: payment.status === "SUCCESS",
      destinationTransactionHash: payment.destinationTransactionHash,
      settledAt: payment.settledAt,
      message:
        payment.status === "SUCCESS"
          ? "NEAR Intents confirms that this transfer settled."
          : payment.status === "PROCESSING" ||
              payment.status === "SOURCE_TX_CONFIRMED"
            ? "The transfer is still processing."
            : payment.status === "AWAITING_USER_CONFIRMATION"
              ? "The payment is prepared and awaiting your explicit confirmation."
              : `The persisted payment status is ${payment.status}.`,
    };
  }

  if (name === "get_transaction_history") {
    return {
      intent: "transfer_status_request",
      message:
        "Recent transaction history is fetched from the authenticated user context only.",
    };
  }

  return { error: `Unknown tool: ${name}` };
}

// ── Agent runner ─────────────────────────────────────────────────────────────

export interface RunnerOptions {
  goal: string;
  sessionId: string;
  userId: string;
  budgetId?: string;
  res: Response;
}

const MAX_ITERATIONS = 6;

export async function runAgent(opts: RunnerOptions): Promise<void> {
  const { goal, sessionId, userId, budgetId, res } = opts;
  const session = (await Session.findOne({
    _id: sessionId,
    userId,
  }).lean()) as Partial<ISession> | null;
  if (!session)
    throw new Error("Session not found for this authenticated user.");
  const memoryContext = buildGeminiContextPrompt(session, goal);
  let classification = classifyChatIntent(goal);
  const pendingAction = session.transactionContext?.outstandingUserAction;
  if (
    (pendingAction === "review_prepared_transfer" ||
      pendingAction === "authorize_wallet_transaction") &&
    /^(?:yes|yes please|go ahead|proceed|confirm|confirm it|approve|authorize|send it)[.! ]*$/i.test(
      goal.trim(),
    )
  ) {
    classification = {
      ...classification,
      intent: "transfer_confirm_request",
      status: "awaiting_confirmation",
      requiresUserAction: true,
      requiresExplicitConfirmation: true,
    };
  }
  sendSSE(res, "intent", classification);
  await persistSessionMessage(
    sessionId,
    "assistant",
    `Intent classified as ${classification.intent} (${classification.status}).`,
  );

  if (
    classification.intent === "transfer_prepare_request" ||
    classification.intent === "transfer_confirm_request"
  ) {
    const toolName =
      classification.intent === "transfer_prepare_request"
        ? "prepare_transfer"
        : "confirm_transaction";
    sendSSE(res, "tool_call", { name: toolName, args: {} });
    try {
      const result = await dispatchTool(
        {
          name: toolName,
          args: toolName === "prepare_transfer" ? {} : { confirm: true },
        },
        { sessionId, userId, budgetId, res },
      );
      sendSSE(res, "tool_result", { name: toolName, result });
      const message = (result as { message?: unknown }).message;
      if (typeof message === "string") {
        sendSSE(res, "text", { text: message });
        await persistSessionMessage(sessionId, "assistant", message);
      }
    } catch (error) {
      const failure = error as { code?: string; message?: string };
      const message = failure.message ?? "Transfer action failed.";
      sendSSE(res, "error", { tool: toolName, code: failure.code, message });
      sendSSE(res, "text", { text: message });
      await persistSessionMessage(sessionId, "assistant", message);
    }
    sendSSE(res, "done", {});
    return;
  }

  const chat = ai.chats.create({
    model: config.GEMINI_MODEL,
    config: {
      systemInstruction: `${SYSTEM_PROMPT}\n\nSESSION CONTEXT:\n${memoryContext}`,
      tools: [...agentTools, { googleSearch: {} }],
      toolConfig: {
        includeServerSideToolInvocations: true,
      } as any,
    },
  });

  let nextMessage: any = memoryContext;

  const updatedSummary = buildSessionSummaryFromMessages(
    (session?.messages ?? []).concat({
      role: "user",
      content: goal,
      timestamp: new Date(),
    }),
    session?.sessionSummary,
  );

  await Session.findByIdAndUpdate(sessionId, {
    sessionSummary: updatedSummary,
    status: "active",
  });

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const stream = await chat.sendMessageStream({
      message: nextMessage,
    });

    const functionCalls: FunctionCall[] = [];

    for await (const chunk of stream) {
      const candidate = chunk.candidates?.[0];
      if (!candidate?.content?.parts) continue;

      for (const part of candidate.content.parts as Part[]) {
        if ("text" in part && part.text) {
          sendSSE(res, "text", { text: part.text });
        }
        if ("functionCall" in part && part.functionCall) {
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
        const failure = err as { code?: string; message?: string };
        const message = failure.message ?? String(err);
        sendSSE(res, "error", { tool: fc.name, code: failure.code, message });
        result =
          fc.name === "prepare_transfer" || fc.name === "confirm_transaction"
            ? {
                intent:
                  fc.name === "prepare_transfer"
                    ? "transfer_prepare_request"
                    : "transfer_confirm_request",
                status: "failed",
                error: failure.code ?? "TRANSFER_ACTION_FAILED",
                message,
                retry: false,
              }
            : { error: message, code: failure.code };
      }
      if (fc.name === "prepare_transfer" || fc.name === "confirm_transaction") {
        sendSSE(res, "tool_result", { name: fc.name, result });
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

  sendSSE(res, "done", {});
}
