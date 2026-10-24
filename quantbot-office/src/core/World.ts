import {
  ACESFilmicToneMapping, Color, DirectionalLight, Fog, HemisphereLight, PCFSoftShadowMap, PerspectiveCamera,
  PointLight, Scene, SRGBColorSpace, Vector3, WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';

export interface CameraPreset {
  id: string;
  label: string;
  pos: [number, number, number];
  target: [number, number, number];
  /** Hide the upper floor while using this view (to see rooms underneath it). */
  hideUpper?: boolean;
}

export const CAMERA_PRESETS: CameraPreset[] = [
  { id: 'overview', label: 'Overview', pos: [26, 30, 36], target: [0, 0, -2] },
  { id: 'trading', label: 'Trading Floor', pos: [-13, 13, 6], target: [-13, 0, -10] },
  { id: 'meeting', label: 'Meeting', pos: [9, 10, -1], target: [2, 0, -10.5] },
  { id: 'odin', label: 'Ruang Odin', pos: [15, 9, -2], target: [15, 0, -11] },
  { id: 'leads', label: 'Leads', pos: [-13, 11, 20], target: [-13, 0, 5] },
  { id: 'pantry', label: 'Pantry', pos: [2, 11, 19], target: [2, 0, 6], hideUpper: true },
  { id: 'lounge', label: 'Lounge', pos: [17, 11, 19], target: [17, 0, 6], hideUpper: true },
  { id: 'yama', label: 'Ruang Yama', pos: [2, 12, 18], target: [2, 4.2, 5] },
  { id: 'game', label: 'Game Room', pos: [17, 12, 18], target: [17, 4.2, 6] },
];

/** Renderer, camera, lights, orbit controls, label overlay and smooth camera moves. */
export class World {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(45, 1, 0.1, 300);
  readonly renderer: WebGLRenderer;
  readonly labels = new CSS2DRenderer();
  readonly controls: OrbitControls;
  private tween: { fromPos: Vector3; toPos: Vector3; fromT: Vector3; toT: Vector3; t: number } | null = null;
  private followTarget: { position: Vector3 } | null = null;
  private lastFollow = new Vector3();

  constructor(container: HTMLElement) {
    this.renderer = new WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.labels.domElement.className = 'label-layer';
    container.appendChild(this.labels.domElement);

    this.scene.background = new Color('#0a0d12');
    this.scene.fog = new Fog('#0a0d12', 60, 140);

    this.scene.add(new HemisphereLight('#dbe7ff', '#2a2420', 1.25));
    const sun = new DirectionalLight('#fff4e0', 1.9);
    sun.position.set(18, 34, 22);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -32; sc.right = 32; sc.top = 26; sc.bottom = -26; sc.near = 1; sc.far = 90;
    sun.shadow.bias = -0.0005;
    this.scene.add(sun);
    // Fill lights under the upper slab and on the trading floor
    for (const [x, y, z, c, i] of [
      [2, 3.6, 6, '#ffe2b8', 18], [17, 3.6, 6, '#cfe8ff', 18], [-13, 3, -10, '#a5d8ff', 22], [10, 3.6, 4, '#ffffff', 8],
    ] as [number, number, number, string, number][]) {
      const l = new PointLight(c, i, 16, 1.6);
      l.position.set(x, y, z);
      this.scene.add(l);
    }

    this.controls = new OrbitControls(this.camera, this.labels.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.47;
    this.controls.minDistance = 3;
    this.controls.maxDistance = 90;
    const p = CAMERA_PRESETS[0];
    this.camera.position.set(...p.pos);
    this.controls.target.set(...p.target);

    const resize = () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h);
      this.labels.setSize(w, h);
    };
    window.addEventListener('resize', resize);
    resize();
  }

  flyTo(preset: CameraPreset): void {
    this.followTarget = null;
    this.tween = {
      fromPos: this.camera.position.clone(), toPos: new Vector3(...preset.pos),
      fromT: this.controls.target.clone(), toT: new Vector3(...preset.target), t: 0,
    };
  }

  /** Keep the camera's offset while the target moves (orbiting still works). */
  follow(target: { position: Vector3 } | null): void {
    this.followTarget = target;
    this.tween = null;
    if (!target) return;
    const offset = this.camera.position.clone().sub(this.controls.target).setLength(9);
    offset.y = Math.max(offset.y, 5);
    const goal = target.position.clone().add(new Vector3(0, 1, 0));
    this.tween = { fromPos: this.camera.position.clone(), toPos: goal.clone().add(offset), fromT: this.controls.target.clone(), toT: goal, t: 0 };
    this.lastFollow.copy(target.position);
  }

  get followed(): { position: Vector3 } | null {
    return this.followTarget;
  }

  update(dt: number): void {
    if (this.tween) {
      const tw = this.tween;
      tw.t = Math.min(1, tw.t + dt / 1.2);
      const e = tw.t < 0.5 ? 2 * tw.t * tw.t : 1 - (-2 * tw.t + 2) ** 2 / 2;
      if (this.followTarget) {
        const delta = this.followTarget.position.clone().sub(this.lastFollow);
        tw.toPos.add(delta);
        tw.toT.add(delta);
        this.lastFollow.copy(this.followTarget.position);
      }
      this.camera.position.lerpVectors(tw.fromPos, tw.toPos, e);
      this.controls.target.lerpVectors(tw.fromT, tw.toT, e);
      if (tw.t >= 1) this.tween = null;
    } else if (this.followTarget) {
      const delta = this.followTarget.position.clone().sub(this.lastFollow);
      this.camera.position.add(delta);
      this.controls.target.add(delta);
      this.lastFollow.copy(this.followTarget.position);
    }
    this.controls.update();
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  }
}
