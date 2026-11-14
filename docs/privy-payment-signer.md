# Privy payment signer setup

The backend uses `@privy-io/node` 0.37.0. This repository does not contain a frontend application and does not install `@privy-io/react-auth`; the owner-consented signer button must be added to Scoutyon's frontend.

## One-time Privy Dashboard setup

1. Generate one P-256 key pair for the deployment. Do not generate keys during login or application startup:

   ```sh
   openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:prime256v1 -out scoutyon-auth.pem
   openssl pkey -in scoutyon-auth.pem -pubout -outform DER | openssl base64 -A
   openssl pkcs8 -topk8 -nocrypt -in scoutyon-auth.pem -outform DER | openssl base64 -A
   ```

2. In Privy Dashboard → **Authorization keys**, register the public key in a **1-of-1 key quorum**. Record its ID. The backend verifies that the configured private key corresponds to a public key in this quorum.
3. Configure the backend token allowlist and amount ceilings as a JSON object of verified Base token contract addresses to maximum per-transaction atomic amounts. For example, `"0x833589fcd6edb6e08f4c7c32d4f71b54bda02913":"5000000"` limits that token to 5 USDC when it has six decimals.
4. Run `npm run privy:create-payment-policy` after configuring the key quorum and token ceilings. The command creates a policy owned by that quorum with one exact allow rule per token. Rules require Base chain ID 8453, the allowlisted token contract, zero native value, the ERC-20 `transfer(address,uint256)` function, and the configured per-token amount ceiling. It prints a policy ID; set that as `PRIVY_TRANSFER_POLICY_ID`.
5. Keep `scoutyon-auth.pem` and the base64 private key only in a backend secret manager. Never put the private key, app secret, or signing credentials in frontend configuration. The backend validates the configured key as P-256 PKCS#8 and verifies it against the registered Privy quorum at startup when live payments are enabled.

The dynamic NEAR Intents deposit recipient is intentionally not an allowlisted policy value. The backend checks the recipient, source token, amount, authenticated owner, and quote expiry against the persisted executable transfer before issuing authorization. The policy restricts the contract and operation; it does not grant arbitrary calls or native transfers.

## Backend environment

Required for live payment signing:

- `PRIVY_APP_ID` and `PRIVY_APP_SECRET` for the same Privy app that authenticates users.
- `PRIVY_AUTHORIZATION_PRIVATE_KEY`: base64 PKCS#8 P-256 private key matching the registered dashboard public key.
- `PRIVY_KEY_QUORUM_ID`: registered 1-of-1 quorum ID.
- `PRIVY_TRANSFER_POLICY_ID`: policy ID generated/verified above and owned by that quorum.
- `PRIVY_BASE_TOKEN_LIMITS`: JSON contract-to-atomic-limit map matching verified token contracts.
- `PAYMENT_SOURCE_CHAIN_ID=8453` for live payments.

The backend checks quorum/key and policy configuration on startup and again before each prepare/authorization. If a configuration is missing, mismatched, or too permissive, it refuses the payment.

## Frontend consent flow

Use the authenticated endpoints:

- `GET /api/auth/payment-signer` returns the verified wallet address, public signer/policy IDs, permissions to explain, and current authorization status.
- After the user explicitly consents and `useSigners().addSigners()` succeeds, call `POST /api/auth/payment-signer/verify`. The backend re-reads the wallet from Privy and persists status only if the expected signer and policy are present. The POST body is not accepted as proof.

The official React SDK flow is `useSigners().addSigners({ address, signers: [{ signerId, policyIds: [policyId] }] })`. Before invoking it, the frontend must check the authenticated state and select the authenticated user's actual embedded wallet matching the backend-verified address. Display the exact Base/token/amount limitations and dynamic-recipient backend checks before asking for consent. Do not invoke this during login.

The actual wallet UI is not included in this backend repository, and no installed React SDK version is available here to type-check a component. The frontend must implement the consent screen/action and call the verification endpoint before showing success.
