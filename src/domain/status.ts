export const bookingStatuses = [
  'AGREEMENT_DRAFT',
  'AWAITING_OWNER_SIGNATURE',
  'AWAITING_GUEST_SIGNATURE',
  'AGREEMENT_SIGNED',
  'AWAITING_PAYMENT',
  'PAYMENT_PROCESSING',
  'CONFIRMED',
  'PAYMENT_FAILED',
  'EXPIRED',
  'CANCELLED',
  'REFUNDED',
] as const;

export type BookingStatus = (typeof bookingStatuses)[number];

const transitions: Record<BookingStatus, readonly BookingStatus[]> = {
  AGREEMENT_DRAFT: ['AWAITING_OWNER_SIGNATURE', 'CANCELLED'],
  AWAITING_OWNER_SIGNATURE: ['AWAITING_GUEST_SIGNATURE', 'EXPIRED', 'CANCELLED'],
  AWAITING_GUEST_SIGNATURE: ['AGREEMENT_SIGNED', 'EXPIRED', 'CANCELLED'],
  AGREEMENT_SIGNED: ['AWAITING_PAYMENT', 'CANCELLED'],
  AWAITING_PAYMENT: ['PAYMENT_PROCESSING', 'CONFIRMED', 'PAYMENT_FAILED', 'EXPIRED', 'CANCELLED'],
  PAYMENT_PROCESSING: ['CONFIRMED', 'PAYMENT_FAILED', 'EXPIRED', 'CANCELLED'],
  CONFIRMED: ['CANCELLED', 'REFUNDED'],
  PAYMENT_FAILED: ['AWAITING_PAYMENT', 'PAYMENT_PROCESSING', 'CONFIRMED', 'EXPIRED', 'CANCELLED'],
  EXPIRED: [],
  CANCELLED: ['REFUNDED'],
  REFUNDED: [],
};

export class InvalidTransitionError extends Error {
  constructor(from: BookingStatus, to: BookingStatus) {
    super(`Invalid booking transition: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export function assertTransition(from: BookingStatus, to: BookingStatus): void {
  if (!transitions[from].includes(to)) throw new InvalidTransitionError(from, to);
}

export function allowedTransitions(status: BookingStatus): readonly BookingStatus[] {
  return transitions[status];
}

export function blocksDates(status: BookingStatus): boolean {
  return [
    'AWAITING_OWNER_SIGNATURE',
    'AWAITING_GUEST_SIGNATURE',
    'AGREEMENT_SIGNED',
    'AWAITING_PAYMENT',
    'PAYMENT_PROCESSING',
    'PAYMENT_FAILED',
    'CONFIRMED',
  ].includes(status);
}
