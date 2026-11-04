import '@fontsource-variable/inter';
import '@fontsource-variable/space-grotesk';
import 'flag-icons/css/flag-icons.min.css';
import './styles.css';
import { config } from './config';
import { Counters } from './counters';
import { Feed, type FeedHandlers } from './feed';
import { OrderGlobe } from './globe';
import { Milestones } from './milestones';
import { TotalsModel, periodKeys } from './model';
import { CountriesPanel, LatestPanel, RatePanel } from './side';
import type { Totals } from './types';

document.body.classList.toggle('embedded', config.embedded);
document.body.classList.toggle('no-counters', !config.showCounters);
document.body.classList.toggle('no-side', !config.showSide);
document.body.classList.toggle('transparent', config.transparent);

const globe = new OrderGlobe(document.getElementById('globe')!);
if (import.meta.env.DEV) Object.assign(window, { orderGlobe: globe });
const counters = new Counters(document.getElementById('stats')!);
const model = new TotalsModel();
const rate = new RatePanel(document.querySelector('.rate')!);
const countries = new CountriesPanel(document.getElementById('countries')!);
const latest = new LatestPanel(document.getElementById('latest')!);
const milestones = new Milestones(document.getElementById('milestone')!, () => {
  globe.celebrate();
  counters.celebrate('today');
});
const live = document.getElementById('live')!;
const liveText = document.getElementById('live-text')!;

let pendingSnap = false;
let todayStart = 0;
let dirty = false;
/** The first numbers roll up from zero; later snapshots (reconnects) snap. */
let firstSnapshot = true;
/** The next milestone check only takes the numbers as the new starting point. */
let silentMilestones = true;

/** Counters change at most every two seconds, so the numbers stay readable. */
const render = (mode: 'ease' | 'snap' | 'intro'): void => {
  const totals = model.totals;
  if (!totals) return;
  for (const key of periodKeys) {
    const period = totals.periods[key];
    counters.update(key, model.displayed(key), period.previous, period.start, mode);
  }
  milestones.update(model.displayed('today'), totals.periods.today.start, totals.bestDay, silentMilestones);
  silentMilestones = false;
};

window.setInterval(() => {
  if (!dirty && !pendingSnap) return;
  // A gap in the feed makes the numbers jump to the server's: not a moment to celebrate.
  if (pendingSnap) silentMilestones = true;
  render(pendingSnap ? 'snap' : 'ease');
  dirty = false;
  pendingSnap = false;
}, 2000);

const renderSide = (totals: Totals): void => {
  rate.update(totals.ordersPerMinute, totals.minuteOrders);
  countries.update(totals.topCountries);
};

const handlers: FeedHandlers = {
  snapshot: (snapshot) => {
    snapshot.recent ??= [];
    snapshot.totals.topCountries ??= [];
    model.reset(snapshot.totals);
    globe.setHeat(snapshot.heat ?? []);
    todayStart = snapshot.totals.periods.today.start;
    latest.clear();
    snapshot.recent.slice(-12).forEach((order) => latest.add(order));
    renderSide(snapshot.totals);
    silentMilestones = true;
    render(firstSnapshot ? 'intro' : 'snap');
    firstSnapshot = false;
  },
  totals: (totals) => {
    totals.topCountries ??= [];
    if (todayStart !== 0 && totals.periods.today.start !== todayStart) globe.clearHeat();
    todayStart = totals.periods.today.start;
    if (model.applyTotals(totals)) pendingSnap = true;
    dirty = true;
    renderSide(totals);
  },
  order: (order, playAt) => {
    if (!model.receive(order)) return;
    const play = () =>
      globe.launch(order, () => {
        model.land(order.seq);
        latest.add(order);
        dirty = true;
      });
    const wait = playAt - Date.now();
    if (wait > 0) window.setTimeout(play, wait);
    else play();
  },
  curves: (message) => counters.setCurves(message.curves),
  status: (status) => {
    live.dataset.status = status;
    // Polling is as live as the WebSocket for viewers; data-status keeps which one for debugging.
    liveText.textContent = status === 'connecting' ? 'Connecting…' : 'Live';
  },
};

if (import.meta.env.DEV && config.mock) {
  const scenario = config.mock;
  void import('./mock').then(({ MockFeed }) => new MockFeed(handlers, scenario).start());
} else {
  new Feed(handlers).start();
}
