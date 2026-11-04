import type { Amount, Order, PeriodKey, Totals } from './types';

export const periodKeys: PeriodKey[] = ['hour', 'today', 'week', 'month'];

const zero = (): Amount => ({ orders: 0, items: 0, sek: 0 });

/**
 * Keeps the numbers on the page in sync with the server.
 *
 * The server's totals cover every order up to their `seq`. Orders are added to the counters only
 * when their arc lands, so what the page shows is:
 *   totals − orders up to seq that have not landed yet + landed orders after seq.
 * A new totals message replaces the base; a gap in the sequence makes the page take the server's
 * numbers as they are.
 */
export class TotalsModel {
  private base: Totals | null = null;
  private readonly orders = new Map<number, Order>();
  private readonly landed = new Set<number>();
  private lastSequence = 0;
  private gapped = false;

  get totals(): Totals | null {
    return this.base;
  }

  /** Replaces all state, e.g. after a (re)connect. */
  reset(totals: Totals): void {
    this.base = totals;
    this.orders.clear();
    this.landed.clear();
    this.lastSequence = totals.seq;
    this.gapped = false;
  }

  /** Registers a received order; returns false for a duplicate. */
  receive(order: Order): boolean {
    if (order.seq <= this.lastSequence) return false;
    if (this.lastSequence > 0 && order.seq > this.lastSequence + 1) this.gapped = true;
    this.lastSequence = order.seq;
    this.orders.set(order.seq, order);
    return true;
  }

  land(sequence: number): void {
    if (this.orders.has(sequence)) this.landed.add(sequence);
  }

  /** Applies new totals; returns true when the page should snap instead of easing. */
  applyTotals(totals: Totals): boolean {
    if (this.base && totals.seq < this.base.seq) return false;
    const snap = this.gapped;
    this.gapped = false;
    this.base = totals;
    for (const [sequence] of this.orders) {
      if (sequence <= totals.seq && this.landed.has(sequence)) {
        this.orders.delete(sequence);
        this.landed.delete(sequence);
      }
    }
    if (totals.seq > this.lastSequence) this.lastSequence = totals.seq;
    return snap;
  }

  displayed(key: PeriodKey): Amount {
    if (!this.base) return zero();
    const period = this.base.periods[key];
    const result = { ...period.current };
    const delayMs = this.base.replayDelaySeconds * 1000;
    for (const order of this.orders.values()) {
      if (order.at - delayMs < period.start) continue;
      const isLanded = this.landed.has(order.seq);
      const sign = order.seq <= this.base.seq ? (isLanded ? 0 : -1) : isLanded ? 1 : 0;
      if (sign === 0) continue;
      result.orders += sign;
      result.items += sign * order.items;
      result.sek += sign * order.sek;
    }
    return result;
  }
}
