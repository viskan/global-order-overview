import { formatCount, formatSek } from './format';
import type { Amount } from './types';

/** Celebrated steps for today: every 10 000 orders and every 10 000 000 SEK. */
const orderStep = 10_000;
const sekStep = 10_000_000;
/** How long a banner stays, and the pause before the next one. */
const showMs = 6000;
const gapMs = 900;

export type Milestone = { kicker: string; value: string; text: string };

/**
 * Watches today's numbers and celebrates round numbers and a new best day. It only reacts to
 * growth it saw happen: the first numbers after loading or reconnecting, a resync that jumped
 * ahead and the reset at midnight are all taken as the new starting point, silently.
 */
export class Milestones {
  private dayStart = 0;
  private last: Amount | null = null;
  private recordDone = false;
  private readonly queue: Milestone[] = [];
  private showing = false;

  constructor(
    private readonly banner: HTMLElement,
    private readonly onCelebrate: () => void,
  ) {}

  /** silent: take these numbers as the starting point without celebrating (load, reconnect, gap). */
  update(today: Amount, dayStart: number, bestDay: Amount | undefined, silent: boolean): void {
    const best = bestDay?.orders ?? 0;
    if (silent || !this.last || dayStart !== this.dayStart) {
      this.dayStart = dayStart;
      this.last = { ...today };
      // A record already beaten before we started watching is not celebrated later.
      this.recordDone = best > 0 && today.orders > best;
      return;
    }
    const previous = this.last;
    this.last = { ...today };
    if (today.orders < previous.orders) return;

    // Only the highest step crossed is shown, so a burst never queues a row of banners.
    const orderMark = Math.floor(today.orders / orderStep);
    if (orderMark > Math.floor(previous.orders / orderStep) && orderMark > 0) {
      this.enqueue({ kicker: 'Milestone', value: formatCount(orderMark * orderStep), text: 'orders today' });
    }
    const sekMark = Math.floor(today.sek / sekStep);
    if (sekMark > Math.floor(previous.sek / sekStep) && sekMark > 0) {
      this.enqueue({ kicker: 'Milestone', value: formatSek(sekMark * sekStep), text: 'sold today' });
    }
    if (!this.recordDone && best > 0 && today.orders > best) {
      this.recordDone = true;
      this.enqueue({ kicker: 'New record', value: formatCount(today.orders), text: 'orders · best day in 30 days' });
    }
  }

  private enqueue(milestone: Milestone): void {
    this.queue.push(milestone);
    if (!this.showing) this.next();
  }

  private next(): void {
    const milestone = this.queue.shift();
    if (!milestone) {
      this.showing = false;
      return;
    }
    this.showing = true;
    this.banner.innerHTML = `<div class="milestone__kicker">${milestone.kicker}</div>
      <div class="milestone__value">${milestone.value}</div>
      <div class="milestone__text">${milestone.text}</div>`;
    this.banner.classList.remove('milestone--show');
    void this.banner.offsetWidth;
    this.banner.classList.add('milestone--show');
    this.onCelebrate();
    window.setTimeout(() => {
      this.banner.classList.remove('milestone--show');
      window.setTimeout(() => this.next(), gapMs);
    }, showMs);
  }
}
