/** Keeps a key figure on one line.
 *
 * The pixel face is wide, and a figure such as "$361.86M" or "15,890,773" can
 * be longer than its column on a phone. When a figure would not fit, it is
 * scaled down just enough (never below FLOOR, and never so small that it would render under 11px; past that it wraps as before).
 * The text, its value and its accessible name are untouched: this only sets
 * `data-fit`, a `--fit` ratio and a smaller inline `font-size`. */

// Every place the pixel face carries a number.
const SELECTOR = [
  ".readout-value",
  ".metric-value",
  ".masthead-figures dd:not(.masthead-note)",
  ".analytics-workspace .analytics-metric > strong",
  ".analytics-footprint-summary strong",
  ".contrib-focus-readout strong",
  ".history-selected-value > strong",
  ".chains-summary strong",
  ".chain-evidence-readout strong",
  ".chain-pool-headline strong",
  ".chain-chart-evidence dd",
  ".coverage-index-totals strong",
  ".market-fresh-pricing dd strong",
  ".observation-readout strong",
  ".activity-fee-summary > strong",
  ".activity-liquidity dd",
  ".methodology-stats strong",
  ".comparison-figure",
  ".comparison-amount",
  ".eco-region-count",
].join(", ");
const FLOOR = 0.6;
/** The pixel face is drawn at about 0.56em; keep what it renders at readable. */
const GLYPH_EM = 0.56;
const MIN_RENDERED_PX = 11;
/** At most one pass per this many milliseconds during a burst of changes. */
const MIN_GAP = 100;

/** Two passes over all figures, so the layout is read twice however many there
 * are: the width each is given in its normal state, then the width its text
 * needs on one line. (A figure's own box is no measure of that: in a grid or
 * flex row, text that cannot wrap makes its column grow.) */
function fitAll(figures: HTMLElement[]) {
  for (const figure of figures) {
    // Reduced motion gives every element a near-zero transition, and a running
    // transition keeps computed values one frame behind: measure without it.
    figure.style.transitionProperty = "none";
    delete figure.dataset.fit;
    figure.style.removeProperty("--fit");
    figure.style.removeProperty("font-size");
  }
  const available = figures.map(
    (figure) => figure.clientWidth || figure.parentElement?.clientWidth || 0,
  );
  const base = figures.map((figure) =>
    Number.parseFloat(getComputedStyle(figure).fontSize),
  );
  for (const figure of figures) figure.dataset.fit = "measure";
  const natural = figures.map((figure) =>
    Math.max(figure.scrollWidth, Math.ceil(figure.getBoundingClientRect().width)),
  );
  figures.forEach((figure, index) => {
    const room = available[index];
    const need = natural[index];
    if (room > 0 && need > room + 1) {
      const ratio = Math.floor((room / need) * 100) / 100;
      // Never below the ratio floor, and never so small that the pixel face
      // would render under MIN_RENDERED_PX: past either limit the figure wraps.
      const floor = Math.max(FLOOR, MIN_RENDERED_PX / (base[index] * GLYPH_EM));
      if (base[index] > 0 && ratio >= floor) {
        figure.style.setProperty("--fit", String(ratio));
        figure.style.fontSize = `${(base[index] * ratio).toFixed(2)}px`;
        figure.dataset.fit = "shrink";
        return;
      }
    }
    delete figure.dataset.fit;
  });
}

export function startFigureFit(): () => void {
  if (
    typeof window === "undefined" ||
    !("MutationObserver" in window) ||
    !("ResizeObserver" in window)
  )
    return () => {};
  let frame = 0;
  let timer = 0;
  let last = -Infinity;
  // A column can change width with no DOM change (data arrives, a scrollbar
  // appears, a panel opens), so the containers are watched as well.
  const resized = new ResizeObserver(() => schedule());
  const watched = new Set<Element>();
  const run = () => {
    frame = 0;
    last = performance.now();
    const figures = [...document.querySelectorAll<HTMLElement>(SELECTOR)];
    fitAll(figures);
    // Observe each container once: a fresh observation reports once, which
    // schedules one more (idempotent) pass and then settles.
    for (const parent of watched)
      if (!parent.isConnected) {
        resized.unobserve(parent);
        watched.delete(parent);
      }
    figures.forEach((figure) => {
      const parent = figure.parentElement;
      if (parent && !watched.has(parent)) {
        watched.add(parent);
        resized.observe(parent);
      }
    });
  };
  function schedule() {
    if (frame || timer) return;
    const wait = MIN_GAP - (performance.now() - last);
    if (wait <= 0) frame = requestAnimationFrame(run);
    else
      timer = window.setTimeout(() => {
        timer = 0;
        frame = requestAnimationFrame(run);
      }, wait);
  }
  // Only content changes matter: attribute writes made here must not retrigger.
  const mutations = new MutationObserver(schedule);
  mutations.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  window.addEventListener("resize", schedule);
  void document.fonts?.ready.then(schedule);
  // A font that arrives later changes every figure's width without a DOM change.
  document.fonts?.addEventListener("loadingdone", schedule);
  schedule();
  return () => {
    mutations.disconnect();
    resized.disconnect();
    window.removeEventListener("resize", schedule);
    document.fonts?.removeEventListener("loadingdone", schedule);
    if (frame) cancelAnimationFrame(frame);
    if (timer) clearTimeout(timer);
  };
}
