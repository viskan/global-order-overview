import {
  AdditiveBlending,
  BufferAttribute,
  CanvasTexture,
  Color,
  CatmullRomCurve3,
  Group,
  Mesh,
  ShaderMaterial,
  Sprite,
  SpriteMaterial,
  TubeGeometry,
  Vector3,
} from 'three';

/** Fraction of the path the tail covers behind the head. */
const tailLength = 0.32;
const tubularSegments = 120;
const radialSegments = 6;

const vertexShader = /* glsl */ `
  attribute float progress;
  uniform float head;
  uniform float tail;
  uniform float radius;
  varying float vStrength;

  void main() {
    float behind = head - progress;
    // 1 at the head, 0 at the end of the tail (and nothing ahead of the head).
    float strength = behind < 0.0 ? 0.0 : clamp(1.0 - behind / tail, 0.0, 1.0);
    vStrength = strength;
    // Taper: full width at the head, a thread at the tail.
    float width = 0.12 + 0.88 * pow(strength, 1.5);
    vec3 shrunk = position - normal * radius * (1.0 - width);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(shrunk, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 tailColor;
  uniform vec3 headColor;
  uniform float fade;
  varying float vStrength;

  void main() {
    if (vStrength <= 0.001) discard;
    float alpha = pow(vStrength, 2.2) * fade;
    vec3 color = mix(tailColor, headColor, pow(vStrength, 5.0));
    // Brighter towards the head so the bloom pass catches it.
    gl_FragColor = vec4(color * (0.55 + 1.6 * pow(vStrength, 8.0)), alpha);
  }
`;

let glowTexture: CanvasTexture | null = null;

/** A soft radial glow for the comet's head, drawn once. */
export const getGlowTexture = (): CanvasTexture => {
  if (glowTexture) return glowTexture;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const context = canvas.getContext('2d')!;
  const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
  gradient.addColorStop(0.18, 'rgba(220, 245, 255, 0.95)');
  gradient.addColorStop(0.45, 'rgba(120, 210, 255, 0.35)');
  gradient.addColorStop(1, 'rgba(60, 160, 255, 0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 128, 128);
  glowTexture = new CanvasTexture(canvas);
  return glowTexture;
};

export type CometStyle = { radius: number; headSize: number; tailColor: string; headColor: string };

/**
 * One order flying to the office: a tapered tube whose visible part (head + fading tail) slides
 * along a great-circle arc, with a glowing sprite on the head.
 */
export class Comet {
  readonly object = new Group();
  private readonly material: ShaderMaterial;
  private readonly head: Sprite;
  private readonly curve: CatmullRomCurve3;
  private readonly startedAt: number;
  private landed = false;

  constructor(
    points: Vector3[],
    private readonly durationMs: number,
    style: CometStyle,
    private readonly onLand: () => void,
    /** Milliseconds before the comet leaves its origin. */
    delayMs = 0,
  ) {
    this.curve = new CatmullRomCurve3(points);
    const geometry = new TubeGeometry(this.curve, tubularSegments, style.radius, radialSegments, false);
    const progress = new Float32Array(geometry.attributes.position.count);
    for (let segment = 0; segment <= tubularSegments; segment++) {
      for (let side = 0; side <= radialSegments; side++) {
        progress[segment * (radialSegments + 1) + side] = segment / tubularSegments;
      }
    }
    geometry.setAttribute('progress', new BufferAttribute(progress, 1));

    this.material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        head: { value: 0 },
        tail: { value: tailLength },
        radius: { value: style.radius },
        fade: { value: 1 },
        tailColor: { value: new Color(style.tailColor) },
        headColor: { value: new Color(style.headColor) },
      },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.object.add(new Mesh(geometry, this.material));

    this.head = new Sprite(
      new SpriteMaterial({ map: getGlowTexture(), color: new Color(style.headColor), transparent: true, depthWrite: false, blending: AdditiveBlending }),
    );
    this.head.scale.setScalar(style.headSize);
    this.head.position.copy(points[0]);
    this.object.add(this.head);
    this.startedAt = performance.now() + delayMs;
    this.head.visible = delayMs === 0;
  }

  /** Advances the comet; returns false once it has fully disappeared into the office. */
  update(now: number): boolean {
    // The head travels 0 → 1 in durationMs, then the tail slides in behind it.
    const head = (now - this.startedAt) / this.durationMs;
    this.material.uniforms.head.value = head;
    if (head < 0) return true;
    if (head < 1) {
      this.head.visible = true;
      this.head.position.copy(this.curve.getPointAt(head));
    } else {
      this.head.visible = false;
      if (!this.landed) {
        this.landed = true;
        this.onLand();
      }
    }
    return head < 1 + tailLength;
  }

  dispose(): void {
    this.object.traverse((child) => {
      if (child instanceof Mesh) {
        child.geometry.dispose();
        (child.material as ShaderMaterial).dispose();
      }
      if (child instanceof Sprite) child.material.dispose();
    });
  }
}
