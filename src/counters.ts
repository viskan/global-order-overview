import { formatChange, formatCount, formatSek } from './format';
import type { Amount, Curve, PeriodKey } from './types';

const titles: Record<PeriodKey, { title: string; comparison: string }> = {
  hour: { title: 'This hour', comparison: 'vs same time last hour' },
  today: { title: 'Today', comparison: 'vs same time yesterday' },
  week: { title: 'Last 7 days', comparison: 'vs same time last week' },
  month: { title: 'Last 30 days', comparison: 'vs previous 30 days' },
};

const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3;

/** Steps averaged in each card's graph: minutes are noisy, quarters a little, 6 h and days not. */
const smoothingSteps: Record<PeriodKey, number> = { hour: 5, today: 3, week: 2, month: 1 };

/** A number that eases to its target, then holds still so it stays readable. */
class AnimatedNumber {
  private from = 0;
  private to = 0;
  private startedAt = 0;
  private duration = 900;

  constructor(
    private readonly element: HTMLElement,
    private readonly format: (value: number) => string,
  ) {
    this.element.textContent = this.format(0);
  }

  set(value: number, mode: 'ease' | 'snap' | 'reset' | 'intro'): void {
    if (Math.round(value) === Math.round(this.to) && mode === 'ease') return;
    this.from = mode === 'snap' ? value : this.current();
    this.to = value;
    this.duration = mode === 'intro' ? 2600 : mode === 'reset' ? 1400 : 900;
    this.startedAt = performance.now();
    if (mode === 'snap') this.element.textContent = this.format(value);
  }

  private current(): number {
    const progress = Math.min(1, (performance.now() - this.startedAt) / this.duration);
    return this.from + (this.to - this.from) * easeOutCubic(progress);
  }

  tick(now: number): void {
    const progress = Math.min(1, (now - this.startedAt) / this.duration);
    if (progress >= 1 && this.element.dataset.done === 'true') return;
    this.element.textContent = this.format(this.from + (this.to - this.from) * easeOutCubic(progress));
    this.element.dataset.done = progress >= 1 ? 'true' : 'false';
  }
}

class PeriodCard {
  readonly element: HTMLElement;
  private readonly orders: AnimatedNumber;
  private readonly sek: AnimatedNumber;
  private readonly change: HTMLElement;
  private readonly previous: HTMLElement;
  private start = 0;

  constructor(private readonly key: PeriodKey) {
    this.element = document.createElement('article');
    this.element.className = `card card--${key}`;
    this.element.innerHTML = `
      <div class="card__title">${titles[key].title}</div>
      <div class="card__orders"><span class="value"></span><span class="unit">orders</span></div>
      <div class="card__sek"></div>
      <div class="card__compare"><span class="change"></span><span class="previous"></span></div>
      <svg class="card__chart" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
        <path class="chart__previous" /><path class="chart__area" /><path class="chart__current" />
      </svg>`;
    this.orders = new AnimatedNumber(this.element.querySelector('.card__orders .value')!, formatCount);
    this.sek = new AnimatedNumber(this.element.querySelector('.card__sek')!, formatSek);
    this.change = this.element.querySelector('.change')!;
    this.previous = this.element.querySelector('.previous')!;
    this.comparisonLabel = titles[key].comparison;
  }

  private readonly comparisonLabel: string;

  update(current: Amount, previous: Amount, start: number, requested: 'ease' | 'snap' | 'intro'): void {
    const isReset = this.start !== 0 && start !== this.start;
    this.start = start;
    const mode = requested !== 'ease' ? requested : isReset ? 'reset' : 'ease';
    if (isReset) {
      this.element.classList.remove('card--reset');
      void this.element.offsetWidth;
      this.element.classList.add('card--reset');
    }
    this.orders.set(current.orders, mode);
    this.sek.set(current.sek, mode);

    const change = formatChange(current.sek, previous.sek);
    this.change.textContent = change.text;
    this.change.dataset.direction = change.direction;
    this.previous.textContent = `${this.comparisonLabel} · ${formatSek(previous.sek)}`;
  }

  tick(now: number): void {
    this.orders.tick(now);
    this.sek.tick(now);
  }

  /**
   * Draws how busy each step was: the period so far (solid) against the whole comparison period
   * (dashed), lightly smoothed. The step still running is left out, as it is only partly counted.
   */
  setCurve(curve: Curve): void {
    if (!curve || curve.steps < 2) return;
    const window = smoothingSteps[this.key];
    const smooth = (values: number[]): number[] =>
      values.map((_, index) => {
        const part = values.slice(Math.max(0, index - window + 1), index + 1);
        return part.reduce((sum, value) => sum + value, 0) / part.length;
      });
    const finished = curve.current.length < curve.steps ? curve.current.slice(0, -1) : curve.current;
    const current = smooth(finished);
    const previous = smooth(curve.previous);
    const peak = Math.max(1, ...current, ...previous) * 1.1;
    // Each step is drawn at its middle; the lines start at the first step, not at zero.
    const x = (index: number): string => (((index + 0.5) / curve.steps) * 100).toFixed(2);
    const point = (value: number, index: number): string => `${x(index)},${(40 - (value / peak) * 36).toFixed(2)}`;
    const line = (values: number[]): string => (values.length > 1 ? `M${values.map(point).join(' L')}` : '');
    const chart = this.element.querySelector('.card__chart')!;
    chart.querySelector('.chart__previous')!.setAttribute('d', line(previous));
    const currentLine = line(current);
    chart.querySelector('.chart__current')!.setAttribute('d', currentLine);
    chart
      .querySelector('.chart__area')!
      .setAttribute('d', currentLine ? `${currentLine} L${x(current.length - 1)},40 L${x(0)},40 Z` : '');
  }

  celebrate(): void {
    this.element.classList.remove('card--celebrate');
    void this.element.offsetWidth;
    this.element.classList.add('card--celebrate');
  }
}

export class Counters {
  private readonly cards: Record<PeriodKey, PeriodCard>;

  constructor(container: HTMLElement) {
    this.cards = {
      hour: new PeriodCard('hour'),
      today: new PeriodCard('today'),
      week: new PeriodCard('week'),
      month: new PeriodCard('month'),
    };
    for (const card of Object.values(this.cards)) container.appendChild(card.element);
    const loop = (now: number) => {
      for (const card of Object.values(this.cards)) card.tick(now);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  update(key: PeriodKey, current: Amount, previous: Amount, start: number, mode: 'ease' | 'snap' | 'intro'): void {
    this.cards[key].update(current, previous, start, mode);
  }

  celebrate(key: PeriodKey): void {
    this.cards[key].celebrate();
  }

  setCurves(curves: Partial<Record<PeriodKey, Curve>>): void {
    for (const [key, curve] of Object.entries(curves) as [PeriodKey, Curve][]) this.cards[key]?.setCurve(curve);
  }
}
