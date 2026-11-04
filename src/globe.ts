import Globe, { type GlobeInstance } from 'globe.gl';
import {
  Color,
  Mesh,
  MeshLambertMaterial,
  MeshPhongMaterial,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  TextureLoader,
  Vector2,
  Vector3,
  type Object3D,
  type Texture,
} from 'three';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { CopyShader } from 'three/examples/jsm/shaders/CopyShader.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { Comet, type CometStyle, getGlowTexture } from './comet';
import { config, type QualityMode } from './config';
import { formatSek } from './format';
import { HeatLayer } from './heat';
import { Summon, summonMs } from './spawn';
import type { HeatCell, Order } from './types';

type Ring = { id: number; lat: number; lng: number; maxRadius: number; speed: number; period: number; color: string };
/** HTML elements on the globe: the office marker and the floating totals of new orders. */
type TotalMarker = { kind: 'total'; id: number; lat: number; lng: number; text: string };
type Marker = { kind: 'office'; lat: number; lng: number } | TotalMarker;

/** How long an order's total floats above its origin. */
const totalLabelMs = 3200;
/** At most this many totals at once, and none closer than totalSpacingDegrees to a showing one. */
const maxTotalLabels = 5;
const totalSpacingDegrees = 1.5;
type View = { lat: number; lng: number; altitude: number };
/**
 * A small camera move for a far-away order: pull back a little and lean towards where the order
 * comes from, staying around Scandinavia.
 */
type Shot = {
  from: View;
  startedAt: number;
  endsAt: number;
  originLat: number;
  originLng: number;
  distance: number;
};

/** How long the camera stays where the viewer left it before drifting back. */
const idleBeforeReturnMs = 5_000;
const returnDurationMs = 4_000;
/** On load the camera flies in from space to the drift view. */
const introDurationMs = 3_600;
const introAltitude = 5.5;
const largeOrderSek = 2_500;
/** An order further away than this (in degrees, ~3,300 km) gets a camera move (see Shot). */
const farAwayDegrees = 30;
const shotCooldownMs = 25_000;
const shotEaseMs = 2_000;
/** How far (in degrees) the camera leans towards a far-away order's origin. */
const shotLeanDegrees = 4;
/** And pulls back at most this much (in globe radii). */
const shotZoomOut = 0.22;
/** Never render wider than a 4K screen, whatever the device pixel ratio. */
const maxRenderWidth = 3840;
const maxNearTileLevel = 7;
const gibs = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best';

/**
 * Globe styles from NASA GIBS layers (public domain). `tint` multiplies the tile colours; `ramp`
 * recolours a greyscale layer: brightness from `edges[0]` to `edges[1]` maps from `low` to `high`.
 * Brightness is in linear light (the shader sees sRGB tiles decoded), so sRGB grey 0.5 is about 0.21.
 */
type GlobeStyle = {
  url: (x: number, y: number, level: number) => string;
  maxLevel: number;
  tint?: [number, number, number];
  ramp?: { low: string; high: string; edges: [number, number] };
};

const globeStyles: Record<string, GlobeStyle> = {
  // City lights at night (VIIRS Black Marble 2016).
  lights: { url: (x, y, level) => `${gibs}/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/${level}/${y}/${x}.png`, maxLevel: 8 },
  // Blue Marble with ocean depth, darkened to a night blue.
  marble: {
    url: (x, y, level) => `${gibs}/BlueMarble_ShadedRelief_Bathymetry/default/default/GoogleMapsCompatible_Level8/${level}/${y}/${x}.jpg`,
    maxLevel: 8,
    tint: [0.42, 0.5, 0.72],
  },
  // Shaded terrain, recoloured from deep navy (sea) to steel blue (mountains).
  relief: {
    url: (x, y, level) => `${gibs}/ASTER_GDEM_Greyscale_Shaded_Relief/default/default/GoogleMapsCompatible_Level12/${level}/${y}/${x}.jpg`,
    maxLevel: 9,
    ramp: { low: '#040a1a', high: '#5a7cb0', edges: [0.1, 0.45] },
  },
  // Flat land and water: dark navy sea, slightly lighter land.
  minimal: {
    url: (x, y, level) => `${gibs}/OSM_Land_Water_Map/default/default/GoogleMapsCompatible_Level9/${level}/${y}/${x}.png`,
    maxLevel: 9,
    ramp: { low: '#1a2d56', high: '#040916', edges: [0.12, 0.17] },
  },
};

const cometStyles: Record<'normal' | 'large', CometStyle> = {
  normal: { radius: 0.15, headSize: 1.1, tailColor: '#1f8fff', headColor: '#9fe6ff' },
  large: { radius: 0.22, headSize: 1.6, tailColor: '#21d6c4', headColor: '#c9fff6' },
};

const toRadians = Math.PI / 180;

/** Great-circle distance in degrees, used to scale a comet's flight time with its length. */
const angularDistance = (lat1: number, lng1: number, lat2: number, lng2: number): number => {
  const a =
    Math.sin(((lat2 - lat1) * toRadians) / 2) ** 2 +
    Math.cos(lat1 * toRadians) * Math.cos(lat2 * toRadians) * Math.sin(((lng2 - lng1) * toRadians) / 2) ** 2;
  return (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))) / toRadians;
};

const unitVector = (lat: number, lng: number): Vector3 =>
  new Vector3(Math.cos(lat * toRadians) * Math.cos(lng * toRadians), Math.sin(lat * toRadians), Math.cos(lat * toRadians) * Math.sin(lng * toRadians));

/** The point a fraction t of the way along the great circle from one place to another. */
const greatCirclePoint = (fromLat: number, fromLng: number, toLat: number, toLng: number, t: number): { lat: number; lng: number } => {
  const from = unitVector(fromLat, fromLng);
  const to = unitVector(toLat, toLng);
  const angle = from.angleTo(to);
  const direction =
    angle < 1e-6
      ? from
      : from.clone().multiplyScalar(Math.sin((1 - t) * angle) / Math.sin(angle)).add(to.clone().multiplyScalar(Math.sin(t * angle) / Math.sin(angle)));
  return { lat: Math.asin(Math.max(-1, Math.min(1, direction.y))) / toRadians, lng: Math.atan2(direction.z, direction.x) / toRadians };
};

const easeInOutCubic = (t: number): number => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);

const lerpView = (from: View, to: View, t: number): View => {
  let lngDelta = to.lng - from.lng;
  if (lngDelta > 180) lngDelta -= 360;
  if (lngDelta < -180) lngDelta += 360;
  return {
    lat: from.lat + (to.lat - from.lat) * t,
    lng: from.lng + lngDelta * t,
    altitude: from.altitude + (to.altitude - from.altitude) * t,
  };
};

export class OrderGlobe {
  private readonly globe: GlobeInstance;
  private comets: Comet[] = [];
  private rings: Ring[] = [];
  private summons: Summon[] = [];
  private totalLabels: TotalMarker[] = [];
  /** One object for the office, so updating the totals never re-creates its marker. */
  private readonly officeDatum: Marker = { kind: 'office', lat: config.office.lat, lng: config.office.lng };
  private readonly heat: HeatLayer;
  private nextId = 1;
  /** Kept when the glow is switched off, so it can be switched on again in place. */
  private bloom: UnrealBloomPass | null = null;
  private bloomIndex = -1;
  private fullPixelRatio = 1;

  private cameraMode: 'drift' | 'viewer' | 'return' | 'shot' = 'drift';
  private interacting = false;
  private lastInteraction = 0;
  private returnFrom: View = { lat: 0, lng: 0, altitude: 1 };
  private returnStartedAt = 0;
  private returnDuration = returnDurationMs;
  private shot: Shot | null = null;
  private lastShot = -Infinity;
  private lastFrame = 0;

  /** 2 = everything, 1 = no bloom, 0 = no bloom and 1× pixel density. */
  private qualityLevel = 2;
  /** `auto` may lower the quality on a slow machine; a choice of `low` or `high` is kept. */
  private qualityMode: QualityMode = config.quality;
  /** Called whenever the quality level or mode changes, for the quality switch. */
  onQualityChange: (level: number, mode: QualityMode) => void = () => {};
  private frameTimes: number[] = [];
  /** The intro and the first tile loads are slow on any PC: frames before this don't count. */
  private readonly qualityWarmupUntil = performance.now() + 10_000;
  private qualityCheckAt = this.qualityWarmupUntil + 4000;
  private slowChecks = 0;

  private tileEngine: (Object3D & { thresholds: number[]; minLevel: number; maxLevel: number }) | null = null;
  /** The detail level kept while the camera is close, so the drift never drops to blurrier tiles. */
  private nearTileLevel = 0;

  constructor(element: HTMLElement) {
    this.globe = new Globe(element, { animateIn: false, rendererConfig: { antialias: true, alpha: config.transparent } })
      .backgroundColor(config.transparent ? 'rgba(0,0,0,0)' : '#01040c')
      .backgroundImageUrl(config.transparent ? null : '/textures/night-sky.jpg')
      .showAtmosphere(true)
      .atmosphereColor('#3d8bff')
      .atmosphereAltitude(0.16)
      // Rings: a small pulse where the order starts and a bigger one when it lands.
      .ringsData([])
      .ringColor((ring: object) => (t: number) => `rgba(${(ring as Ring).color}, ${Math.max(0, 1 - t) ** 1.5})`)
      .ringMaxRadius((ring) => (ring as Ring).maxRadius)
      .ringPropagationSpeed((ring) => (ring as Ring).speed)
      .ringRepeatPeriod((ring) => (ring as Ring).period)
      .ringResolution(96)
      // The office marker.
      .htmlElementsData(this.markers())
      .htmlElement((marker) => ((marker as Marker).kind === 'total' ? this.totalLabel(marker as TotalMarker) : this.officeMarker()))
      .htmlAltitude((marker) => ((marker as Marker).kind === 'total' ? 0.02 : 0.005));

    if (config.tiles) {
      // Tiles stream in at the level of detail the camera needs.
      const style = globeStyles[config.globeStyle] ?? globeStyles.lights;
      if (style.tint || style.ramp) window.setInterval(() => this.styleTiles(style), 300);
      if (style === globeStyles.lights) {
        // The bundled night-lights image is sharp enough from far out, so the tiles only start
        // after the fly-in: started during it, every zoom level the camera passes through would
        // be fetched for nearly the whole globe (over 2 000 tiles on each first visit).
        this.loadBaseTexture();
        this.pendingTiles = style;
      } else {
        this.globe.globeTileEngineUrl(style.url).globeTileEngineMaxLevel(style.maxLevel);
      }
    } else {
      this.globe
        .globeImageUrl('/textures/earth-night-8k.jpg')
        .bumpImageUrl('/textures/earth-topology.png')
        .onGlobeReady(() => this.sharpenTexture());
      const material = this.globe.globeMaterial() as MeshPhongMaterial;
      material.color = new Color('#ffffff');
      material.emissive = new Color('#06112a');
      material.emissiveIntensity = 0.25;
      material.bumpScale = 3;
      material.shininess = 6;
    }

    const renderer = this.globe.renderer();
    renderer.setPixelRatio(Math.min(renderer.getPixelRatio(), maxRenderWidth / window.innerWidth));
    this.fullPixelRatio = renderer.getPixelRatio();

    // Bloom only on bright things (comets, rings, big cities), so the map itself stays crisp.
    if (!config.transparent) {
      this.bloom = new UnrealBloomPass(new Vector2(window.innerWidth, window.innerHeight), 0.45, 0.22, 0.7);
      const composer = this.globe.postProcessingComposer();
      composer.setPixelRatio(renderer.getPixelRatio());
      composer.addPass(this.bloom);
      this.bloomIndex = composer.passes.indexOf(this.bloom);
    }

    this.heat = new HeatLayer((lat, lng) => {
      const coordinates = this.globe.getCoords(lat, lng, 0.004);
      return new Vector3(coordinates.x, coordinates.y, coordinates.z);
    });
    if (this.bloom) {
      // The heat map is added after bloom and after the conversion to screen colours, onto the
      // finished image, exactly as it used to be added onto the canvas: bloom never sees it (no
      // fog) and its glow keeps the look it was tuned for. Then a plain copy to the screen.
      const heatScene = new Scene();
      heatScene.add(this.heat.object);
      const heatPass = new RenderPass(heatScene, this.globe.camera());
      heatPass.clear = false;
      heatPass.clearDepth = true;
      const composer = this.globe.postProcessingComposer();
      composer.addPass(new OutputPass());
      composer.addPass(heatPass);
      composer.addPass(new ShaderPass(CopyShader));
    } else {
      this.globe.scene().add(this.heat.object);
    }
    if (this.qualityMode === 'low') this.applyQuality(0);

    this.setUpControls();
    this.resize();
    window.addEventListener('resize', () => this.resize());
    // The intro: start far out, east of the drift view, and fly in.
    const start = performance.now();
    const drift = this.driftView(start);
    this.returnFrom = { lat: drift.lat - 12, lng: drift.lng + 55, altitude: introAltitude };
    this.globe.pointOfView(this.returnFrom, 0);
    this.returnStartedAt = start;
    this.returnDuration = introDurationMs;
    this.cameraMode = 'return';
    requestAnimationFrame((now) => this.frame(now));
  }

  private readonly createdAt = performance.now();
  /** Tiles waiting for the fly-in to end (see the constructor). */
  private pendingTiles: GlobeStyle | null = null;
  private baseTexture: Texture | null = null;
  private baseMesh: Mesh | null = null;

  /**
   * A low-resolution copy of the night lights (built from the same NASA layer, 4096×2048, ~300 KB).
   * It goes on three-globe's own globe mesh, which the tile engine hides, so the globe looks right
   * immediately and the sharp tiles stream in on top.
   */
  private loadBaseTexture(): void {
    new TextureLoader().load('/textures/black-marble-base.jpg', (texture) => {
      texture.colorSpace = SRGBColorSpace;
      texture.anisotropy = this.globe.renderer().capabilities.getMaxAnisotropy();
      this.baseTexture = texture;
    });
  }

  /** Shows the base texture on the globe mesh once both exist, just under the tiles. */
  private showBase(): void {
    // Applying it in the very first frames left the canvas blank (an unexplained start-up race in
    // three-globe); a short wait avoids that and still shows it within about a second.
    if (this.baseMesh) {
      // three-globe hides its globe mesh again whenever the tile engine is (re)configured, which
      // left black holes wherever tiles had not loaded yet.
      this.baseMesh.visible = true;
      return;
    }
    if (!this.baseTexture || performance.now() - this.createdAt < 800) return;
    const material = this.globe.globeMaterial() as MeshPhongMaterial;
    this.globe.scene().traverse((object) => {
      if (object instanceof Mesh && object.material === material) {
        material.map = this.baseTexture;
        material.color = new Color(0.85, 0.85, 0.9);
        material.needsUpdate = true;
        // Slightly smaller than the tiles (radius 100), so they always draw over it.
        object.scale.setScalar(0.997);
        object.visible = true;
        this.baseMesh = object;
      }
    });
  }

  /** Applies the style's tint or colour ramp to tiles as they load. */
  private styleTiles(style: GlobeStyle): void {
    this.globe.scene().traverse((object) => {
      if (!(object instanceof Mesh) || !(object.material instanceof MeshLambertMaterial)) return;
      const material = object.material;
      if (!material.map || material.userData.styled) return;
      material.userData.styled = true;
      material.color = style.tint ? new Color(...style.tint) : new Color(1, 1, 1);
      const ramp = style.ramp;
      if (ramp) {
        material.onBeforeCompile = (shader) => {
          shader.uniforms.rampLow = { value: new Color(ramp.low) };
          shader.uniforms.rampHigh = { value: new Color(ramp.high) };
          shader.uniforms.rampEdges = { value: new Vector2(...ramp.edges) };
          shader.fragmentShader = shader.fragmentShader
            .replace('void main() {', 'uniform vec3 rampLow;\nuniform vec3 rampHigh;\nuniform vec2 rampEdges;\nvoid main() {')
            .replace(
              '#include <map_fragment>',
              `#include <map_fragment>
              float brightness = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
              diffuseColor.rgb = mix(rampLow, rampHigh, smoothstep(rampEdges.x, rampEdges.y, brightness));`,
            );
        };
        material.customProgramCacheKey = () => `ramp-${config.globeStyle}`;
      }
      material.needsUpdate = true;
    });
  }

  /** Anisotropic filtering keeps the texture sharp where the globe curves away from the camera. */
  private sharpenTexture(): void {
    const material = this.globe.globeMaterial() as MeshPhongMaterial;
    const anisotropy = this.globe.renderer().capabilities.getMaxAnisotropy();
    for (const texture of [material.map, material.bumpMap] as (Texture | null)[]) {
      if (!texture) continue;
      texture.anisotropy = anisotropy;
      texture.needsUpdate = true;
    }
  }

  /** Applies a quality level: 2 = everything, 1 = no glow, 0 = no glow and 1× pixel density. */
  private applyQuality(level: number): void {
    const composer = this.globe.postProcessingComposer();
    if (this.bloom) {
      const active = composer.passes.includes(this.bloom);
      if (level === 2 && !active) composer.insertPass(this.bloom, this.bloomIndex);
      if (level < 2 && active) composer.removePass(this.bloom);
    }
    const pixelRatio = level === 0 ? 1 : this.fullPixelRatio;
    if (this.globe.renderer().getPixelRatio() !== pixelRatio) {
      this.globe.renderer().setPixelRatio(pixelRatio);
      composer.setPixelRatio(pixelRatio);
      this.resize();
      this.updateHeatScale();
    }
    this.qualityLevel = level;
    document.body.dataset.quality = String(level);
    this.onQualityChange(level, this.qualityMode);
  }

  get quality(): { level: number; mode: QualityMode } {
    return { level: this.qualityLevel, mode: this.qualityMode };
  }

  /** The viewer's choice from the quality switch: kept as is, never lowered automatically. */
  setQualityMode(mode: 'low' | 'high'): void {
    this.qualityMode = mode;
    this.slowChecks = 0;
    this.applyQuality(mode === 'low' ? 0 : 2);
  }

  /**
   * Turns the glow off on slow machines, conservatively: only after the start-up (tile loading makes
   * the first seconds slow everywhere) and only when two checks in a row are under 40 fps. The pixel
   * density is never lowered automatically, since that visibly blurs everything; `?quality=low` does it.
   */
  private checkQuality(now: number, elapsed: number): void {
    if (this.qualityMode !== 'auto' || this.qualityLevel < 2 || document.hidden) return;
    // Ignore the warm-up, gaps from a background tab and stalled frames.
    if (now < this.qualityWarmupUntil) return;
    if (elapsed > 0 && elapsed < 250) this.frameTimes.push(elapsed);
    if (now < this.qualityCheckAt) return;
    this.qualityCheckAt = now + 4000;
    if (this.frameTimes.length < 30) return;
    const averageMs = this.frameTimes.reduce((sum, value) => sum + value, 0) / this.frameTimes.length;
    this.frameTimes = [];
    this.slowChecks = 1000 / averageMs < 40 ? this.slowChecks + 1 : 0;
    // Three slow checks in a row (about 12 s), so a passing hiccup never changes the look.
    if (this.slowChecks >= 3) {
      this.slowChecks = 0;
      console.info('[globe] turning the glow off: the frame rate stayed low');
      this.applyQuality(1);
    }
  }

  private setUpControls(): void {
    const controls = this.globe.controls();
    controls.enableZoom = true;
    controls.zoomSpeed = 0.6;
    controls.rotateSpeed = 0.45;
    // Distances are in globe radii (radius 100): from close over a city to the whole hemisphere.
    controls.minDistance = 120;
    controls.maxDistance = 420;
    controls.autoRotate = false;
    controls.addEventListener('start', () => {
      // The viewer always wins, also over a running camera move.
      this.interacting = true;
      this.shot = null;
      this.cameraMode = 'viewer';
    });
    controls.addEventListener('end', () => {
      this.interacting = false;
      this.lastInteraction = performance.now();
    });
  }

  /** A slow, continuous drift around Scandinavia, where most orders come from. */
  private driftView(now: number): View {
    const seconds = now / 1000;
    return {
      lat: 56.5 + 2.5 * Math.sin((seconds / 70) * 2 * Math.PI),
      lng: 14 + 7 * Math.sin((seconds / 95) * 2 * Math.PI),
      altitude: 0.48 + 0.08 * Math.sin((seconds / 55) * 2 * Math.PI),
    };
  }

  /** A far-away order's view: a little higher, leaning at most shotLeanDegrees towards the origin. */
  private shotTarget(shot: Shot, now: number): View {
    const drift = this.driftView(now);
    const lean = greatCirclePoint(drift.lat, drift.lng, shot.originLat, shot.originLng, Math.min(1, shotLeanDegrees / shot.distance));
    return { ...lean, altitude: drift.altitude + Math.min(shotZoomOut, shot.distance / 300) };
  }

  /** Ease out to the shot's view and, near the end, back into the drift. */
  private shotView(shot: Shot, now: number): View {
    const out = easeInOutCubic(Math.min(1, (now - shot.startedAt) / shotEaseMs));
    const back = easeInOutCubic(Math.max(0, Math.min(1, (now - (shot.endsAt - shotEaseMs)) / shotEaseMs)));
    return lerpView(lerpView(shot.from, this.shotTarget(shot, now), out), this.driftView(now), back);
  }

  /** Per frame: camera (drift, stop for the viewer, ease back when idle), comets, quality. */
  private frame(now: number): void {
    const elapsed = now - (this.lastFrame || now);
    this.lastFrame = now;
    this.checkQuality(now, elapsed);

    if (this.cameraMode === 'viewer' && !this.interacting && now - this.lastInteraction > idleBeforeReturnMs) {
      this.startReturn(now);
    }
    if (this.cameraMode === 'shot' && this.shot) {
      this.globe.pointOfView(this.shotView(this.shot, now), 0);
      if (now >= this.shot.endsAt) {
        this.shot = null;
        this.cameraMode = 'drift';
      }
    } else if (this.cameraMode === 'drift') {
      this.globe.pointOfView(this.driftView(now), 0);
    } else if (this.cameraMode === 'return') {
      const progress = Math.min(1, (now - this.returnStartedAt) / this.returnDuration);
      this.globe.pointOfView(lerpView(this.returnFrom, this.driftView(now), easeInOutCubic(progress)), 0);
      if (progress >= 1) this.cameraMode = 'drift';
    }

    if (this.pendingTiles && (this.cameraMode !== 'return' || now - this.returnStartedAt >= this.returnDuration)) {
      this.globe.globeTileEngineUrl(this.pendingTiles.url).globeTileEngineMaxLevel(this.pendingTiles.maxLevel);
      this.pendingTiles = null;
    }
    if (config.tiles) this.showBase();
    // globe.gl creates the tile engine a moment after start-up; apply the sharpening once it exists.
    if (config.tiles && !this.pendingTiles && !this.tileEngine && Math.floor(now / 500) !== Math.floor((now - elapsed) / 500)) this.sharpenTiles();
    if (this.tileEngine) {
      // Close to Scandinavia keep the sharp level; only when pulled back far allow coarser tiles.
      this.tileEngine.minLevel = this.globe.pointOfView().altitude < 0.9 ? this.nearTileLevel : 0;
    }

    this.heat.update();
    this.comets = this.comets.filter((comet) => {
      if (comet.update(now)) return true;
      this.globe.scene().remove(comet.object);
      comet.dispose();
      return false;
    });
    this.summons = this.summons.filter((summon) => {
      if (summon.update(now, this.globe.camera().position)) return true;
      this.globe.scene().remove(summon.object, summon.flashSprite);
      summon.dispose();
      return false;
    });
    requestAnimationFrame((next) => this.frame(next));
  }

  private startReturn(now: number): void {
    const current = this.globe.pointOfView();
    this.returnFrom = { lat: current.lat, lng: current.lng, altitude: current.altitude };
    this.returnStartedAt = now;
    this.returnDuration = returnDurationMs;
    this.cameraMode = 'return';
  }

  /** A milestone: three wide golden rings ripple out from the office. */
  celebrate(): void {
    [0, 450, 900].forEach((delay) =>
      window.setTimeout(() => this.addRing(config.office.lat, config.office.lng, 7, '255, 214, 140', 2600), delay),
    );
  }

  private resize(): void {
    // Also resizes the post-processing passes, at the renderer's device pixel ratio.
    this.globe.width(window.innerWidth).height(window.innerHeight);
    this.updateHeatScale();
    this.sharpenTiles();
  }

  /**
   * The tile engine picks its zoom level from the camera distance alone (level n from 8 / 2^n globe
   * radii), tuned for small canvases. Bias it by the screen's real width so tiles are never
   * stretched: about two levels finer at 1920 px, three at 4K. The screen width, not the render
   * width, so a lowered pixel density doesn't also make the map blurrier.
   */
  private sharpenTiles(): void {
    if (!config.tiles) return;
    const screenWidth = Math.min(maxRenderWidth, window.innerWidth * window.devicePixelRatio);
    const bias = Math.max(0, Math.round(Math.log2(screenWidth / 512)));
    this.globe.scene().traverse((object: Object3D) => {
      const engine = object as Object3D & { thresholds?: number[]; minLevel?: number; maxLevel?: number };
      if (Array.isArray(engine.thresholds)) {
        // 4 rather than the engine's 8: one level coarser when zoomed in close, which still keeps at
        // least one map pixel per screen pixel there and holds a quarter of the tiles.
        engine.thresholds = engine.thresholds.map((_, level) => (4 * 2 ** bias) / 2 ** level);
        this.tileEngine = engine as Object3D & { thresholds: number[]; minLevel: number; maxLevel: number };
      }
    });
    // Level 7 at most: a 4K screen at level 8 would need about 2 GB of GPU memory at the drift
    // distance. Zooming in still reaches the finer levels through the thresholds above.
    if (this.tileEngine) this.nearTileLevel = Math.min(this.tileEngine.maxLevel, 5 + bias, maxNearTileLevel);
  }

  private updateHeatScale(): void {
    this.heat?.setScale(this.globe.renderer().domElement.height, (this.globe.camera() as PerspectiveCamera).fov);
  }

  private officeMarker(): HTMLElement {
    const marker = document.createElement('div');
    marker.className = 'office';
    marker.innerHTML = `<span class="office__pulse"></span><span class="office__dot"></span>
      <span class="office__label"><strong>${config.office.name}</strong><span>${config.office.city}</span></span>`;
    return marker;
  }

  private markers(): Marker[] {
    return [this.officeDatum, ...this.totalLabels];
  }

  private totalLabel(marker: TotalMarker): HTMLElement {
    const label = document.createElement('div');
    label.className = 'order-total';
    label.textContent = marker.text;
    return label;
  }

  /** Floats the order's total above its origin, unless it is 0 or the spot is already busy. */
  private showTotal(order: Order): void {
    if (order.sek <= 0 || this.totalLabels.length >= maxTotalLabels) return;
    if (this.totalLabels.some((label) => angularDistance(label.lat, label.lng, order.lat, order.lng) < totalSpacingDegrees)) return;
    const label: TotalMarker = { kind: 'total', id: this.nextId++, lat: order.lat, lng: order.lng, text: formatSek(order.sek) };
    this.totalLabels = [...this.totalLabels, label];
    this.globe.htmlElementsData(this.markers());
    window.setTimeout(() => {
      this.totalLabels = this.totalLabels.filter((candidate) => candidate.id !== label.id);
      this.globe.htmlElementsData(this.markers());
    }, totalLabelMs);
  }

  /** A pulse ring; an inward ring starts wide and closes in on the spot. */
  private addRing(lat: number, lng: number, maxRadius: number, color: string, durationMs: number, inward = false): void {
    const speed = ((inward ? -1 : 1) * (maxRadius * 1000)) / durationMs;
    const ring: Ring = { id: this.nextId++, lat, lng, maxRadius, speed, period: durationMs * 2, color };
    this.rings = [...this.rings, ring];
    this.globe.ringsData(this.rings);
    window.setTimeout(() => {
      this.rings = this.rings.filter((candidate) => candidate.id !== ring.id);
      this.globe.ringsData(this.rings);
    }, durationMs);
  }

  /** Today's heat map, as sent with the snapshot. */
  setHeat(cells: HeatCell[]): void {
    this.heat.replace(cells);
  }

  /** A new day started: the heat map starts over. */
  clearHeat(): void {
    this.heat.clear();
  }

  /** Points along the great circle from the order to the office, lifted into an arc. */
  private arcPoints(lat: number, lng: number, distanceDegrees: number): Vector3[] {
    const height = Math.min(0.32, Math.max(0.012, 0.3 * distanceDegrees * toRadians));
    const samples = 64;
    const points: Vector3[] = [];
    for (let index = 0; index <= samples; index++) {
      const t = index / samples;
      const point = greatCirclePoint(lat, lng, config.office.lat, config.office.lng, t);
      const coordinates = this.globe.getCoords(point.lat, point.lng, height * Math.sin(Math.PI * t));
      points.push(new Vector3(coordinates.x, coordinates.y, coordinates.z));
    }
    return points;
  }

  /** Flies a comet from the order to the office; onLand runs when it arrives. */
  launch(order: Order, onLand: () => void): void {
    const distance = angularDistance(order.lat, order.lng, config.office.lat, config.office.lng);
    const duration = Math.round(config.flightMs * (0.75 + Math.min(distance, 120) / 120));
    const large = order.sek >= largeOrderSek;
    const now = performance.now();

    // A far-away order gets a small camera move: at most one every 25 s, never while someone looks around.
    if (distance > farAwayDegrees && this.cameraMode === 'drift' && !this.shot && now - this.lastShot > shotCooldownMs) {
      const current = this.globe.pointOfView();
      this.shot = {
        from: { lat: current.lat, lng: current.lng, altitude: current.altitude },
        startedAt: now,
        endsAt: now + duration + 2 * shotEaseMs,
        originLat: order.lat,
        originLng: order.lng,
        distance,
      };
      this.lastShot = now;
      this.cameraMode = 'shot';
    }

    // The order appears: light gathers on the spot and its total floats up, then the comet leaves.
    const points = this.arcPoints(order.lat, order.lng, distance);
    const summon = new Summon(points[0], getGlowTexture(), large ? 1.4 : 1);
    this.globe.scene().add(summon.object, summon.flashSprite);
    this.summons.push(summon);
    this.addRing(order.lat, order.lng, large ? 1.3 : 0.9, '110, 225, 255', summonMs, true);
    this.showTotal(order);

    const comet = new Comet(
      points,
      duration,
      cometStyles[large ? 'large' : 'normal'],
      () => {
        this.addRing(config.office.lat, config.office.lng, large ? 2.6 : 1.8, '255, 214, 140', 1100);
        this.heat.add(order.lat, order.lng);
        onLand();
      },
      summonMs,
    );
    this.globe.scene().add(comet.object);
    this.comets.push(comet);
    window.setTimeout(() => this.addRing(order.lat, order.lng, distance > farAwayDegrees ? 1.6 : 0.9, '110, 225, 255', 900), summonMs);
  }
}
