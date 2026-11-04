import { config } from './config';
import type { CurvesMessage, FramesResponse, Order, ServerMessage, SnapshotMessage, Totals } from './types';

export type FeedHandlers = {
  snapshot: (snapshot: SnapshotMessage) => void;
  totals: (totals: Totals) => void;
  /** playAt is local time (Date.now() based) at which the order's arc should start. */
  order: (order: Order, playAt: number) => void;
  status: (status: 'live' | 'polling' | 'connecting') => void;
  /** The cards' graphs: with the snapshot and then once a minute. */
  curves: (curves: CurvesMessage) => void;
};

/**
 * Connects to the backend over a WebSocket and falls back to polling the Cloudflare-cacheable
 * /api/frames endpoint when the WebSocket keeps failing.
 */
export class Feed {
  private socket: WebSocket | null = null;
  private failures = 0;
  private pollTimer: number | undefined;
  private lastSequence = 0;
  private clockOffset = 0;
  private epoch = 0;

  constructor(private readonly handlers: FeedHandlers) {}

  start(): void {
    if (config.forcePolling) this.startPolling();
    else this.connect();
  }

  private connect(): void {
    this.handlers.status(this.pollTimer ? 'polling' : 'connecting');
    const url = `${config.apiUrl.replace(/^http/, 'ws')}/api/ws`;
    const socket = new WebSocket(url);
    this.socket = socket;
    let opened = false;

    socket.onopen = () => {
      opened = true;
      this.failures = 0;
      this.stopPolling();
      this.handlers.status('live');
    };
    socket.onmessage = (event) => this.handle(JSON.parse(event.data as string) as ServerMessage);
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (!opened) this.failures++;
      if (this.failures >= 3 && !this.pollTimer) this.startPolling();
      if (!this.pollTimer) this.handlers.status('connecting');
      const delay = this.pollTimer ? 30_000 : Math.min(10_000, 1000 * 2 ** this.failures);
      window.setTimeout(() => this.connect(), delay);
    };
  }

  private syncClock(serverTime: number): void {
    const offset = serverTime - Date.now();
    // Take the smallest offset seen recently: messages are only ever delayed, never early.
    this.clockOffset = this.clockOffset === 0 ? offset : Math.min(offset, this.clockOffset * 0.98 + offset * 0.02);
  }

  private handle(message: ServerMessage): void {
    switch (message.type) {
      case 'snapshot':
        this.syncClock(message.totals.serverTime);
        this.epoch = message.totals.epoch;
        this.lastSequence = message.totals.seq;
        this.handlers.snapshot(message);
        if (message.curves) this.handlers.curves(message.curves);
        break;
      case 'curves':
        this.handlers.curves(message);
        break;
      case 'totals':
        this.syncClock(message.serverTime);
        if (this.epoch !== 0 && message.epoch !== this.epoch) {
          // The server restarted and its sequence numbers started over: resync from a snapshot.
          // Over a WebSocket the reconnect already delivers one; when polling, fetch it next.
          this.lastSequence = 0;
          if (!this.pollTimer) this.socket?.close();
          break;
        }
        this.handlers.totals(message);
        break;
      case 'orders':
        this.syncClock(message.serverTime);
        for (const order of message.orders) this.emit(order);
        break;
    }
  }

  private emit(order: Order): void {
    if (order.seq <= this.lastSequence) return;
    this.lastSequence = order.seq;
    // Polled frames only carry orders the latest totals (sent every 10 s) cover, so they arrive up
    // to ~13 s late; a longer buffer keeps them spread out instead of bursting.
    const buffer = this.pollTimer ? config.pollingBufferMs : config.playbackBufferMs;
    const playAt = order.at - this.clockOffset + buffer;
    this.handlers.order(order, playAt);
  }

  private startPolling(): void {
    // "Live" only once a poll has actually returned data; failing polls show "Connecting…".
    let failedPolls = 0;
    const poll = async () => {
      try {
        if (this.lastSequence === 0) {
          const response = await fetch(`${config.apiUrl}/api/snapshot`);
          if (!response.ok) throw new Error(`snapshot: ${response.status}`);
          this.handle((await response.json()) as SnapshotMessage);
        } else {
          const response = await fetch(`${config.apiUrl}/api/frames?after=${this.lastSequence}`);
          if (!response.ok) throw new Error(`frames: ${response.status}`);
          const frames = (await response.json()) as FramesResponse;
          for (const order of frames.orders) this.emit(order);
          if (frames.totals) this.handle(frames.totals);
          if (frames.curves) this.handlers.curves(frames.curves);
        }
        failedPolls = 0;
        if (this.pollTimer) this.handlers.status('polling');
      } catch {
        // Keep polling; the next attempt may succeed.
        if (++failedPolls >= 2 && this.pollTimer) this.handlers.status('connecting');
      }
    };
    void poll();
    this.pollTimer = window.setInterval(poll, 3000);
  }

  private stopPolling(): void {
    if (this.pollTimer) window.clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }
}
