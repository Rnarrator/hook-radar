import { useEffect, useRef, useState } from "react";
import type { RadarScene } from "./radar-scene";

type Mode = "static" | "live";

interface NetworkInformation {
  saveData?: boolean;
}
interface CapabilityNavigator extends Navigator {
  deviceMemory?: number;
  connection?: NetworkInformation;
}

/** Software rasterizers (SwiftShader, llvmpipe, Basic Render) draw the scene on
 * the CPU and block the main thread for seconds, so they keep the static
 * instrument. Tests that need the live scene on such a machine set
 * `window.__radarForceWebGL = true` before load. */
const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|software|basic render/i;

function webglAvailable() {
  try {
    const probe = document.createElement("canvas");
    const gl = (probe.getContext("webgl2") ||
      probe.getContext("webgl")) as WebGLRenderingContext | null;
    if (!gl) return false;
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = info
      ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL))
      : "";
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    const forced =
      (window as unknown as { __radarForceWebGL?: boolean })
        .__radarForceWebGL === true;
    return forced || !SOFTWARE_RENDERER.test(renderer);
  } catch {
    return false;
  }
}

/** Constrained devices and explicit preferences keep the static instrument. */
function eligibleForLive() {
  if (typeof window === "undefined") return false;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches)
    return false;
  const nav = navigator as CapabilityNavigator;
  if (nav.connection?.saveData) return false;
  if (nav.deviceMemory !== undefined && nav.deviceMemory < 4) return false;
  if (
    nav.hardwareConcurrency !== undefined &&
    nav.hardwareConcurrency < 4
  )
    return false;
  return webglAvailable();
}

/** Brand instrument for the Discover masthead. It is decorative: aria-hidden,
 * never keyboard-focusable, and its blips are fixed illustrative positions. The
 * heavy WebGL scene loads only on capable devices after the page is idle and
 * visible; everything else shows the equivalent static artwork. */
export function RadarInstrument() {
  const host = useRef<HTMLElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [mode, setMode] = useState<Mode>("static");

  useEffect(() => {
    const element = host.current;
    const surface = canvas.current;
    if (!element || !surface) return;
    let scene: RadarScene | null = null;
    let cancelled = false;
    let onscreen = false;
    let pageVisible = !document.hidden;
    let loading = false;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");

    const sync = () => scene?.setActive(onscreen && pageVisible && !media.matches);
    const fallBack = () => {
      scene?.dispose();
      scene = null;
      setMode("static");
    };

    async function start() {
      if (loading || scene || cancelled || !eligibleForLive()) return;
      loading = true;
      try {
        const module = await import("./radar-scene");
        if (cancelled || !surface) return;
        scene = module.createRadarScene({
          canvas: surface,
          onConstrained: fallBack,
        });
        setMode("live");
        sync();
      } catch {
        fallBack();
      } finally {
        loading = false;
      }
    }

    const observer = new IntersectionObserver(([record]) => {
      onscreen = record.isIntersecting;
      if (onscreen) {
        const idle = window.requestIdleCallback
          ? (callback: () => void) =>
              window.requestIdleCallback(callback, { timeout: 1500 })
          : (callback: () => void) => window.setTimeout(callback, 400);
        idle(() => void start());
      }
      sync();
    });
    observer.observe(element);

    const visibility = () => {
      pageVisible = !document.hidden;
      sync();
    };
    document.addEventListener("visibilitychange", visibility);
    const motion = () => {
      if (media.matches) fallBack();
      else void start();
    };
    media.addEventListener("change", motion);
    const resizer = new ResizeObserver(() => scene?.resize());
    resizer.observe(element);

    return () => {
      cancelled = true;
      observer.disconnect();
      resizer.disconnect();
      document.removeEventListener("visibilitychange", visibility);
      media.removeEventListener("change", motion);
      scene?.dispose();
      scene = null;
    };
  }, []);

  return (
    <figure
      ref={host}
      className="radar-instrument"
      data-mode={mode}
      aria-hidden="true"
    >
      <RadarStaticArt />
      <canvas ref={canvas} className="radar-canvas" />
    </figure>
  );
}

const BLIPS: readonly [number, number][] = [
  [0.55, 1.15],
  [1.7, 1.9],
  [2.45, 0.85],
  [3.4, 1.55],
  [4.25, 2.15],
  [5.3, 1.05],
];

/** Static equivalent of the live instrument: same rings, ticks, sweep and hook. */
function RadarStaticArt() {
  const scale = 46;
  const ticks = Array.from({ length: 72 }, (_, i) => {
    const angle = (i / 72) * Math.PI * 2;
    const long = i % 6 === 0;
    const r0 = 2.62 * scale;
    const r1 = (long ? 2.4 : 2.5) * scale;
    return (
      <line
        key={i}
        x1={Math.cos(angle) * r0}
        y1={Math.sin(angle) * r0}
        x2={Math.cos(angle) * r1}
        y2={Math.sin(angle) * r1}
        stroke="var(--rule-focus)"
        strokeWidth={long ? 1.6 : 1}
      />
    );
  });
  const arc = (r: number, a0: number, a1: number) =>
    `${Math.cos(a0) * r} ${Math.sin(a0) * r}A${r} ${r} 0 0 1 ${Math.cos(a1) * r} ${Math.sin(a1) * r}`;
  const sweepStart = -1.9;
  const sweepEnd = sweepStart + 1.0;
  return (
    <svg
      className="radar-static"
      viewBox="-150 -140 300 280"
      focusable="false"
      aria-hidden="true"
    >
      <defs>
        <radialGradient id="radar-plate" cx="35%" cy="28%" r="85%">
          <stop offset="0" stopColor="#1a2140" />
          <stop offset="1" stopColor="#0a0d1a" />
        </radialGradient>
        <linearGradient
          id="radar-sweep"
          x1={Math.cos(sweepEnd) * 120}
          y1={Math.sin(sweepEnd) * 120}
          x2={Math.cos(sweepStart) * 120}
          y2={Math.sin(sweepStart) * 120}
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="var(--signal)" stopOpacity="0.5" />
          <stop offset="1" stopColor="var(--signal)" stopOpacity="0" />
        </linearGradient>
        <radialGradient id="radar-pool" r="1">
          <stop offset="0" stopColor="var(--signal)" stopOpacity="0.4" />
          <stop offset="1" stopColor="var(--signal)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <g transform="scale(1 0.78)">
        <circle r={2.72 * scale} fill="url(#radar-plate)" stroke="var(--rule-strong)" />
        {[0.55, 1.15, 1.75, 2.35].map((r) => (
          <circle
            key={r}
            r={r * scale}
            fill="none"
            stroke="var(--rule-focus)"
            strokeOpacity={r > 2 ? 0.8 : 0.45}
          />
        ))}
        {ticks}
        <circle
          r={2.68 * scale}
          fill="none"
          stroke="#dfe5ff"
          strokeOpacity="0.85"
          strokeWidth="3"
        />
        <path
          d={`M0 0L${arc(2.36 * scale, sweepStart, sweepEnd)}Z`}
          fill="url(#radar-sweep)"
        />
        <line
          x1="0"
          y1="0"
          x2={Math.cos(sweepEnd) * 2.36 * scale}
          y2={Math.sin(sweepEnd) * 2.36 * scale}
          stroke="var(--signal)"
          strokeWidth="1.6"
        />
        <circle r={0.9 * scale} fill="url(#radar-pool)" />
        {BLIPS.map(([angle, radius], i) => (
          <circle
            key={i}
            cx={Math.cos(angle) * radius * scale}
            cy={Math.sin(angle) * radius * scale}
            r={i % 2 ? 2.2 : 3}
            fill="var(--signal)"
            opacity={i === 3 ? 0.95 : 0.35}
          />
        ))}
      </g>
      <g transform="translate(-14 -88)" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path
          d="M14 14v62a14 14 0 0 1-28 0v-8"
          stroke="#f3f5fc"
          strokeWidth="9"
          transform="translate(14 0)"
        />
        <circle cx="28" cy="2" r="7" fill="var(--signal)" stroke="none" />
      </g>
    </svg>
  );
}
