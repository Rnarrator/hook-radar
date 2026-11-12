import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { CSSProperties } from "react";

/** Keeps a region from changing height while a control is pressed, or while its
 * figures are on their way.
 *
 * The height the element had the last time it was NOT holding is remembered
 * (after every render, and whenever the element is resized, which also covers a
 * figure that is fitted a moment after it is drawn); while `holding` is true the
 * element is given that as its minimum height. So a figure that is loading, or a
 * line that is a line shorter while a span is chosen, does not pull the page
 * below it upwards, and the minimum is released the moment the region is not
 * held. Nothing is held when no height was ever seen (a link that opens on the
 * span), and a change of the window's width forgets the remembered height: the
 * region is then its own natural height until it is seen again.
 *
 * With `width` the element also keeps the width it had (a line of text that is
 * shorter while its figures load would otherwise fit on a row it did not share
 * before, and the rows below it would move).
 *
 * With `floorKey` the element is also never shorter than the tallest it has been
 * under that key, at the width it has now, even when it is not holding. It is for
 * a region whose figures change when a span is chosen and whose own height
 * follows them (a legend that wraps onto one line less when it lists fewer
 * entries): pressing 7D, 30D or 24H then leaves everything below where it was,
 * in whatever order the spans are chosen. The key names what the region shows
 * apart from the span (the network, the metric, the snapshot), so a region that
 * really is another one starts from its own height. The floor is forgotten when
 * the element's width changes (the window is resized, a phone is turned), and
 * with it the minimum, so a wider window is not left with a gap. A region first
 * seen under a span has no floor until it has been seen without one: it is the
 * height of what it shows. With no `floorKey` nothing is remembered and nothing
 * changes.
 *
 * `ref` is a callback ref: one observer follows the element for as long as it
 * is mounted, and nothing is re-created on a render. */
export function useHeldHeight<T extends HTMLElement>(
  holding: boolean,
  width = false,
  floorKey: string | null = null,
): { ref: (element: T | null) => void; style: CSSProperties | undefined } {
  const element = useRef<T | null>(null);
  const last = useRef<number | null>(null);
  const lastWidth = useRef<number | null>(null);
  const holdingNow = useRef(holding);
  holdingNow.current = holding;
  const floorKeyNow = useRef(floorKey);
  floorKeyNow.current = floorKey;
  // The tallest height seen for each key, all measured at one width.
  const floors = useRef<{ width: number; heights: Map<string, number> } | null>(
    null,
  );
  const [, redraw] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  const remember = useCallback(() => {
    if (!element.current) return;
    const box = element.current.getBoundingClientRect();
    if (!holdingNow.current) {
      last.current = box.height;
      lastWidth.current = box.width;
    }
    const key = floorKeyNow.current;
    if (key === null) return;
    let seen = floors.current;
    if (seen && Math.abs(seen.width - box.width) > 0.5) {
      // Measured at another width, and the minimum made from it is still on the
      // element: let both go and measure the natural height on the next render.
      floors.current = null;
      redraw((count) => count + 1);
      return;
    }
    if (!seen) seen = floors.current = { width: box.width, heights: new Map() };
    const known = seen.heights.get(key);
    // While held, the box is the held height, not what the region shows.
    if (known === undefined) {
      if (!holdingNow.current) seen.heights.set(key, box.height);
    } else if (box.height > known) seen.heights.set(key, box.height);
  }, []);
  const ref = useCallback(
    (next: T | null) => {
      observer.current?.disconnect();
      observer.current = null;
      element.current = next;
      if (next && typeof ResizeObserver !== "undefined") {
        observer.current = new ResizeObserver(remember);
        observer.current.observe(next);
      }
    },
    [remember],
  );
  useLayoutEffect(remember);
  useEffect(() => {
    let width = window.innerWidth;
    const resized = () => {
      if (window.innerWidth === width) return;
      width = window.innerWidth;
      // The remembered height was made at another width.
      if (holdingNow.current) {
        last.current = null;
        lastWidth.current = null;
      } else remember();
    };
    window.addEventListener("resize", resized);
    return () => window.removeEventListener("resize", resized);
  }, [remember]);
  const held = holding && last.current !== null && last.current > 0;
  const floor =
    floorKey === null ? undefined : floors.current?.heights.get(floorKey);
  const minHeight = Math.max(
    held ? (last.current ?? 0) : 0,
    floor !== undefined && floor > 0 ? floor : 0,
  );
  return {
    ref,
    style:
      minHeight > 0 || (held && width && lastWidth.current !== null)
        ? {
            // No transition: a visitor who asked for less motion still has a
            // 0.01 ms one, and the first frame would show the block at its own
            // height before the minimum.
            ...(minHeight > 0 ? { minHeight, transition: "none" } : {}),
            ...(held && width && lastWidth.current !== null
              ? { minWidth: lastWidth.current }
              : {}),
          }
        : undefined,
  };
}
