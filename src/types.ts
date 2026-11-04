export type Amount = { orders: number; items: number; sek: number };

export type Period = { start: number; current: Amount; previous: Amount };

export type PeriodKey = 'hour' | 'today' | 'week' | 'month';

export type CountryAmount = Amount & { country: string };

export type Totals = {
  type: 'totals';
  serverTime: number;
  /** Identifies the server process; sequence numbers restart when it changes. */
  epoch: number;
  seq: number;
  replayDelaySeconds: number;
  periods: Record<PeriodKey, Period>;
  ordersPerMinute: number;
  topCountries: CountryAmount[];
  /** The busiest of the 30 days before today, for the "new record" milestone. */
  bestDay?: Amount;
  /** Orders in each of the last 60 full minutes, oldest first. */
  minuteOrders?: number[];
};

export type Order = {
  seq: number;
  lat: number;
  lng: number;
  country: string;
  /** Town or city, when the order was located there. */
  place?: string;
  items: number;
  sek: number;
  /** Replay time in server milliseconds: purchase time plus the replay delay. */
  at: number;
};

export type OrdersMessage = { type: 'orders'; serverTime: number; orders: Order[] };

/** Orders in one half-degree heat map cell; lat/lng is the average position of its orders. */
export type HeatCell = { lat: number; lng: number; orders: number };

/** One card's graph: SEK per step for the current period so far and the whole comparison period. */
export type Curve = { start: number; steps: number; current: number[]; previous: number[] };

export type CurvesMessage = { type: 'curves'; curves: Record<PeriodKey, Curve> };

export type SnapshotMessage = { type: 'snapshot'; totals: Totals; recent: Order[]; heat: HeatCell[]; curves?: CurvesMessage };

export type ServerMessage = OrdersMessage | SnapshotMessage | Totals | CurvesMessage;

export type FramesResponse = { orders: Order[]; totals: Totals | null; curves?: CurvesMessage };
