# General Cross-Chain Transfer Implementation

## What changed

The general transfer-preview path is now distinct from merchant-invoice payments. A saved preview can be prepared into a fresh executable 1Click quote, reviewed, and handed off as an exact ERC-20 transaction for user authorization through the existing Privy wallet. After the frontend submits the resulting transaction hash, the backend validates it against the prepared transfer and monitors 1Click settlement.

## Lifecycle

1. `get_transfer_quote` resolves assets from the live 1Click registry, requests a dry `EXACT_INPUT` quote, and saves the original request parameters, provider response, slippage and expiry in `SwapQuote`.
2. “Proceed” is routed directly to `prepare_transfer`, without re-calling Gemini or creating another preview. It checks user/session ownership, state and expiry, revalidates source/destination metadata, and requests a fresh `dry: false`, `EXACT_INPUT`, `ORIGIN_CHAIN` quote for the same atomic input amount and addresses.
3. The executable quote is persisted in `SwapTransfer`, linked to the preview, user, and session. A unique preview index/idempotency key prevents duplicate executable quote requests. Ambiguous preparation outcomes are retained as `preparation_unknown` and are not blindly retried.
4. The prepared transfer response includes exact source and destination terms and waits for review. A subsequent explicit “confirm” produces a `wallet_action` SSE event with verified token contract, destination deposit address, calldata for ERC-20 `transfer()`, amount, chain ID, and the authenticated Privy wallet ID. Preparation alone does not move funds.
5. After the frontend obtains user authorization and broadcasts through the Privy wallet, it submits the transaction hash to `POST /api/transfers/:transferId/submit`. The backend checks sender, chain, token contract, calldata, recipient, amount, successful receipt and matching ERC-20 Transfer log. A source transaction is never represented as a settled swap.
6. Only after source verification does the backend optionally notify `/v0/deposit/submit` and poll `/v0/status` (including memo when present). Provider status, deposited/received/refunded amounts, destination hash/explorer URL and terminal status are persisted. Success is returned only for 1Click `SUCCESS`.

## API handoff

- Agent chat: `POST /api/agent/chat` with the active `sessionId`; SSE `quote` reports preview/prepared details and SSE `wallet_action` carries the exact transaction action after explicit confirmation.
- Explicit authorization endpoint if needed by the client: `POST /api/transfers/:transferId/authorize` with `{ "sessionId": "...", "confirm": true }`.
- Submit the wallet-broadcast hash: `POST /api/transfers/:transferId/submit` with `{ "sessionId": "...", "transactionHash": "0x..." }`.
- Poll/recover status after restart: `GET /api/transfers/:transferId/status?sessionId=...`.
- Read persisted details: `GET /api/transfers/:transferId?sessionId=...`.

All transfer routes require the authenticated user and constrain IDs by that user and session.

## Supported scope and remaining blockers

- Wallet execution currently supports EVM ERC-20 source assets only. The source asset must be in the live token registry, its EVM chain must map to a supported chain ID, and an RPC must be available.
- The configured source chain uses `PAYMENT_SOURCE_RPC_URL`; additional source EVM chains can use `SWAP_EVM_RPC_URLS`, a JSON map from chain IDs to HTTPS RPC URLs in production.
- Native EVM deposits and non-EVM source-chain wallet signing are not implemented. Those routes may be quoted, but preparation is refused unless the source route is supported.
- This repository contains the backend only. The frontend must handle the `wallet_action` SSE event, show the reviewed terms, invoke the authenticated user's Privy wallet, and submit the returned hash to the backend route. The backend does not sign or broadcast the transaction itself.
- Live authorization remains blocked unless `PAYMENTS_LIVE_ENABLED=true`, `SIMULATE_PAYMENTS=false`, Privy signer/policy settings are valid, the user's wallet is correctly delegated, and source token/native gas balances are sufficient.
- Executable quote requests are committed provider operations. Ambiguous provider timeouts are persisted as `preparation_unknown`; manual reconciliation is required rather than automatically creating a second deposit address.
- Expired previews/preparations return fresh quote terms and require renewed user review.

## Tests and verification

Automated tests mock NEAR Intents, Privy wallet lookup and EVM JSON-RPC. They exercise dry preview request fields, executable quote validation, duplicate preparation prevention, wallet-action calldata, a verified source deposit, notification, nested settlement response parsing, and successful settlement. They send no real transactions.

- `npm.cmd run build`
- `npm.cmd test` — 44 tests passed.
- No live executable quote or transaction was created as part of this implementation.

## Changed files

- `.env.example`
- `IMPLEMENTATION_REPORT.md`
- `package.json`
- `scripts/near-intents-diagnose.ts`
- `src/agent/intents.ts`
- `src/agent/prompts.ts`
- `src/agent/runner.ts`
- `src/agent/tools.ts`
- `src/config.ts`
- `src/index.ts`
- `src/models/SwapQuote.ts`
- `src/models/SwapTransfer.ts`
- `src/routes/agent.ts`
- `src/routes/transfers.ts`
- `src/services/nearIntents.ts`
- `src/services/nearTokenRegistry.ts`
- `src/services/swapQuoteService.ts`
- `src/services/swapTransferService.ts`
- `src/services/walletBalance.ts`
- `tests/agent-intents.test.ts`
- `tests/swap-transfer.test.ts`

## Safe real small-value test

Use a dedicated user-controlled EVM wallet with only a small amount of the selected ERC-20 and enough native gas on the same chain. Configure the matching RPC, verify the live token registry metadata and Privy delegated signer/policy, and leave simulation disabled only for the test window. Create a preview, inspect and prepare it, independently verify every field in the displayed executable terms, then explicitly confirm and authorize the exact ERC-20 transfer in Privy. Never copy or replace the deposit address, contract, chain or atomic amount. Submit only the hash returned by the wallet and monitor `/api/transfers/:transferId/status` until a terminal 1Click result. Do not retry an ambiguous executable-quote request or rebroadcast a transaction.
