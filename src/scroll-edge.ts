/** Marks the document once it has scrolled, so the sticky horizon bar can lift
 * off the page (see `polish.css`). Presentation only. */
export function watchScrollEdge(): () => void {
  if (typeof window === "undefined") return () => {};
  const root = document.documentElement;
  let frame = 0;
  const update = () => {
    frame = 0;
    const scrolled = window.scrollY > 4;
    if (scrolled) root.dataset.scrolled = "true";
    else delete root.dataset.scrolled;
  };
  const onScroll = () => {
    if (!frame) frame = requestAnimationFrame(update);
  };
  update();
  window.addEventListener("scroll", onScroll, { passive: true });
  return () => {
    window.removeEventListener("scroll", onScroll);
    if (frame) cancelAnimationFrame(frame);
    delete root.dataset.scrolled;
  };
}
