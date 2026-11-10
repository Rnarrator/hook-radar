/** A soft key light that follows the pointer across instrument surfaces.
 *
 * Only a fine, hovering pointer drives it and nothing runs for reduced motion.
 * It sets two custom properties on the surface under the pointer; the light
 * itself is drawn by CSS (`polish.css`) and sits at rest when the pointer
 * leaves. Nothing here reads or changes data. */
const SURFACES =
  ".plate, .hook-spotlight, .eco-region, .learn-decoder-plate, .learn-flow-plate";

export function startPointerLight(): () => void {
  if (
    typeof window === "undefined" ||
    !window.matchMedia("(hover: hover) and (pointer: fine)").matches ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  )
    return () => {};
  let frame = 0;
  let surface: HTMLElement | null = null;
  let x = 0;
  let y = 0;
  const paint = () => {
    frame = 0;
    if (!surface?.isConnected) return;
    const box = surface.getBoundingClientRect();
    surface.style.setProperty("--mx", `${Math.round(x - box.left)}px`);
    surface.style.setProperty("--my", `${Math.round(y - box.top)}px`);
  };
  const move = (event: PointerEvent) => {
    if (event.pointerType !== "mouse") return;
    const next =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>(SURFACES)
        : null;
    surface = next;
    if (!next) return;
    x = event.clientX;
    y = event.clientY;
    if (!frame) frame = requestAnimationFrame(paint);
  };
  document.addEventListener("pointermove", move, { passive: true });
  return () => {
    document.removeEventListener("pointermove", move);
    if (frame) cancelAnimationFrame(frame);
  };
}
