import { useSyncExternalStore } from "react";

/** Whether a CSS media query currently matches, kept in step with the window.
 * Used where two layouts exist and rendering both would double the work. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      if (typeof matchMedia !== "function") return () => undefined;
      const list = matchMedia(query);
      list.addEventListener("change", notify);
      return () => list.removeEventListener("change", notify);
    },
    () => typeof matchMedia === "function" && matchMedia(query).matches,
    () => false,
  );
}
