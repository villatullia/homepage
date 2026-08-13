import { describe, expect, it } from 'vitest';
import { allowedTransitions, assertTransition, blocksDates, InvalidTransitionError } from '../src/domain/status.js';

describe('booking status rules', () => {
  it('allows only explicit forward transitions', () => {
    expect(allowedTransitions('AGREEMENT_DRAFT')).toContain('AWAITING_OWNER_SIGNATURE');
    expect(() => assertTransition('AGREEMENT_DRAFT', 'CONFIRMED')).toThrow(InvalidTransitionError);
    expect(() => assertTransition('CONFIRMED', 'AWAITING_PAYMENT')).toThrow(InvalidTransitionError);
  });

  it('blocks dates only for live holds and confirmed bookings', () => {
    expect(blocksDates('AWAITING_GUEST_SIGNATURE')).toBe(true);
    expect(blocksDates('CONFIRMED')).toBe(true);
    expect(blocksDates('AGREEMENT_DRAFT')).toBe(false);
    expect(blocksDates('CANCELLED')).toBe(false);
  });
});
