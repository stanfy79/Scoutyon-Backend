import { PrivyClient } from '@privy-io/node';
import { config } from '../config.js';

let privyClientInstance: PrivyClient | null = null;

/**
 * Returns a singleton instance of PrivyClient.
 */
export function getPrivyClient(): PrivyClient {
  if (!privyClientInstance) {
    if (!config.PRIVY_APP_ID || !config.PRIVY_APP_SECRET) {
      throw new Error('Privy credentials are missing. Set PRIVY_APP_ID and PRIVY_APP_SECRET in .env.');
    }

    privyClientInstance = new PrivyClient({
      appId: config.PRIVY_APP_ID,
      appSecret: config.PRIVY_APP_SECRET,
      ...(config.PRIVY_JWT_VERIFICATION_KEY && {
        jwtVerificationKey: config.PRIVY_JWT_VERIFICATION_KEY,
      }),
    });
  }

  return privyClientInstance;
}

export interface VerifiedClaims {
  appId: string;
  issuer: string;
  issuedAt: number;
  expiration: number;
  sessionId: string;
  userId: string;
}

/**
 * Verifies an access token via Privy SDK.
 */
export async function verifyAccessToken(token: string): Promise<VerifiedClaims> {
  const client = getPrivyClient();
  try {
    const claims = await client.utils().auth().verifyAccessToken(token);
    return {
      appId: claims.app_id,
      issuer: claims.issuer,
      issuedAt: claims.issued_at,
      expiration: claims.expiration,
      sessionId: claims.session_id,
      userId: claims.user_id,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid or expired access token';
    throw new Error(`Privy access token verification failed: ${message}`);
  }
}

/**
 * Retrieves the authoritative Privy user profile by a verified access-token user ID.
 */
export async function getPrivyUserById(userId: string) {
  const client = getPrivyClient();
  try {
    const user = await client.users().get(userId);
    return user;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to retrieve Privy user';
    throw new Error(`Privy user lookup failed: ${message}`);
  }
}
