import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, RefObject } from "react";

/** Width of an element, tracked with ResizeObserver. Charts lay out in real
 * pixels so labels never scale with the viewBox. */
export function useElementWidth<T extends HTMLElement>(
  fallback = 640,
  minimum = 220,
): [RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () =>
      setWidth(Math.max(minimum, Math.round(element.clientWidth)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [minimum]);
  return [ref, width];
}

/** True when the primary pointer is coarse (touch). Tooltips then become
 * tap-to-pin panels instead of hover popovers. */
export function useCoarsePointer(): boolean {
  const query = "(hover: none), (pointer: coarse)";
  const [coarse, setCoarse] = useState(
    () => typeof matchMedia === "function" && matchMedia(query).matches,
  );
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const list = matchMedia(query);
    const update = () => setCoarse(list.matches);
    list.addEventListener("change", update);
    return () => list.removeEventListener("change", update);
  }, []);
  return coarse;
}

/** Keyboard inspection over an ordered set of `count` items: arrows step,
 * PageUp/PageDown jump 10, Home/End go to the ends, Escape clears. Returns a
 * keydown handler for the focusable plot element. */
export function inspectionKeyHandler({
  count,
  index,
  onSelect,
  onClear,
  disabled = false,
}: {
  count: number;
  index: number;
  onSelect: (index: number) => void;
  onClear?: () => void;
  disabled?: boolean;
}) {
  return (event: KeyboardEvent<Element>) => {
    if (disabled || count <= 0) return;
    const moves: Record<string, number> = {
      ArrowLeft: -1,
      ArrowDown: -1,
      ArrowRight: 1,
      ArrowUp: 1,
      PageUp: 10,
      PageDown: -10,
    };
    let next: number | null = null;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = count - 1;
    else if (event.key in moves)
      next = Math.max(0, Math.min(count - 1, index + moves[event.key]));
    else if (event.key === "Escape" && onClear) {
      event.preventDefault();
      onClear();
      return;
    }
    if (next === null) return;
    event.preventDefault();
    onSelect(next);
  };
}
