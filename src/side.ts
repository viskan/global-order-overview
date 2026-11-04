import { countryName, flag, formatCount, formatRate, formatSek } from './format';
import type { CountryAmount, Order } from './types';

const maxCountries = 6;
const maxLatest = 6;

/** Orders per minute with a sparkline of the last hour. */
export class RatePanel {
  private readonly value: HTMLElement;
  private readonly line: SVGPathElement;
  private readonly area: SVGPathElement;

  constructor(container: HTMLElement) {
    this.value = container.querySelector('#rate')!;
    this.line = container.querySelector('.spark__line')!;
    this.area = container.querySelector('.spark__area')!;
  }

  update(ordersPerMinute: number, minutes: number[] | undefined): void {
    this.value.textContent = formatRate(ordersPerMinute);
    if (!minutes || minutes.length < 2) return;
    // Lightly smoothed, so single busy minutes don't make the line spiky.
    const smoothed = minutes.map((_, index) => {
      const window = minutes.slice(Math.max(0, index - 2), index + 1);
      return window.reduce((sum, value) => sum + value, 0) / window.length;
    });
    const peak = Math.max(1, ...smoothed);
    const width = 100;
    const height = 24;
    const points = smoothed.map((value, index) => [
      (index / (smoothed.length - 1)) * width,
      height - 1.5 - (value / peak) * (height - 3),
    ]);
    const line = points.map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
    this.line.setAttribute('d', line);
    this.area.setAttribute('d', `${line} L${width},${height} L0,${height} Z`);
  }
}

/** Today's top countries; rows slide to their new place, with a bar for each country's count. */
export class CountriesPanel {
  private readonly rows = new Map<string, HTMLLIElement>();

  constructor(private readonly list: HTMLElement) {}

  update(countries: CountryAmount[]): void {
    const top = countries.slice(0, maxCountries);
    const leader = Math.max(1, top[0]?.orders ?? 1);
    // FLIP: remember where each row was, reorder, then animate from there to the new place.
    const before = new Map([...this.rows].map(([code, row]) => [code, row.getBoundingClientRect().top]));

    for (const [code, row] of this.rows) {
      if (!top.some((country) => country.country === code)) {
        row.remove();
        this.rows.delete(code);
      }
    }
    top.forEach((country, index) => {
      let row = this.rows.get(country.country);
      if (!row) {
        row = document.createElement('li');
        row.innerHTML = `<span class="flag">${flag(country.country)}</span><span class="name">${countryName(country.country)}</span>
          <span class="count"></span><span class="share"></span>`;
        this.rows.set(country.country, row);
      }
      row.querySelector('.count')!.textContent = formatCount(country.orders);
      (row.querySelector('.share') as HTMLElement).style.setProperty('--share', String(country.orders / leader));
      if (this.list.children[index] !== row) this.list.insertBefore(row, this.list.children[index] ?? null);
    });

    for (const [code, row] of this.rows) {
      const previousTop = before.get(code);
      if (previousTop === undefined) continue;
      const shift = previousTop - row.getBoundingClientRect().top;
      if (Math.abs(shift) < 1) continue;
      row.animate([{ transform: `translateY(${shift}px)` }, { transform: 'translateY(0)' }], { duration: 700, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
    }
  }
}

/** The latest landed orders: country, then the town in grey when known, and the value. */
export class LatestPanel {
  constructor(private readonly list: HTMLElement) {}

  clear(): void {
    this.list.innerHTML = '';
  }

  /** Orders without a value (free orders, replacements) are counted, but not listed. */
  add(order: Order): void {
    if (order.sek <= 0) return;
    const item = document.createElement('li');
    const country = countryName(order.country);
    item.innerHTML = `<span class="flag">${flag(order.country)}</span><span class="name">${country}</span>
      <span class="amount">${formatSek(order.sek)}</span>`;
    this.list.prepend(item);
    while (this.list.children.length > maxLatest) this.list.lastElementChild?.remove();
  }
}
