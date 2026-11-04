# Viskan Live Orders

A live 3D globe of the orders placed through Viskan's e-commerce platform. Every order flies from
where it is delivered to Viskan's office in Borås, and the counters (this hour, today, last 7 and
30 days) count it as it lands.

The page reads the public, anonymous feed of Viskan's `global-order-overview-service`: positions are
rounded and offset, and no customer or merchant data is ever sent.

## Run locally

```powershell
npm install
npm run dev        # http://127.0.0.1:5173, expects the backend on http://localhost:8080
```

Set `VITE_API_URL` (see `.env.example`) to use another backend. `npm run build` writes a static site
to `dist/`, which Cloudflare Pages serves at https://live.viskan.com. Pages builds and deploys on every
push to `main` (settings and `VITE_API_URL` in the Cloudflare dashboard), and every other branch gets a
preview URL.

Without a backend, `npm run dev` can drive the page with a scripted feed: open
`http://127.0.0.1:5173/?mock=<scenario>` with `milestone`, `record`, `load`, `reconnect`, `jump`,
`midnight`, `zero` or `busy` (see `src/mock.ts`). The mock feed is left out of production builds.

## The globe

- The camera flies in on load and then drifts slowly over Scandinavia, where most orders come from.
- An order from further than ~3,300 km gets a small camera move, at most one every 25 s: the camera
  pulls back a little and leans a few degrees towards where the order comes from, then drifts back.
- Viewers can drag and scroll to look around; the camera eases back into its drift 5 s after the
  last interaction.
- A new order lights up where it appears, shows its value for a few seconds and flies to the office
  as a comet. Today's orders glow as a heat map.
- Round numbers today (every 10 000 orders, every 10 000 000 SEK) and a new best day of the last 30
  days are celebrated with a banner.
- Earth: NASA GIBS map tiles, streamed at the detail the camera needs, in one of four styles via
  `?globe=`: `lights` (default: city lights at night), `marble`, `relief` or `minimal`.
  `?globe=texture` uses the bundled "Earth at Night" image instead (no external requests).
- Quality adapts to the machine: if the frame rate stays low, the glow is turned off.
  `?quality=low` also drops the pixel density to 1×; `?quality=high` keeps everything on.

## Embedding

`/embed` shows the globe without the page header and side column, for an `<iframe>`.

| Parameter | Default | |
|---|---|---|
| `counters` | `true` (`false` on `/embed`) | Show the period cards. |
| `side` | `true` (`false` on `/embed`) | Show orders per minute, top countries and latest orders. |
| `background=transparent` | – | No background, for placing the globe on a page. |
| `transport=polling` | – | Skip the WebSocket and poll `/api/frames` (for networks that block WebSockets). |

```html
<iframe src="https://<host>/embed?counters=true&background=transparent" style="border:0;width:100%;height:600px"></iframe>
```

## How the numbers stay right

The backend sends each order once, shortly after it happened, and its totals every 10 s together
with the sequence number of the last order they include. The page adds an order when its arc lands
and otherwise follows the server's totals, so it never drifts; a gap in the sequence (sleeping tab,
reconnect) makes it take the server's numbers directly. If the WebSocket keeps failing, the page
polls `/api/frames` instead.

## Credits

- Earth imagery: NASA Earth Observatory and NASA GIBS (Black Marble, Blue Marble), public domain.
- `public/textures/earth-topology.png` and `public/textures/night-sky.jpg`: from the examples of
  [three-globe](https://github.com/vasturiano/three-globe) (MIT).
- Globe rendering: [globe.gl](https://github.com/vasturiano/globe.gl) and
  [three.js](https://threejs.org) (MIT).
- Locations: [GeoNames](https://www.geonames.org) (CC BY 4.0), resolved by the backend.
- Flags: [flag-icons](https://github.com/lipis/flag-icons) (MIT).
- Fonts: Inter and Space Grotesk (SIL Open Font License), via Fontsource.

## License

The code is MIT licensed (see `LICENSE`). The Viskan name and logo (`public/viskan-logo-white.svg`,
`public/favicon.svg`) are trademarks of Viskan System AB and are not covered by the license.
