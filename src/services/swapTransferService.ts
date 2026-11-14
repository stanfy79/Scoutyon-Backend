import { decodeFunctionData, encodeFunctionData, isAddress, isHash, parseAbi } from 'viem';
import { config } from '../config.js';
import { Session } from '../models/Session.js';
import { SwapQuote, type ISwapQuote } from '../models/SwapQuote.js';
import { SwapTransfer, type ISwapTransfer, type SwapTransferStatus } from '../models/SwapTransfer.js';
import { User } from '../models/User.js';
import { createExactInputExecutableQuote, getExecutionStatus, submitDepositTransaction } from './nearIntents.js';
import { getTokenCatalogue } from './nearTokenRegistry.js';
import { assertServerSignerConfigured } from './privyWalletSender.js';
import {
  assertAllowedBasePaymentTransaction,
  type PrivySignerDependencies,
} from './privyPaymentSigner.js';
import { assertSufficientBalance, hasEvmChainRpc, verifyConfiguredErc20Transfer } from './walletBalance.js';
import { requestLiveSwapQuote } from './swapQuoteService.js';

const transferAbi = parseAbi([
  'function transfer(address to, uint256 value) returns (bool)',
]);
const terminalStatuses = new Set<SwapTransferStatus>(['success', 'failed', 'expired', 'refunded', 'incomplete_deposit']);

function failure(message: string, code: string, statusCode = 409) {
  return Object.assign(new Error(message), { code, statusCode });
}

function formatAtomic(amount: string, decimals: number): string {
  const padded = amount.padStart(decimals + 1, '0');
  if (decimals === 0) return padded;
  const fraction = padded.slice(-decimals).replace(/0+$/, '');
  return fraction ? `${padded.slice(0, -decimals)}.${fraction}` : padded.slice(0, -decimals);
}

function sourceChainId(blockchain: string): number | null {
  const chains: Record<string, number> = {
    eth: 1,
    ethereum: 1,
    arb: 42161,
    arbitrum: 42161,
    base: 8453,
    op: 10,
    optimism: 10,
    pol: 137,
    polygon: 137,
    bsc: 56,
    avax: 43114,
    avalanche: 43114,
  };
  return chains[blockchain.trim().toLowerCase()] ?? null;
}

function serializeTransfer(transfer: ISwapTransfer) {
  return {
    id: transfer._id.toString(),
    previewId: transfer.previewId.toString(),
    status: transfer.status,
    source: {
      assetId: transfer.sourceAssetId,
      symbol: transfer.sourceSymbol,
      blockchain: transfer.sourceBlockchain,
      decimals: transfer.sourceDecimals,
      chainId: transfer.sourceChainId,
      tokenAddress: transfer.sourceTokenAddress,
      amountAtomic: transfer.amountIn,
    },
    destination: {
      assetId: transfer.destinationAssetId,
      symbol: transfer.destinationSymbol,
      blockchain: transfer.destinationBlockchain,
      decimals: transfer.destinationDecimals,
      recipient: transfer.recipient,
      amountAtomic: transfer.amountOut,
      minimumAmountAtomic: transfer.minAmountOut,
      receivedAmountAtomic: transfer.receivedAmount,
    },
    refundTo: transfer.refundTo,
    quoteCorrelationId: transfer.quoteCorrelationId,
    depositAddress: transfer.depositAddress,
    depositMemo: transfer.depositMemo,
    signerId: transfer.signerId,
    signerPolicyId: transfer.signerPolicyId,
    expiresAt: transfer.quoteDeadline,
    sourceTransactionHash: transfer.sourceTransactionHash,
    destinationTransactionHash: transfer.destinationTransactionHash,
    destinationExplorerUrl: transfer.destinationExplorerUrl,
    providerStatus: transfer.providerStatus,
    depositedAmountAtomic: transfer.depositedAmount,
    refundAmountAtomic: transfer.refundAmount,
    errorCode: transfer.errorCode,
    errorMessage: transfer.errorMessage,
    createdAt: transfer.createdAt,
    updatedAt: transfer.updatedAt,
  };
}

function authorizationAction(transfer: ISwapTransfer) {
  if (!transfer.depositAddress || !isAddress(transfer.depositAddress)) {
    throw failure('The prepared transfer has no valid EVM deposit address.', 'SWAP_DEPOSIT_INSTRUCTIONS_INVALID', 502);
  }
  const calldata = encodeFunctionData({
    abi: transferAbi,
    functionName: 'transfer',
    args: [transfer.depositAddress, BigInt(transfer.amountIn)],
  });
  return {
    type: 'privy_wallet_send_transaction',
    transferId: transfer._id.toString(),
    sessionId: transfer.sessionId.toString(),
    walletId: transfer.walletId,
    idempotencyKey: transfer.idempotencyKey,
    from: transfer.walletAddress,
    chainId: transfer.sourceChainId,
    caip2: `eip155:${transfer.sourceChainId}`,
    transaction: {
      to: transfer.sourceTokenAddress,
      data: calldata,
      value: '0x0',
    },
    reviewedTransfer: {
      sourceAssetId: transfer.sourceAssetId,
      sourceSymbol: transfer.sourceSymbol,
      sourceBlockchain: transfer.sourceBlockchain,
      amountAtomic: transfer.amountIn,
      tokenContract: transfer.sourceTokenAddress,
      recipient: transfer.depositAddress,
      destinationAssetId: transfer.destinationAssetId,
      destinationSymbol: transfer.destinationSymbol,
      destinationBlockchain: transfer.destinationBlockchain,
      destinationRecipient: transfer.recipient,
      expectedAmountOutAtomic: transfer.amountOut,
      minimumAmountOutAtomic: transfer.minAmountOut,
      refundTo: transfer.refundTo,
      expiresAt: transfer.quoteDeadline,
    },
    submitTransactionHashTo: `/api/transfers/${transfer._id.toString()}/submit`,
    authorizationRequired: true,
  };
}

async function createFreshPreview(
  userId: string,
  sessionId: string,
  oldPreview: ISwapQuote | null,
) {
  if (!oldPreview) throw failure('The original transfer preview could not be found.', 'SWAP_PREVIEW_NOT_FOUND', 404);
  const requestedAmount = oldPreview.requestedAmount || oldPreview.amountInFormatted ||
    formatAtomic(oldPreview.amountIn, oldPreview.sourceDecimals);
  const user = await User.findById(userId).select('walletAddress').lean();
  const result = await requestLiveSwapQuote({
    request: {
      sourceAsset: oldPreview.sourceAssetId,
      destinationAsset: oldPreview.destinationAssetId,
      amount: requestedAmount,
      sourceNetwork: oldPreview.sourceBlockchain,
      destinationNetwork: oldPreview.destinationBlockchain,
      recipientAddress: oldPreview.recipient,
      refundAddress: oldPreview.refundTo,
    },
    tokens: await getTokenCatalogue(),
    walletAddress: user?.walletAddress ?? null,
  });
  const replacement = await SwapQuote.create({
    userId,
    sessionId,
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
    requestedAmount,
    amountInFormatted: result.quote.amountInFormatted,
    amountOut: result.quote.amountOut,
    amountOutFormatted: result.quote.amountOutFormatted,
    minAmountOut: result.quote.minAmountOut,
    recipient: result.recipient,
    refundTo: result.refundTo,
    expiresAt: result.quote.expiresAt ?? new Date(Date.now() + 5 * 60 * 1000),
    timeEstimateSeconds: result.quote.timeEstimateSeconds,
    slippageTolerance: oldPreview.slippageTolerance,
    providerResponse: result.quote.providerResponse,
    status: 'preview',
  });
  await Session.updateOne(
    { _id: sessionId, userId },
    {
      $set: {
        'transactionContext.quoteId': replacement._id.toString(),
        'transactionContext.preparationId': null,
        'transactionContext.quoteExpiry': replacement.expiresAt,
        'transactionContext.transactionStatus': 'quote_preview',
        'transactionContext.outstandingUserAction': 'review_quote',
      },
    },
  );
  return {
    status: 'quote_updated',
    preview: {
      quoteId: replacement._id.toString(),
      correlationId: replacement.correlationId,
      source: { asset: replacement.sourceSymbol, network: replacement.sourceBlockchain, amount: replacement.amountInFormatted ?? requestedAmount, amountAtomic: replacement.amountIn },
      destination: { asset: replacement.destinationSymbol, network: replacement.destinationBlockchain, amount: replacement.amountOutFormatted, amountAtomic: replacement.amountOut, minimumAmount: replacement.minAmountOut },
      expiresAt: replacement.expiresAt,
      executable: false,
    },
    requiresReview: true,
    message: 'The previous quote expired. A fresh quote has been created; review its updated terms before preparing the transfer.',
  };
}

export async function prepareSwapTransfer(input: {
  userId: string;
  sessionId: string;
  previewId: string;
  signerDependencies?: Partial<PrivySignerDependencies>;
}): Promise<Record<string, unknown>> {
  if (!/^[a-f\d]{24}$/i.test(input.previewId)) throw failure('A valid preview ID is required.', 'SWAP_PREVIEW_ID_INVALID', 400);
  const [session, preview] = await Promise.all([
    Session.findOne({ _id: input.sessionId, userId: input.userId }).select('_id').lean(),
    SwapQuote.findOne({ _id: input.previewId, userId: input.userId, sessionId: input.sessionId }),
  ]);
  if (!session) throw failure('The transfer preview is not in this authenticated session.', 'SWAP_PREVIEW_NOT_FOUND', 404);
  if (!preview) throw failure('The transfer preview is not in this authenticated session.', 'SWAP_PREVIEW_NOT_FOUND', 404);

  const existing = await SwapTransfer.findOne({ previewId: preview._id });
  if (existing) {
    if (existing.status === 'pending_authorization') {
      return { status: existing.status, transfer: serializeTransfer(existing), requiresExplicitConfirmation: true };
    }
    if (existing.status === 'preparing' || existing.status === 'preparation_unknown') {
      return { status: existing.status, transferId: existing._id.toString(), message: 'Transfer preparation has an unresolved provider outcome. Do not retry or create another quote.' };
    }
    return { status: existing.status, transfer: serializeTransfer(existing) };
  }
  if (preview.status !== 'preview') {
    throw failure('This preview can no longer be prepared. Request a fresh quote.', 'SWAP_PREVIEW_NOT_PREPARABLE');
  }
  const previewExpiry = preview.expiresAt ?? new Date(preview.createdAt.getTime() + 5 * 60 * 1000);
  if (previewExpiry.getTime() <= Date.now()) {
    preview.status = 'expired';
    await preview.save();
    return createFreshPreview(input.userId, input.sessionId, preview);
  }

  const liveTokens = await getTokenCatalogue();
  const sourceToken = liveTokens.find((token) => token.assetId === preview.sourceAssetId);
  const destinationToken = liveTokens.find((token) => token.assetId === preview.destinationAssetId);
  if (
    !sourceToken ||
    sourceToken.blockchain !== preview.sourceBlockchain ||
    sourceToken.decimals !== preview.sourceDecimals ||
    sourceToken.symbol !== preview.sourceSymbol ||
    !sourceToken.contractAddress ||
    !isAddress(sourceToken.contractAddress) ||
    !destinationToken ||
    destinationToken.blockchain !== preview.destinationBlockchain ||
    destinationToken.decimals !== preview.destinationDecimals
  ) {
    throw failure('The preview source or destination asset metadata no longer matches the live NEAR Intents registry.', 'TOKEN_NOT_SUPPORTED', 409);
  }
  const chainId = sourceChainId(preview.sourceBlockchain);
  if (
    chainId === null ||
    !hasEvmChainRpc(chainId)
  ) {
    throw failure(
      'This source asset cannot be prepared. Its EVM network must be supported and have a matching configured RPC endpoint.',
      'SWAP_SOURCE_ROUTE_UNSUPPORTED',
      409,
    );
  }
  const user = await User.findById(input.userId).lean();
  if (!user?.walletId || !user.walletAddress || !user.privyUserId || user.walletProvisioningStatus !== 'completed') {
    throw failure('The authenticated user does not have a provisioned Privy wallet.', 'WALLET_NOT_FOUND', 409);
  }
  if (!isAddress(preview.recipient) || !isAddress(preview.refundTo)) {
    throw failure('The prepared EVM route has an invalid recipient or refund address.', 'SWAP_ADDRESS_INVALID', 400);
  }
  assertAllowedBasePaymentTransaction(chainId, sourceToken.contractAddress, preview.amountIn);
  const signerVerification = await assertServerSignerConfigured(
    user.walletId,
    user.walletAddress,
    user.privyUserId,
    input.signerDependencies?.walletLookup,
    input.signerDependencies,
  );
  await User.updateOne(
    { _id: user._id, privyUserId: user.privyUserId },
    {
      $set: {
        'paymentSignerAuthorization.status': 'authorized',
        'paymentSignerAuthorization.walletId': signerVerification.walletId,
        'paymentSignerAuthorization.signerId': signerVerification.signerId,
        'paymentSignerAuthorization.policyId': signerVerification.policyId,
        'paymentSignerAuthorization.verifiedAt': signerVerification.verifiedAt,
      },
    },
  );

  let transfer: ISwapTransfer;
  try {
    transfer = await SwapTransfer.create({
      userId: input.userId,
      sessionId: input.sessionId,
      previewId: preview._id,
      idempotencyKey: `swap:${preview._id.toString()}`,
      status: 'preparing',
      sourceAssetId: sourceToken.assetId,
      sourceSymbol: sourceToken.symbol,
      sourceBlockchain: sourceToken.blockchain,
      sourceDecimals: sourceToken.decimals,
      sourceChainId: chainId,
      sourceTokenAddress: sourceToken.contractAddress,
      walletId: user.walletId,
      walletAddress: user.walletAddress,
      signerId: signerVerification.signerId,
      signerPolicyId: signerVerification.policyId,
      destinationAssetId: preview.destinationAssetId,
      destinationSymbol: destinationToken.symbol,
      destinationBlockchain: destinationToken.blockchain,
      destinationDecimals: destinationToken.decimals,
      recipient: preview.recipient,
      refundTo: preview.refundTo,
      amountIn: preview.amountIn,
    });
  } catch (error) {
    if ((error as { code?: number }).code === 11000) {
      const concurrent = await SwapTransfer.findOne({ previewId: preview._id });
      if (concurrent) {
        return { status: concurrent.status, transfer: serializeTransfer(concurrent) };
      }
    }
    throw error;
  }

  try {
    const executable = await createExactInputExecutableQuote({
      originAsset: preview.sourceAssetId,
      destinationAsset: preview.destinationAssetId,
      amountIn: preview.amountIn,
      recipient: preview.recipient,
      refundTo: preview.refundTo,
      slippageTolerance: preview.slippageTolerance,
    });
    if (!isAddress(executable.depositAddress)) {
      throw failure('NEAR Intents returned a deposit address that is not valid for the EVM source route.', 'SWAP_DEPOSIT_INSTRUCTIONS_INVALID', 502);
    }
    if (!executable.minAmountOut) {
      throw failure('NEAR Intents executable quote omitted the minimum output amount.', 'SWAP_QUOTE_MINIMUM_MISSING', 502);
    }
    const prepared = await SwapTransfer.findOneAndUpdate(
      { _id: transfer._id, status: 'preparing' },
      {
        $set: {
          status: 'pending_authorization',
          quoteCorrelationId: executable.correlationId,
          providerQuote: executable.raw,
          depositAddress: executable.depositAddress,
          depositMemo: executable.depositMemo,
          amountIn: executable.amountIn,
          amountOut: executable.amountOut,
          minAmountOut: executable.minAmountOut,
          quoteDeadline: executable.deadline,
          statusUpdatedAt: new Date(),
        },
      },
      { new: true },
    );
    if (!prepared) throw failure('Transfer state changed while preparing the executable quote.', 'SWAP_STATE_CONFLICT');
    await SwapQuote.updateOne(
      { _id: preview._id, userId: input.userId, sessionId: input.sessionId, status: 'preview' },
      { $set: { status: 'prepared' } },
    );
    await Session.updateOne(
      { _id: input.sessionId, userId: input.userId },
      {
        $set: {
          'transactionContext.preparationId': prepared._id.toString(),
          'transactionContext.preparationExpiry': prepared.quoteDeadline,
          'transactionContext.transactionStatus': prepared.status,
          'transactionContext.outstandingUserAction': 'review_prepared_transfer',
          'sessionSummary.pendingTransactionId': prepared._id.toString(),
        },
      },
    );
    return {
      status: prepared.status,
      transfer: serializeTransfer(prepared),
      requiresExplicitConfirmation: true,
      message: 'A fresh executable quote is prepared. Review the exact transfer terms; no funds have moved.',
    };
  } catch (error) {
    const failureInfo = error as { code?: string; message?: string };
    const status = failureInfo.code === 'NEAR_INTENTS_OUTCOME_UNKNOWN' ? 'preparation_unknown' : 'failed';
    await SwapTransfer.updateOne(
      { _id: transfer._id, status: 'preparing' },
      {
        $set: {
          status,
          errorCode: failureInfo.code ?? 'SWAP_PREPARATION_FAILED',
          errorMessage: failureInfo.message ?? 'Executable quote preparation failed.',
          statusUpdatedAt: new Date(),
        },
      },
    );
    throw error;
  }
}

export async function requestSwapWalletAuthorization(input: {
  userId: string;
  sessionId: string;
  transferId: string;
  confirm: boolean;
  walletLookup?: Parameters<typeof assertServerSignerConfigured>[3];
  signerDependencies?: Partial<PrivySignerDependencies>;
}): Promise<Record<string, unknown>> {
  if (!input.confirm) return { status: 'confirmation_required', message: 'Explicit confirmation is required before requesting wallet authorization.' };
  const transfer = await SwapTransfer.findOne({
    _id: input.transferId,
    userId: input.userId,
    sessionId: input.sessionId,
  });
  if (!transfer) throw failure('Prepared transfer not found in this authenticated session.', 'SWAP_TRANSFER_NOT_FOUND', 404);
  if (transfer.status !== 'pending_authorization') {
    if (transfer.status === 'expired') {
      const preview = await SwapQuote.findOne({ _id: transfer.previewId, userId: input.userId, sessionId: input.sessionId });
      return preview ? createFreshPreview(input.userId, input.sessionId, preview) : { status: transfer.status };
    }
    return { status: transfer.status, transfer: serializeTransfer(transfer) };
  }
  if (!transfer.quoteDeadline || transfer.quoteDeadline.getTime() <= Date.now()) {
    transfer.status = 'expired';
    transfer.errorCode = 'SWAP_QUOTE_EXPIRED';
    transfer.errorMessage = 'Executable quote expired before wallet authorization.';
    transfer.statusUpdatedAt = new Date();
    await transfer.save();
    const preview = await SwapQuote.findOne({ _id: transfer.previewId, userId: input.userId, sessionId: input.sessionId });
    return preview ? createFreshPreview(input.userId, input.sessionId, preview) : { status: 'expired' };
  }
  if (!config.PAYMENTS_LIVE_ENABLED || config.SIMULATE_PAYMENTS) {
    throw failure('Live transfers are disabled.', 'PAYMENTS_DISABLED', 503);
  }

  const user = await User.findById(input.userId).lean();
  if (
    !user?.walletId ||
    !user.walletAddress ||
    !user.privyUserId ||
    user.walletId !== transfer.walletId ||
    user.walletAddress.toLowerCase() !== transfer.walletAddress.toLowerCase()
  ) {
    throw failure('The authenticated user wallet no longer matches the prepared transfer.', 'WALLET_NOT_FOUND', 403);
  }
  const sourceToken = (await getTokenCatalogue()).find((token) => token.assetId === transfer.sourceAssetId);
  if (
    !sourceToken ||
    sourceToken.blockchain !== transfer.sourceBlockchain ||
    sourceToken.contractAddress?.toLowerCase() !== transfer.sourceTokenAddress.toLowerCase() ||
    sourceChainId(sourceToken.blockchain) !== transfer.sourceChainId ||
    !hasEvmChainRpc(transfer.sourceChainId)
  ) {
    throw failure('The prepared source asset or chain RPC no longer matches the live NEAR Intents registry.', 'TOKEN_NOT_SUPPORTED', 409);
  }
  if (
    transfer.signerId !== config.PRIVY_KEY_QUORUM_ID ||
    transfer.signerPolicyId !== config.PRIVY_TRANSFER_POLICY_ID
  ) {
    throw failure('The prepared transfer was created under a different signer or policy configuration. Prepare a new transfer.', 'SIGNER_POLICY_REJECTED', 403);
  }
  assertAllowedBasePaymentTransaction(transfer.sourceChainId, transfer.sourceTokenAddress, transfer.amountIn);
  const signerVerification = await assertServerSignerConfigured(
    transfer.walletId,
    transfer.walletAddress,
    user.privyUserId,
    input.walletLookup ?? input.signerDependencies?.walletLookup,
    input.signerDependencies,
  );
  await User.updateOne(
    { _id: user._id, privyUserId: user.privyUserId },
    {
      $set: {
        'paymentSignerAuthorization.status': 'authorized',
        'paymentSignerAuthorization.walletId': signerVerification.walletId,
        'paymentSignerAuthorization.signerId': signerVerification.signerId,
        'paymentSignerAuthorization.policyId': signerVerification.policyId,
        'paymentSignerAuthorization.verifiedAt': signerVerification.verifiedAt,
      },
    },
  );
  await assertSufficientBalance(
    {
      originTokenAddress: transfer.sourceTokenAddress,
      depositAddress: transfer.depositAddress!,
      amountIn: transfer.amountIn,
      originChainId: transfer.sourceChainId,
    },
    transfer.walletAddress,
    sourceToken,
  );
  const issued = await SwapTransfer.findOneAndUpdate(
    { _id: transfer._id, status: 'pending_authorization', quoteDeadline: { $gt: new Date() } },
    { $set: { authorizationIssuedAt: new Date() } },
    { new: true },
  );
  if (!issued) throw failure('The executable quote expired or changed before authorization.', 'SWAP_STATE_CONFLICT');
  await Session.updateOne(
    { _id: input.sessionId, userId: input.userId },
    {
      $set: {
        'transactionContext.outstandingUserAction': 'authorize_wallet_transaction',
        'transactionContext.transactionStatus': 'pending_authorization',
      },
    },
  );
  return {
    status: 'wallet_authorization_required',
    transfer: serializeTransfer(issued),
    walletAuthorization: authorizationAction(issued),
    message: 'Review and authorize this exact ERC-20 transfer in the Privy wallet. Scoutyon has not signed or sent it.',
  };
}

export async function submitSwapSourceTransaction(input: {
  userId: string;
  sessionId: string;
  transferId: string;
  transactionHash: string;
}): Promise<Record<string, unknown>> {
  if (!isHash(input.transactionHash)) throw failure('A valid EVM transaction hash is required.', 'SWAP_TRANSACTION_HASH_INVALID', 400);
  const transfer = await SwapTransfer.findOne({
    _id: input.transferId,
    userId: input.userId,
    sessionId: input.sessionId,
  });
  if (!transfer) throw failure('Prepared transfer not found in this authenticated session.', 'SWAP_TRANSFER_NOT_FOUND', 404);
  if (transfer.sourceTransactionHash && transfer.sourceTransactionHash.toLowerCase() !== input.transactionHash.toLowerCase()) {
    throw failure('A different source transaction is already associated with this transfer.', 'SWAP_DUPLICATE_DEPOSIT_BLOCKED');
  }
  const hashOwner = await SwapTransfer.findOne({ sourceTransactionHash: input.transactionHash }).select('_id').lean();
  if (hashOwner && hashOwner._id.toString() !== transfer._id.toString()) {
    throw failure('This source transaction hash is already associated with another transfer.', 'SWAP_DUPLICATE_DEPOSIT_BLOCKED');
  }
  if (transfer.sourceTransactionHash && terminalStatuses.has(transfer.status)) {
    return { status: transfer.status, transfer: serializeTransfer(transfer) };
  }
  if (!transfer.authorizationIssuedAt) {
    throw failure('The wallet authorization action must be issued before submitting a transaction hash.', 'SWAP_AUTHORIZATION_REQUIRED');
  }
  if (!transfer.sourceTransactionHash) {
    const updated = await SwapTransfer.findOneAndUpdate(
      { _id: transfer._id, status: 'pending_authorization', sourceTransactionHash: null },
      { $set: { status: 'authorized', sourceTransactionHash: input.transactionHash, statusUpdatedAt: new Date() } },
      { new: true },
    );
    if (!updated) {
      const current = await SwapTransfer.findById(transfer._id);
      if (current?.sourceTransactionHash?.toLowerCase() !== input.transactionHash.toLowerCase()) {
        throw failure('This transfer has already received a different source transaction.', 'SWAP_DUPLICATE_DEPOSIT_BLOCKED');
      }
    }
  }

  const latest = (await SwapTransfer.findById(transfer._id))!;
  try {
    await verifyConfiguredErc20Transfer({
      transactionHash: input.transactionHash as `0x${string}`,
      walletAddress: latest.walletAddress,
      tokenAddress: latest.sourceTokenAddress,
      depositAddress: latest.depositAddress!,
      amount: latest.amountIn,
      chainId: latest.sourceChainId,
    });
  } catch (error) {
    const verificationError = error as { code?: string; message?: string };
    if (verificationError.code === 'SOURCE_TX_PENDING') {
      return { status: latest.status, transfer: serializeTransfer(latest), message: 'The source transaction is not confirmed yet.' };
    }
    if (verificationError.code === 'SOURCE_TRANSACTION_INVALID' || verificationError.code === 'SOURCE_TRANSACTION_REVERTED') {
      await SwapTransfer.updateOne(
        { _id: latest._id, status: 'authorized' },
        { $set: { status: 'failed', errorCode: verificationError.code, errorMessage: verificationError.message, statusUpdatedAt: new Date() } },
      );
    }
    throw error;
  }

  const deposited = await SwapTransfer.findOneAndUpdate(
    { _id: latest._id, status: { $in: ['authorized', 'deposit_submitted', 'processing'] } },
    { $set: { status: 'deposit_submitted', statusUpdatedAt: new Date() } },
    { new: true },
  );
  if (!deposited) throw failure('Transfer state changed while verifying the source transaction.', 'SWAP_STATE_CONFLICT');
  await Session.updateOne(
    { _id: input.sessionId, userId: input.userId },
    {
      $set: {
        'transactionContext.transactionStatus': 'deposit_submitted',
        'transactionContext.outstandingUserAction': null,
      },
    },
  );

  if (!deposited.depositNotifiedAt) {
    try {
      await submitDepositTransaction(deposited.depositAddress!, input.transactionHash);
      await SwapTransfer.updateOne(
        { _id: deposited._id, depositNotifiedAt: null },
        { $set: { depositNotifiedAt: new Date() } },
      );
    } catch (error) {
      const notifyError = error as { code?: string };
      await SwapTransfer.updateOne(
        { _id: deposited._id },
        { $set: { errorCode: notifyError.code ?? 'DEPOSIT_NOTIFICATION_FAILED', errorMessage: 'The source transfer is verified; deposit notification failed and status polling will continue.' } },
      );
    }
  }
  return syncSwapTransferStatus(input.userId, input.sessionId, input.transferId);
}

export async function syncSwapTransferStatus(
  userId: string,
  sessionId: string,
  transferId: string,
): Promise<Record<string, unknown>> {
  const transfer = await SwapTransfer.findOne({ _id: transferId, userId, sessionId });
  if (!transfer) throw failure('Transfer not found in this authenticated session.', 'SWAP_TRANSFER_NOT_FOUND', 404);
  if (terminalStatuses.has(transfer.status)) return { status: transfer.status, transfer: serializeTransfer(transfer) };
  if (
    transfer.status === 'pending_authorization' &&
    transfer.quoteDeadline &&
    transfer.quoteDeadline.getTime() <= Date.now()
  ) {
    transfer.status = 'expired';
    transfer.errorCode = 'SWAP_QUOTE_EXPIRED';
    transfer.errorMessage = 'Executable quote expired before wallet authorization.';
    transfer.statusUpdatedAt = new Date();
    await transfer.save();
    await Session.updateOne(
      { _id: sessionId, userId },
      {
        $set: {
          'transactionContext.transactionStatus': 'expired',
          'transactionContext.outstandingUserAction': 'review_quote',
        },
      },
    );
    return { status: transfer.status, transfer: serializeTransfer(transfer) };
  }
  if (!['deposit_submitted', 'processing'].includes(transfer.status)) {
    return { status: transfer.status, transfer: serializeTransfer(transfer) };
  }
  const provider = await getExecutionStatus(transfer.depositAddress!, transfer.depositMemo);
  const statusMap: Record<string, SwapTransferStatus> = {
    PENDING_DEPOSIT: 'deposit_submitted',
    KNOWN_DEPOSIT_TX: 'deposit_submitted',
    PROCESSING: 'processing',
    SUCCESS: 'success',
    FAILED: 'failed',
    REFUNDED: 'refunded',
    INCOMPLETE_DEPOSIT: 'incomplete_deposit',
  };
  const newStatus = statusMap[provider.status];
  if (!newStatus) throw failure('NEAR Intents returned an unsupported settlement status.', 'NEAR_INTENTS_INVALID_RESPONSE', 502);
  const raw = provider.raw;
  const updated = await SwapTransfer.findOneAndUpdate(
    { _id: transfer._id, status: { $in: ['deposit_submitted', 'processing'] } },
    {
      $set: {
        status: newStatus,
        providerStatus: provider.status,
        providerResponse: raw,
        destinationTransactionHash: provider.destinationTransactionHash,
        destinationExplorerUrl: provider.destinationExplorerUrl,
        depositedAmount: typeof raw.depositedAmount === 'string'
          ? raw.depositedAmount
          : typeof raw.amountIn === 'string' ? raw.amountIn : transfer.depositedAmount,
        receivedAmount: typeof raw.receivedAmount === 'string'
          ? raw.receivedAmount
          : typeof raw.amountOut === 'string' ? raw.amountOut : transfer.receivedAmount,
        refundAmount: typeof raw.refundedAmount === 'string' ? raw.refundedAmount : transfer.refundAmount,
        statusUpdatedAt: new Date(),
        ...(provider.status === 'FAILED' && {
          errorCode: 'NEAR_INTENTS_FAILED',
          errorMessage: typeof raw.reason === 'string' ? raw.reason : 'NEAR Intents reported that the swap failed.',
        }),
        ...(provider.status === 'INCOMPLETE_DEPOSIT' && {
          errorCode: 'INCOMPLETE_DEPOSIT',
          errorMessage: typeof raw.reason === 'string' ? raw.reason : 'NEAR Intents reported an incomplete deposit.',
        }),
      },
    },
    { new: true },
  );
  const current = updated ?? (await SwapTransfer.findById(transfer._id));
  if (!current) throw failure('Transfer record disappeared during settlement polling.', 'SWAP_TRANSFER_NOT_FOUND', 404);
  await Session.updateOne(
    { _id: sessionId, userId },
    {
      $set: {
        'transactionContext.transactionStatus': current.status,
        'transactionContext.outstandingUserAction': null,
      },
    },
  );
  return { status: current.status, transfer: serializeTransfer(current) };
}

export async function getSwapTransfer(userId: string, sessionId: string, transferId: string) {
  const transfer = await SwapTransfer.findOne({ _id: transferId, userId, sessionId });
  if (!transfer) throw failure('Transfer not found in this authenticated session.', 'SWAP_TRANSFER_NOT_FOUND', 404);
  return serializeTransfer(transfer);
}

export function decodeTransferAction(input: {
  tokenAddress: string;
  calldata: `0x${string}`;
  recipient: string;
  amount: string;
}): boolean {
  if (!isAddress(input.tokenAddress) || !isAddress(input.recipient)) return false;
  try {
    const decoded = decodeFunctionData({ abi: transferAbi, data: input.calldata });
    return decoded.functionName === 'transfer' &&
      decoded.args[0].toLowerCase() === input.recipient.toLowerCase() &&
      decoded.args[1] === BigInt(input.amount);
  } catch {
    return false;
  }
}
