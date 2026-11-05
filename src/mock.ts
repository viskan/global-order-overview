import type { FeedHandlers } from './feed';
import type { Amount, CountryAmount, Curve, CurvesMessage, Order, PeriodKey, Totals } from './types';

/**
 * Development only (`?mock=<scenario>`): a scripted feed that drives the page through the same
 * handlers as the real one, to check edge cases without touching live data.
 *
 *   milestone  9 950 orders and 9 990 000 SEK today: both milestones in quick succession (queued)
 *   record     best day 10 020: the 10 000 milestone, then "new record" right after
 *   load       already 25 300 orders, past the record: nothing may be celebrated
 *   reconnect  after 5 s a fresh snapshot jumps to 31 500 (as after a reconnect): no banner
 *   jump       after 5 s plain totals jump from 9 000 to 31 500: only "30 000" once
 *   midnight   19 990 orders; after 4 s the day starts over at 0: no banner, cards reset
 *   zero       only 0 SEK orders: no floating totals, nothing in "Latest orders"
 *   busy       20 orders a second from Sweden: floating totals stay capped and spaced
 *   showcase   a busy peak day at roughly prod scale, ahead of the comparison periods (for the
 *              link preview image)
 */

type Scenario = {
  today: Amount;
  bestDay: number;
  ordersPerSecond: number;
  value: () => number;
  places: Place[];
  script?: (mock: MockFeed) => void;
  /** Overrides for the other periods; by default they are derived from today. */
  periods?: Partial<Record<'hour' | 'week' | 'month', Amount>>;
  /** Top countries as shares of today's orders. */
  countryShares?: [string, number][];
  /** The comparison periods as a fraction of the current ones (0.9 shows +11 %). */
  previousFactor?: number;
};

type Place = { lat: number; lng: number; country: string; place?: string };

const nordic: Place[] = [
  { lat: 59.33, lng: 18.06, country: 'SE', place: 'Stockholm' },
  { lat: 57.71, lng: 11.97, country: 'SE', place: 'Göteborg' },
  { lat: 55.6, lng: 13.0, country: 'SE', place: 'Malmö' },
  { lat: 63.83, lng: 20.26, country: 'SE', place: 'Umeå' },
  { lat: 59.91, lng: 10.75, country: 'NO', place: 'Oslo' },
  { lat: 60.39, lng: 5.32, country: 'NO', place: 'Bergen' },
  { lat: 55.68, lng: 12.57, country: 'DK', place: 'København' },
  { lat: 60.17, lng: 24.94, country: 'FI', place: 'Helsinki' },
  { lat: 52.37, lng: 4.9, country: 'NL', place: 'Amsterdam' },
  { lat: 48.14, lng: 11.58, country: 'DE', place: 'München' },
  { lat: 41.9, lng: 12.5, country: 'IT' },
  { lat: 28.12, lng: -15.43, country: 'ES', place: 'Las Palmas' },
];
const sweden = nordic.filter((place) => place.country === 'SE');

const randomValue = (): number => (Math.random() < 0.12 ? 0 : Math.round(150 + Math.random() * 1800));

const scenarios: Record<string, Scenario> = {
  milestone: { today: { orders: 9950, items: 30000, sek: 9_990_000 }, bestDay: 40_000, ordersPerSecond: 4, value: () => 900 + Math.random() * 600, places: nordic },
  record: { today: { orders: 9990, items: 30000, sek: 6_000_000 }, bestDay: 10_020, ordersPerSecond: 4, value: randomValue, places: nordic },
  load: { today: { orders: 25_300, items: 80000, sek: 15_000_000 }, bestDay: 20_000, ordersPerSecond: 2, value: randomValue, places: nordic },
  reconnect: {
    today: { orders: 9000, items: 30000, sek: 5_000_000 },
    bestDay: 40_000,
    ordersPerSecond: 2,
    value: randomValue,
    places: nordic,
    script: (mock) => window.setTimeout(() => mock.jump(31_500, true), 5000),
  },
  jump: {
    today: { orders: 9000, items: 30000, sek: 5_000_000 },
    bestDay: 40_000,
    ordersPerSecond: 2,
    value: randomValue,
    places: nordic,
    script: (mock) => window.setTimeout(() => mock.jump(31_500, false), 5000),
  },
  midnight: {
    today: { orders: 19_990, items: 60000, sek: 9_000_000 },
    bestDay: 40_000,
    ordersPerSecond: 2,
    value: randomValue,
    places: nordic,
    script: (mock) => window.setTimeout(() => mock.newDay(), 4000),
  },
  zero: { today: { orders: 5000, items: 9000, sek: 2_000_000 }, bestDay: 40_000, ordersPerSecond: 2, value: () => 0, places: nordic },
  busy: { today: { orders: 3000, items: 9000, sek: 2_000_000 }, bestDay: 40_000, ordersPerSecond: 20, value: randomValue, places: sweden },
  // Prod scale: the best day of the last 30 had ~59 000 orders and 34 M SEK, the 30 days ~900 000.
  showcase: {
    today: { orders: 52_318, items: 171_000, sek: 31_406_000 },
    bestDay: 59_460,
    ordersPerSecond: 1,
    value: () => Math.round(250 + Math.random() * 1400),
    places: nordic,
    periods: {
      hour: { orders: 3_412, items: 11_000, sek: 2_046_000 },
      week: { orders: 231_870, items: 760_000, sek: 138_240_000 },
      month: { orders: 905_143, items: 2_950_000, sek: 548_760_000 },
    },
    countryShares: [['SE', 0.65], ['NO', 0.13], ['DE', 0.085], ['FI', 0.06], ['DK', 0.045], ['NL', 0.02]],
    previousFactor: 0.89,
  },
};

const periods: PeriodKey[] = ['hour', 'today', 'week', 'month'];

export class MockFeed {
  private readonly scenario: Scenario;
  private sequence = 0;
  private dayStart: number;
  private readonly amounts: Record<PeriodKey, Amount>;
  private readonly countries = new Map<string, number>();
  private readonly minutes: number[] = Array.from({ length: 60 }, () => Math.round(15 + Math.random() * 25));
  private readonly epoch = Date.now();

  constructor(
    private readonly handlers: FeedHandlers,
    name: string,
  ) {
    this.scenario = scenarios[name] ?? scenarios.milestone;
    const today = this.scenario.today;
    this.dayStart = new Date().setHours(0, 0, 0, 0);
    const periods = this.scenario.periods ?? {};
    this.amounts = {
      hour: { ...(periods.hour ?? { orders: Math.round(today.orders / 14), items: 0, sek: today.sek / 14 }) },
      today: { ...today },
      week: { ...(periods.week ?? { orders: today.orders * 6, items: 0, sek: today.sek * 6 }) },
      month: { ...(periods.month ?? { orders: today.orders * 27, items: 0, sek: today.sek * 27 }) },
    };
    (this.scenario.countryShares ?? [['SE', 0.55], ['NO', 0.15], ['DE', 0.1], ['FI', 0.08], ['DK', 0.07], ['NL', 0.05]]).forEach(([code, share]) =>
      this.countries.set(code as string, Math.round(today.orders * (share as number))),
    );
    console.info(`[mock] scenario "${name}"`, this.scenario.today, 'best day', this.scenario.bestDay);
  }

  start(): void {
    this.handlers.status('live');
    this.handlers.snapshot({ type: 'snapshot', totals: this.totals(), recent: [], heat: [] });
    this.handlers.curves(this.curves());
    window.setInterval(() => this.handlers.curves(this.curves()), 60_000);
    window.setInterval(() => this.emitOrder(), 1000 / this.scenario.ordersPerSecond);
    window.setInterval(() => this.handlers.totals(this.totals()), 2000);
    this.scenario.script?.(this);
  }

  /** Today's orders jump to orders without any order messages: via a snapshot or plain totals. */
  jump(orders: number, asSnapshot: boolean): void {
    const added = orders - this.amounts.today.orders;
    for (const key of periods) this.amounts[key].orders += key === 'hour' ? 0 : added;
    this.countries.set('SE', (this.countries.get('SE') ?? 0) + added);
    console.info(`[mock] jump to ${orders} (${asSnapshot ? 'snapshot' : 'totals'})`);
    if (asSnapshot) this.handlers.snapshot({ type: 'snapshot', totals: this.totals(), recent: [], heat: [] });
    else this.handlers.totals(this.totals());
  }

  /** Midnight: today starts over at zero. */
  newDay(): void {
    this.dayStart = Date.now();
    this.amounts.today = { orders: 0, items: 0, sek: 0 };
    this.countries.clear();
    console.info('[mock] new day');
    this.handlers.totals(this.totals());
  }

  private emitOrder(): void {
    const place = this.scenario.places[Math.floor(Math.random() * this.scenario.places.length)];
    const sek = Math.round(this.scenario.value());
    const order: Order = {
      seq: ++this.sequence,
      lat: place.lat + (Math.random() - 0.5) * 0.6,
      lng: place.lng + (Math.random() - 0.5) * 1.2,
      country: place.country,
      items: 1 + Math.floor(Math.random() * 3),
      sek,
      at: Date.now(),
    };
    for (const key of periods) {
      this.amounts[key].orders++;
      this.amounts[key].items += order.items;
      this.amounts[key].sek += sek;
    }
    this.countries.set(order.country, (this.countries.get(order.country) ?? 0) + 1);
    this.minutes[this.minutes.length - 1]++;
    this.handlers.order(order, Date.now() + 200);
  }

  /** Day-shaped random curves: busy evenings, quiet nights; the current period runs ~8 % ahead. */
  private curves(): CurvesMessage {
    const make = (steps: number, done: number, perStep: number): Curve => {
      const wave = (index: number) => perStep * (0.55 + 0.45 * Math.sin((index / steps) * Math.PI * 2 - 1.2)) * (0.8 + Math.random() * 0.4);
      const previous = Array.from({ length: steps }, (_, index) => Math.round(wave(index)));
      const current = previous.slice(0, done).map((value) => Math.round(value * (1.08 + (Math.random() - 0.5) * 0.2)));
      return { start: Date.now(), steps, current, previous };
    };
    const now = new Date();
    return {
      type: 'curves',
      curves: {
        hour: make(60, now.getMinutes() + 1, 7000),
        today: make(96, now.getHours() * 4 + Math.floor(now.getMinutes() / 15) + 1, 90_000),
        week: make(28, 24 + Math.floor(now.getHours() / 6) + 1, 2_000_000),
        month: make(30, 30, 9_000_000),
      },
    };
  }

  private previous(current: Amount): Amount {
    const factor = this.scenario.previousFactor;
    if (factor === undefined) return { orders: current.orders * 0.9, items: 0, sek: current.sek * 1.05 };
    return { orders: Math.round(current.orders * factor), items: 0, sek: current.sek * factor };
  }

  private totals(): Totals {
    const topCountries: CountryAmount[] = [...this.countries]
      .sort((a, b) => b[1] - a[1])
      .map(([country, orders]) => ({ country, orders, items: 0, sek: 0 }));
    const day = 24 * 3600 * 1000;
    const starts: Record<PeriodKey, number> = {
      hour: new Date().setMinutes(0, 0, 0),
      today: this.dayStart,
      week: this.dayStart - 6 * day,
      month: this.dayStart - 29 * day,
    };
    return {
      type: 'totals',
      serverTime: Date.now(),
      epoch: this.epoch,
      seq: this.sequence,
      replayDelaySeconds: 0,
      periods: Object.fromEntries(
        periods.map((key) => [
          key,
          { start: starts[key], current: { ...this.amounts[key] }, previous: this.previous(this.amounts[key]) },
        ]),
      ) as Totals['periods'],
      ordersPerMinute: this.scenario.ordersPerSecond * 60,
      topCountries,
      bestDay: { orders: this.scenario.bestDay, items: 0, sek: 0 },
      minuteOrders: [...this.minutes],
    };
  }
}
