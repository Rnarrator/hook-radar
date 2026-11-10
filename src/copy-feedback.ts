/** A brief "copied" cue on the button that was just used: its colour turns to
 * the healthy accent for a moment (see `polish.css`). The toast still carries
 * the message; this only confirms which control did it. */
const FLASH_MS = 1400;
const timers = new WeakMap<Element, number>();

export function flashCopied(source: Element | null) {
  const button = source?.closest("button, a");
  if (!button) return;
  // Only a control that says it copies: after a palette command or a share
  // dialog, focus can sit on an unrelated control that did not do this.
  const name = (
    button.getAttribute("aria-label") ??
    button.textContent ??
    ""
  ).trim();
  if (!/^copy\b/i.test(name)) return;
  button.setAttribute("data-copied", "true");
  window.clearTimeout(timers.get(button));
  timers.set(
    button,
    window.setTimeout(() => button.removeAttribute("data-copied"), FLASH_MS),
  );
}
