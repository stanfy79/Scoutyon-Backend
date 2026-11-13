import type { PaymentAttemptStatus } from '../models/PaymentAttempt.js';

const transitions: Record<PaymentAttemptStatus, PaymentAttemptStatus[]> = {
  PREPARING: ['AWAITING_USER_CONFIRMATION', 'FAILED', 'EXPIRED'],
  AWAITING_USER_CONFIRMATION: ['SUBMITTING', 'EXPIRED', 'FAILED'],
  SUBMITTING: ['SOURCE_TX_SUBMITTED', 'SUBMISSION_UNKNOWN', 'FAILED'],
  SOURCE_TX_SUBMITTED: ['SOURCE_TX_CONFIRMED', 'FAILED', 'REQUIRES_MANUAL_REVIEW'],
  SOURCE_TX_CONFIRMED: ['PROCESSING', 'INCOMPLETE_DEPOSIT', 'FAILED'],
  PROCESSING: ['SUCCESS', 'REFUNDED', 'FAILED', 'INCOMPLETE_DEPOSIT', 'REQUIRES_MANUAL_REVIEW'],
  SUCCESS: [],
  REFUNDED: [],
  FAILED: [],
  INCOMPLETE_DEPOSIT: [],
  EXPIRED: [],
  SUBMISSION_UNKNOWN: ['SOURCE_TX_SUBMITTED', 'SOURCE_TX_CONFIRMED', 'FAILED', 'REQUIRES_MANUAL_REVIEW'],
  REQUIRES_MANUAL_REVIEW: ['SOURCE_TX_CONFIRMED', 'PROCESSING', 'SUCCESS', 'REFUNDED', 'FAILED'],
};

export function canTransitionPayment(
  current: PaymentAttemptStatus | string,
  next: PaymentAttemptStatus | string,
): boolean {
  if (!(current in transitions) || !(next in transitions)) {
    return false;
  }
  return transitions[current as PaymentAttemptStatus].includes(next as PaymentAttemptStatus);
}

export function assertPaymentTransition(
  current: PaymentAttemptStatus | string,
  next: PaymentAttemptStatus | string,
): void {
  if (!canTransitionPayment(current, next)) {
    throw Object.assign(new Error(`Invalid payment state transition: ${current} -> ${next}`), {
      code: 'PAYMENT_STATE_TRANSITION_INVALID',
      statusCode: 409,
    });
  }
}
