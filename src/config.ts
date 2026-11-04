const parameters = new URLSearchParams(window.location.search);

const flag = (name: string, fallback: boolean): boolean => {
  const value = parameters.get(name);
  if (value === null) return fallback;
  return value === '' || value === '1' || value.toLowerCase() === 'true';
};

const embedded = window.location.pathname.replace(/\/+$/, '').endsWith('/embed') || flag('embed', false);

export const config = {
  apiUrl: (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/+$/, '') || 'http://localhost:8080',
  /** Viskan's main office, Druveforsvägen 8, 504 33 Borås. Every arc ends here. */
  office: { lat: 57.7153, lng: 12.9386, name: 'Viskan HQ', city: 'Borås' },
  embedded,
  showCounters: flag('counters', !embedded),
  showSide: flag('side', !embedded),
  transparent: parameters.get('background') === 'transparent',
  /** `?transport=polling` skips the WebSocket, for networks that block it. */
  forcePolling: parameters.get('transport') === 'polling',
  /** Extra local buffer on top of the server's replay delay, so frames arrive before they play. */
  playbackBufferMs: 1500,
  pollingBufferMs: 14000,
  flightMs: 2400,
  /**
   * The globe's look (`?globe=`): NASA GIBS map tiles that sharpen as the camera gets closer, in one
   * of the styles in globe.ts (`lights`, `marble`, `relief`, `minimal`), or `texture` for the bundled
   * 8K image (no external requests).
   */
  globeStyle: parameters.get('globe') ?? 'lights',
  /** Development only: drive the page with a scripted feed (`?mock=<scenario>`, see mock.ts). */
  mock: import.meta.env.DEV ? parameters.get('mock') : null,
  tiles: parameters.get('globe') !== 'texture',
  /** `auto` lowers quality when the frame rate drops; `low` and `high` fix it. */
  quality: (['low', 'high'].includes(parameters.get('quality') ?? '') ? parameters.get('quality') : 'auto') as 'auto' | 'low' | 'high',
};
