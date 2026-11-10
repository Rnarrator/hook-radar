/** The Hook Radar instrument: a lit dial, a tick bezel, a sweeping scan and a
 * polished hook sculpture. Purely decorative brand art. The blips are fixed
 * illustrative positions and never encode data. This module (and `three`) is
 * dynamically imported only on capable devices; see RadarInstrument.tsx. */
import {
  ACESFilmicToneMapping,
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CatmullRomCurve3,
  Color,
  DirectionalLight,
  DoubleSide,
  Group,
  HemisphereLight,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  RingGeometry,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  SRGBColorSpace,
  CylinderGeometry,
  TorusGeometry,
  TubeGeometry,
  Vector3,
  WebGLRenderer,
} from "three";

export interface RadarSceneOptions {
  canvas: HTMLCanvasElement;
  /** Called when rendering is too slow or the GL context is lost. */
  onConstrained: () => void;
}

export interface RadarScene {
  setActive(active: boolean): void;
  resize(): void;
  dispose(): void;
}

const INK = 0xf3f5fc;
const SIGNAL = 0xff5ca9;
const RULE = 0xa0b0ff;

/** Fixed, illustrative blip positions (angle in radians, radius). */
const BLIPS: readonly [number, number][] = [
  [0.55, 1.15],
  [1.7, 1.9],
  [2.45, 0.85],
  [3.4, 1.55],
  [4.25, 2.15],
  [5.3, 1.05],
];

export function createRadarScene({
  canvas,
  onConstrained,
}: RadarSceneOptions): RadarScene {
  const renderer = new WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    powerPreference: "low-power",
  });
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  let pixelRatio = Math.min(window.devicePixelRatio || 1, 1.75);
  renderer.setPixelRatio(pixelRatio);

  const scene = new Scene();
  const camera = new PerspectiveCamera(30, 1, 0.1, 60);
  camera.position.set(0, 4.0, 7.7);
  camera.lookAt(0, 0.45, 0);

  scene.add(new HemisphereLight(0x8f9bff, 0x05060c, 0.7));
  const key = new DirectionalLight(0xfff1f7, 2.8);
  key.position.set(-4, 6, 3);
  scene.add(key);
  const rim = new DirectionalLight(SIGNAL, 2.4);
  rim.position.set(5, 2.5, -4);
  scene.add(rim);

  const disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(item: T): T => {
    disposables.push(item);
    return item;
  };

  const root = new Group();
  scene.add(root);
  const dial = new Group();
  root.add(dial);

  // Dial plate and etched rings.
  const plate = new Mesh(
    keep(new CylinderGeometry(2.62, 2.72, 0.14, 96)),
    keep(
      new MeshStandardMaterial({
        color: 0x0c1020,
        metalness: 0.65,
        roughness: 0.46,
      }),
    ),
  );
  plate.position.y = -0.07;
  dial.add(plate);

  for (const [radius, opacity] of [
    [0.55, 0.16],
    [1.15, 0.2],
    [1.75, 0.2],
    [2.35, 0.34],
  ] as const) {
    const ring = new Mesh(
      keep(new RingGeometry(radius - 0.008, radius + 0.008, 160).rotateX(-Math.PI / 2)),
      keep(
        new MeshBasicMaterial({
          color: RULE,
          transparent: true,
          opacity,
          depthWrite: false,
        }),
      ),
    );
    ring.position.y = 0.003;
    dial.add(ring);
  }

  // Bezel.
  const bezel = new Mesh(
    keep(new TorusGeometry(2.68, 0.05, 24, 180).rotateX(Math.PI / 2)),
    keep(
      new MeshStandardMaterial({
        color: 0xdfe5ff,
        metalness: 1,
        roughness: 0.26,
      }),
    ),
  );
  dial.add(bezel);

  // Ticks around the dial.
  const TICKS = 120;
  const tickMaterial = keep(
    new MeshBasicMaterial({ color: RULE, transparent: true, opacity: 0.6 }),
  );
  const tickMesh = new InstancedMesh(
    keep(new BoxGeometry(0.014, 0.012, 0.1)),
    tickMaterial,
    TICKS,
  );
  const dummy = new Object3D();
  for (let i = 0; i < TICKS; i += 1) {
    const angle = (i / TICKS) * Math.PI * 2;
    const long = i % 10 === 0;
    const radius = long ? 2.42 : 2.46;
    dummy.position.set(Math.cos(angle) * radius, 0.01, Math.sin(angle) * radius);
    dummy.rotation.set(0, -angle + Math.PI / 2, 0);
    dummy.scale.set(long ? 1.6 : 1, 1, long ? 1.9 : 1);
    dummy.updateMatrix();
    tickMesh.setMatrixAt(i, dummy.matrix);
  }
  dial.add(tickMesh);

  // Tilted gimbal ring that adds depth parallax.
  const gimbal = new Group();
  const gimbalRing = new Mesh(
    keep(new TorusGeometry(3.0, 0.022, 16, 200)),
    keep(
      new MeshStandardMaterial({
        color: 0xbfc8f0,
        metalness: 1,
        roughness: 0.32,
      }),
    ),
  );
  gimbal.add(gimbalRing);
  gimbal.rotation.x = Math.PI / 2 - 0.34;
  root.add(gimbal);

  // Sweep: a fan with a per-vertex alpha falloff behind the leading edge.
  const SEGMENTS = 56;
  const ARC = 1.15;
  const positions: number[] = [0, 0.012, 0];
  const alphas: number[] = [0.0];
  for (let i = 0; i <= SEGMENTS; i += 1) {
    const t = i / SEGMENTS;
    const angle = -t * ARC;
    positions.push(Math.cos(angle) * 2.36, 0.012, Math.sin(angle) * 2.36);
    alphas.push(Math.pow(1 - t, 1.6));
  }
  const indices: number[] = [];
  for (let i = 1; i <= SEGMENTS; i += 1) indices.push(0, i, i + 1);
  const sweepGeometry = keep(new BufferGeometry());
  sweepGeometry.setAttribute(
    "position",
    new BufferAttribute(new Float32Array(positions), 3),
  );
  sweepGeometry.setAttribute(
    "aAlpha",
    new BufferAttribute(new Float32Array(alphas), 1),
  );
  sweepGeometry.setIndex(indices);
  const sweepMaterial = keep(
    new ShaderMaterial({
      uniforms: { uColor: { value: new Color(SIGNAL) } },
      vertexShader: `attribute float aAlpha; varying float vAlpha;
        void main(){ vAlpha = aAlpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform vec3 uColor; varying float vAlpha;
        void main(){ gl_FragColor = vec4(uColor, vAlpha * 0.64); }`,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
    }),
  );
  const sweep = new Group();
  sweep.add(new Mesh(sweepGeometry, sweepMaterial));
  const edge = new Mesh(
    keep(new BoxGeometry(2.36, 0.006, 0.016)),
    keep(new MeshBasicMaterial({ color: SIGNAL })),
  );
  edge.position.set(1.18, 0.014, 0);
  sweep.add(edge);
  dial.add(sweep);

  // Soft pool of light under the hook.
  const pool = new Mesh(
    keep(new RingGeometry(0.0, 0.9, 64).rotateX(-Math.PI / 2)),
    keep(
      new ShaderMaterial({
        uniforms: { uColor: { value: new Color(SIGNAL) } },
        vertexShader: `varying vec2 vP; void main(){ vP = position.xz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: `uniform vec3 uColor; varying vec2 vP;
          void main(){ float d = length(vP) / 0.9; gl_FragColor = vec4(uColor, pow(1.0 - d, 2.2) * 0.34); }`,
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
      }),
    ),
  );
  pool.position.y = 0.01;
  dial.add(pool);

  // The hook: a polished J whose eye is a lit blip.
  const hook = new Group();
  const path: Vector3[] = [new Vector3(0.3, 1.62, 0), new Vector3(0.3, 1.1, 0)];
  for (let i = 0; i <= 14; i += 1) {
    const angle = (i / 14) * Math.PI;
    path.push(
      new Vector3(Math.cos(angle) * 0.3, 0.62 - Math.sin(angle) * 0.34, 0),
    );
  }
  path.push(new Vector3(-0.3, 0.84, 0), new Vector3(-0.3, 1.0, 0));
  const hookMesh = new Mesh(
    keep(new TubeGeometry(new CatmullRomCurve3(path, false, "centripetal"), 200, 0.078, 20, false)),
    keep(
      new MeshStandardMaterial({
        color: INK,
        metalness: 0.88,
        roughness: 0.2,
      }),
    ),
  );
  hook.add(hookMesh);
  const eye = new Mesh(
    keep(new SphereGeometry(0.125, 32, 24)),
    keep(
      new MeshStandardMaterial({
        color: SIGNAL,
        emissive: SIGNAL,
        emissiveIntensity: 1.15,
        roughness: 0.35,
      }),
    ),
  );
  eye.position.set(0.3, 1.74, 0);
  hook.add(eye);
  hook.position.y = 0.14;
  hook.scale.setScalar(1.18);
  dial.add(hook);

  // Illustrative blips that light as the sweep passes.
  const blipGeometry = keep(new SphereGeometry(0.062, 16, 12));
  const blips = BLIPS.map(([angle, radius]) => {
    const material = keep(
      new MeshBasicMaterial({ color: SIGNAL, transparent: true, opacity: 0 }),
    );
    const mesh = new Mesh(blipGeometry, material);
    mesh.position.set(Math.cos(angle) * radius, 0.04, Math.sin(angle) * radius);
    dial.add(mesh);
    return { angle, material, mesh };
  });

  // Interaction: pointer parallax and drag-to-spin with a spring back.
  const target = { x: 0, y: 0 };
  const tilt = { x: 0, y: 0 };
  let yaw = 0;
  let yawVelocity = 0;
  let dragging = false;
  let lastX = 0;
  let lastMove = 0;
  const bounds = () => canvas.getBoundingClientRect();
  const onMove = (event: PointerEvent) => {
    const box = bounds();
    target.x = ((event.clientX - box.left) / box.width - 0.5) * 2;
    target.y = ((event.clientY - box.top) / box.height - 0.5) * 2;
    if (dragging) {
      const delta = event.clientX - lastX;
      yaw += delta * 0.008;
      yawVelocity = delta * 0.008;
      lastX = event.clientX;
      lastMove = performance.now();
    }
  };
  const onDown = (event: PointerEvent) => {
    dragging = true;
    lastX = event.clientX;
    canvas.setPointerCapture(event.pointerId);
    canvas.style.cursor = "grabbing";
  };
  const onUp = (event: PointerEvent) => {
    dragging = false;
    if (canvas.hasPointerCapture(event.pointerId))
      canvas.releasePointerCapture(event.pointerId);
    canvas.style.cursor = "grab";
  };
  const onLeave = () => {
    if (!dragging) {
      target.x = 0;
      target.y = 0;
    }
  };
  canvas.style.cursor = "grab";
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
  canvas.addEventListener("pointerleave", onLeave);

  const lost = (event: Event) => {
    event.preventDefault();
    onConstrained();
  };
  canvas.addEventListener("webglcontextlost", lost);

  function resize() {
    const width = Math.max(1, canvas.clientWidth);
    const height = Math.max(1, canvas.clientHeight);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    // Keep the whole dial visible in narrow containers.
    camera.fov = camera.aspect < 1 ? 40 : 31;
    camera.updateProjectionMatrix();
  }
  resize();

  let frame = 0;
  let tick = 0;
  let inert = false;
  let active = false;
  let last = 0;
  let sweepAngle = 0;
  let sampled = 0;
  let elapsedTotal = 0;

  function render(time: number) {
    frame = 0;
    if (!active) return;
    const dt = Math.min(0.05, last ? (time - last) / 1000 : 0.016);
    last = time;

    // Adaptive quality: step down once, then give up gracefully.
    if (sampled < 90) {
      sampled += 1;
      elapsedTotal += dt;
      if (sampled === 90) {
        const average = elapsedTotal / sampled;
        if (average > 0.045 && pixelRatio > 1) {
          pixelRatio = 1;
          renderer.setPixelRatio(1);
          resize();
          sampled = 0;
          elapsedTotal = 0;
        } else if (average > 0.055) {
          onConstrained();
          return;
        }
      }
    }

    sweepAngle -= dt * 0.62;
    sweep.rotation.y = sweepAngle;
    gimbal.rotation.z += dt * 0.07;
    hook.rotation.y = Math.sin(time / 2600) * 0.55 + yaw * 0.4;
    eye.scale.setScalar(1 + Math.sin(time / 420) * 0.06);

    for (const blip of blips) {
      // Angular distance behind the leading edge (sweep rotates clockwise).
      let behind = (blip.angle + sweepAngle) % (Math.PI * 2);
      if (behind < 0) behind += Math.PI * 2;
      const intensity = behind < 2.4 ? Math.exp(-behind * 1.5) : 0;
      blip.material.opacity = Math.min(1, intensity * 1.2);
      blip.mesh.scale.setScalar(1 + intensity * 1.4);
    }

    if (!dragging) {
      if (performance.now() - lastMove > 60) yaw += yawVelocity;
      yawVelocity *= 0.92;
      yaw += (0 - yaw) * Math.min(1, dt * 0.9);
    }
    tilt.x += (target.y * 0.14 - tilt.x) * Math.min(1, dt * 5);
    tilt.y += (target.x * 0.22 - tilt.y) * Math.min(1, dt * 5);
    root.rotation.x = tilt.x;
    root.rotation.z = -tilt.y * 0.35;
    root.rotation.y = yaw + tilt.y * 0.5;

    // Skip drawing while a dialog makes the page inert; keep the loop cheap.
    if (tick++ % 20 === 0) inert = Boolean(canvas.closest("[inert]"));
    if (!inert) renderer.render(scene, camera);
    frame = requestAnimationFrame(render);
  }

  // One still frame so a paused or offscreen scene is never blank.
  renderer.render(scene, camera);

  return {
    setActive(next: boolean) {
      if (next === active) return;
      active = next;
      last = 0;
      if (active && !frame) frame = requestAnimationFrame(render);
      if (!active && frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
    },
    resize() {
      resize();
      if (!active) renderer.render(scene, camera);
    },
    dispose() {
      active = false;
      if (frame) cancelAnimationFrame(frame);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("webglcontextlost", lost);
      tickMesh.dispose();
      for (const item of disposables) item.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
