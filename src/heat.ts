import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, Points, ShaderMaterial, type Vector3 } from 'three';
import type { HeatCell } from './types';

/** Must match the backend's stats.HeatCellDegrees. */
const cellDegrees = 0.5;

const vertexShader = /* glsl */ `
  attribute float intensity;
  uniform float scale;
  varying float vIntensity;

  void main() {
    vIntensity = intensity;
    // Cells on the far side of the globe are hidden here, not by the depth buffer: the layer may
    // be drawn after post-processing, where the globe's depth is no longer available.
    vec3 world = (modelMatrix * vec4(position, 1.0)).xyz;
    if (dot(world, cameraPosition - world) < 0.0) {
      gl_PointSize = 0.0;
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }
    vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
    // World-sized glow (in globe units, radius 100) that grows a little with the order count.
    float size = 1.3 + 1.7 * intensity;
    gl_PointSize = size * scale / -viewPosition.z;
    gl_Position = projectionMatrix * viewPosition;
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 coldColor;
  uniform vec3 hotColor;
  varying float vIntensity;

  void main() {
    float distance = length(gl_PointCoord - 0.5) * 2.0;
    if (distance > 1.0) discard;
    float falloff = pow(1.0 - distance, 3.2);
    vec3 color = mix(coldColor, hotColor, vIntensity);
    gl_FragColor = vec4(color, falloff * (0.05 + 0.4 * vIntensity * vIntensity));
  }
`;

const cellKey = (lat: number, lng: number): string => `${Math.floor(lat / cellDegrees)}:${Math.floor(lng / cellDegrees)}`;

/** A cell's order count and coordinate sums; it is drawn at the average position of its orders. */
type Cell = { orders: number; latSum: number; lngSum: number };

/**
 * Today's orders as a glowing heat map: one soft additive sprite per half-degree cell, at the average
 * position of its orders (so the grid never shows), brighter and larger with more orders. Drawn as a single Points object, so it stays cheap with thousands of cells.
 */
export class HeatLayer {
  readonly object: Points;
  private readonly material: ShaderMaterial;
  private readonly cells = new Map<string, Cell>();
  private dirty = false;

  constructor(private readonly toPosition: (lat: number, lng: number) => Vector3) {
    this.material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        scale: { value: 500 },
        coldColor: { value: new Color('#1a62ff') },
        hotColor: { value: new Color('#9ff4ff') },
      },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.object = new Points(new BufferGeometry(), this.material);
    // The geometry changes as orders arrive; skip frustum culling on a stale bounding sphere.
    this.object.frustumCulled = false;
  }

  /** Sets the projection factor so glow sizes are in world units: canvas height / (2·tan(fov/2)). */
  setScale(canvasHeight: number, fovDegrees: number): void {
    this.material.uniforms.scale.value = canvasHeight / (2 * Math.tan((fovDegrees * Math.PI) / 360));
  }

  replace(cells: HeatCell[]): void {
    this.cells.clear();
    for (const cell of cells) {
      this.cells.set(cellKey(cell.lat, cell.lng), { orders: cell.orders, latSum: cell.lat * cell.orders, lngSum: cell.lng * cell.orders });
    }
    this.dirty = true;
  }

  add(lat: number, lng: number): void {
    const key = cellKey(lat, lng);
    const existing = this.cells.get(key);
    if (existing) {
      existing.orders++;
      existing.latSum += lat;
      existing.lngSum += lng;
    } else this.cells.set(key, { orders: 1, latSum: lat, lngSum: lng });
    this.dirty = true;
  }

  clear(): void {
    this.cells.clear();
    this.dirty = true;
  }

  /** Rebuilds the buffers when cells changed; called every frame, does nothing otherwise. */
  update(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const cells = [...this.cells.values()];
    const busiest = Math.max(10, ...cells.map((cell) => cell.orders));
    const positions = new Float32Array(cells.length * 3);
    const intensities = new Float32Array(cells.length);
    cells.forEach((cell, index) => {
      const position = this.toPosition(cell.latSum / cell.orders, cell.lngSum / cell.orders);
      positions.set([position.x, position.y, position.z], index * 3);
      // Logarithmic, so a few busy cities don't wash out everything else.
      intensities[index] = Math.log1p(cell.orders) / Math.log1p(busiest);
    });
    const geometry = this.object.geometry;
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('intensity', new BufferAttribute(intensities, 1));
    geometry.setDrawRange(0, cells.length);
  }
}
