import {
  AdditiveBlending,
  CylinderGeometry,
  Group,
  Mesh,
  ShaderMaterial,
  Sprite,
  SpriteMaterial,
  type Texture,
  Vector3,
} from 'three';

/** How long the light gathers before the comet leaves. */
export const summonMs = 550;
/** How long the pillar takes to fade after the comet left. */
const fadeMs = 600;
const pillarHeight = 3.2;

const vertexShader = /* glsl */ `
  varying float vHeight;
  void main() {
    vHeight = position.y + 0.5;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform float opacity;
  varying float vHeight;
  void main() {
    // Brightest at the ground, fading to nothing at the top.
    float alpha = pow(1.0 - vHeight, 2.2) * opacity;
    gl_FragColor = vec4(vec3(0.62, 0.9, 1.0) * (0.8 + 0.6 * (1.0 - vHeight)), alpha);
  }
`;

const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3;

/**
 * The moment an order appears: a column of light rises from the spot, then flashes as the comet
 * leaves. Short-lived and cheap: one open cylinder and one sprite.
 */
export class Summon {
  readonly object = new Group();
  private readonly material: ShaderMaterial;
  private readonly pillar: Mesh;
  private readonly flash: Sprite;
  private readonly normal: Vector3;
  private readonly toCamera = new Vector3();
  private readonly startedAt = performance.now();

  constructor(surface: Vector3, glowTexture: Texture, private readonly size: number) {
    const geometry = new CylinderGeometry(0.03 * size, 0.16 * size, 1, 16, 1, true);
    this.material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: { opacity: { value: 0 } },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.pillar = new Mesh(geometry, this.material);
    this.flash = new Sprite(
      // A sprite centred on the ground is half inside the globe, so it skips the depth test and is
      // hidden instead while its spot faces away from the camera.
      new SpriteMaterial({
        map: glowTexture,
        color: 0xc9f3ff,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: AdditiveBlending,
        opacity: 0,
      }),
    );
    this.flash.position.copy(surface);
    this.normal = surface.clone().normalize();

    // Stand the pillar on the surface, pointing away from the globe's centre.
    const up = surface.clone().normalize();
    this.object.position.copy(surface);
    this.object.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), up);
    this.object.add(this.pillar);
    this.pillar.scale.set(1, 0.001, 1);
    this.pillar.position.y = 0;
  }

  /** The flash sprite lives in world space, so the globe adds it next to the pillar group. */
  get flashSprite(): Sprite {
    return this.flash;
  }

  /** Returns false once the effect is over. */
  update(now: number, cameraPosition: Vector3): boolean {
    this.flash.visible = this.toCamera.subVectors(cameraPosition, this.flash.position).dot(this.normal) > 0;
    const elapsed = now - this.startedAt;
    const height = pillarHeight * this.size;
    if (elapsed < summonMs) {
      const rise = easeOutCubic(elapsed / summonMs);
      this.pillar.scale.y = height * rise;
      this.pillar.position.y = (height * rise) / 2;
      this.material.uniforms.opacity.value = 0.9 * rise;
    } else {
      const fade = Math.min(1, (elapsed - summonMs) / fadeMs);
      this.material.uniforms.opacity.value = 0.9 * (1 - fade);
    }
    // The flash peaks as the comet leaves.
    const flash = Math.max(0, 1 - Math.abs(elapsed - summonMs) / 260);
    this.flash.material.opacity = flash;
    this.flash.scale.setScalar(this.size * (0.6 + 2.2 * flash));
    return elapsed < summonMs + fadeMs;
  }

  dispose(): void {
    this.pillar.geometry.dispose();
    this.material.dispose();
    this.flash.material.dispose();
  }
}
