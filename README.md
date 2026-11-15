# Scoutyon — Backend

## Frontend repository: [https://github.com/stanfy79/Scoutyon](https://github.com/stanfy79/Scoutyon)

**The intelligence and transaction infrastructure powering Scoutyon.**

Scoutyon is an AI-powered research and cross-chain transaction assistant designed to simplify how users interact with Web3.

The backend powers Scoutyon's AI capabilities, research workflows, persistent conversations, embedded wallet integration and cross-chain transaction operations.

It connects the frontend to AI services, Privy and NEAR Intents, coordinating the processes required to turn natural-language requests into actionable results.

## Overview

Interacting with Web3 often requires users to navigate multiple applications, understand blockchain networks, manage wallets and manually execute transactions.

Scoutyon aims to simplify this experience through a conversational AI assistant backed by an infrastructure layer that handles research, transaction preparation, authorization and status tracking.

The backend is responsible for coordinating these operations securely and reliably.

## Core Features

### AI Agent Integration
- Integrates Google's Gemini API.
- Processes natural-language requests.
- Supports conversational context and follow-up requests.
- Routes requests to the appropriate research or transaction workflows.

### Research and Discovery
- Supports research into crypto projects, companies, products and services.
- Enables comparisons of providers, features and pricing.
- Supports legitimacy and reputation investigations.
- Returns structured research information and relevant sources.

### NEAR Intents Integration
- Retrieves supported tokens and blockchain assets.
- Requests cross-chain transfer quotes.
- Supports transfer preparation and deposit instructions.
- Tracks transaction progress through NEAR Intents.
- Handles provider errors, unavailable liquidity and transaction status updates.

### Privy Wallet Integration
- Supports embedded wallet infrastructure.
- Handles wallet ownership and authorization checks.
- Supports delegated signer authorization.
- Coordinates transaction execution through configured wallet permissions.

### Persistent Chat Sessions
- Stores conversation history.
- Preserves session context across requests.
- Supports reopening previous conversations.
- Maintains pending transaction context so users can continue an existing workflow.

### Transaction Safety
- Requires transaction preparation and review before authorization.
- Validates transaction parameters.
- Uses explicit authorization rather than automatically executing transfers from ordinary chat messages.
- Supports configurable live-payment and simulation modes.
- Keeps sensitive credentials on the backend.

## Technology Stack

| Technology | Purpose |
|---|---|
| Node.js | Backend runtime |
| TypeScript | Application development |
| Express.js | API framework |
| MongoDB | Persistent application data |
| Mongoose | Database modeling |
| Gemini API | AI agent and research processing |
| NEAR Intents | Cross-chain routing and swaps |
| Privy | Embedded wallets and transaction authorization |
| Zod | Environment and data validation |

## Architecture

The backend acts as the coordination layer between the frontend, AI services, wallet infrastructure and blockchain transaction providers.

Typical request flow:

1. The frontend sends a user's message to the backend.
2. The backend identifies the intended operation.
3. Gemini processes the request and coordinates the appropriate workflow.
4. Research requests are handled by the relevant research services.
5. Transfer requests are processed through NEAR Intents.
6. The backend prepares and validates transaction details.
7. The user explicitly authorizes supported transactions through Privy.
8. The backend monitors the transaction and updates its status.
9. The frontend receives the result.

## NEAR Intents Transaction Flow

Scoutyon uses NEAR Intents to abstract cross-chain asset routing.

The general transfer lifecycle is:

1. **Quote:** Retrieve an available route and expected output.
2. **Review:** Present the source asset, destination asset, amount, fees and expected outcome.
3. **Prepare:** Generate executable deposit instructions.
4. **Authorize:** Obtain the required user authorization.
5. **Execute:** Submit the authorized source-chain transaction.
6. **Track:** Monitor the NEAR Intents transaction status.
7. **Settle:** Report successful completion only when the provider confirms settlement.

A successful source-chain deposit does not automatically mean the destination transfer has settled.

## API Configuration

Create a `.env` file in the backend root directory.

Example configuration:

```env
PORT=5000
MONGODB_URI=
API_SECRET_KEY=
GEMINI_API_KEY=

NEAR_NETWORK=testnet

PRIVY_APP_ID=
PRIVY_APP_SECRET=

PAYMENTS_LIVE_ENABLED=false
SIMULATE_PAYMENTS=true

PAYMENT_SOURCE_ASSET_ID=
PAYMENT_SOURCE_BLOCKCHAIN=
PAYMENT_SOURCE_CHAIN_ID=
PAYMENT_SOURCE_RPC_URL=
PAYMENT_SOURCE_TOKEN_ADDRESS=

PAYMENT_SLIPPAGE_BPS=100
PAYMENT_TOKEN_CACHE_TTL_SECONDS=60
