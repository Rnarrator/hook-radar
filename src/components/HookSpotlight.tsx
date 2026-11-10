import { useEffect, useId, useRef, useState } from "react";
import type { RadarSnapshot } from "../../shared/types";
import type { SpotlightEntry } from "../spotlight";
import { ArrowRight, ChevronLeft, ChevronRight, Pause, Play } from "./Icons";
import { ProtocolLogo } from "./ProtocolLogo";
import "./spotlight.css";

const ROTATION_MS = 10_000;
const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** A scoped editorial carousel. Its selection never changes directory ranking. */
export function HookSpotlight({
  entries,
  chains,
  openProject,
  suspended = false,
}: {
  entries: readonly SpotlightEntry[];
  chains: RadarSnapshot["chains"];
  openProject: (id: string) => void;
  suspended?: boolean;
}) {
  const root = useRef<HTMLElement>(null);
  const storyId = useId();
  const [activeId, setActiveId] = useState(entries[0]?.project.id || "");
  const [paused, setPaused] = useState(prefersReducedMotion);
  const [reducedMotion, setReducedMotion] = useState(prefersReducedMotion);
  const [hovered, setHovered] = useState(false);
  const [visible, setVisible] = useState(true);
  const [pageVisible, setPageVisible] = useState(
    () => typeof document === "undefined" || !document.hidden,
  );
  const [announcement, setAnnouncement] = useState("");
  const deckKey = entries.map((entry) => entry.project.id).join(",");
  const index = Math.max(
    0,
    entries.findIndex((entry) => entry.project.id === activeId),
  );
  const entry = entries[index];
  const rotating =
    entries.length > 1 &&
    !paused &&
    !hovered &&
    visible &&
    pageVisible &&
    !suspended;

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => {
      setReducedMotion(media.matches);
      if (media.matches) setPaused(true);
    };
    media.addEventListener("change", change);
    const visibility = () => setPageVisible(!document.hidden);
    document.addEventListener("visibilitychange", visibility);
    const observer = new IntersectionObserver(([record]) =>
      setVisible(record.isIntersecting),
    );
    if (root.current) observer.observe(root.current);
    return () => {
      media.removeEventListener("change", change);
      document.removeEventListener("visibilitychange", visibility);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!rotating) return;
    const nextId = entries[(index + 1) % entries.length]?.project.id;
    const timer = window.setTimeout(() => {
      if (nextId) setActiveId(nextId);
    }, ROTATION_MS);
    return () => clearTimeout(timer);
    // Polling may replace project objects; only a changed deck or selection restarts rotation.
  }, [deckKey, entry?.project.id, rotating]);

  useEffect(() => {
    setAnnouncement("");
  }, [deckKey]);

  const move = (direction: number) => {
    const nextIndex = (index + direction + entries.length) % entries.length;
    const next = entries[nextIndex];
    if (!next) return;
    setPaused(true);
    setActiveId(next.project.id);
    setAnnouncement(
      `${nextIndex + 1} of ${entries.length}: ${next.project.name}`,
    );
  };

  if (!entry) return null;
  const { project } = entry;
  const network =
    project.chains.length === 1
      ? chains.find((chain) => chain.slug === project.chains[0])?.name ||
        project.chains[0]
      : `${project.chains.length} networks`;

  return (
    <aside
      ref={root}
      className="hook-spotlight browse-spotlight"
      aria-label="Hook spotlight"
      aria-roledescription="carousel"
      aria-description="Rotating editorial selection from projects matching your filters, independent of directory ranking"
      data-testid="hook-spotlight"
      data-project-id={project.id}
      data-count={entries.length}
      data-angle={entry.angle}
      data-rotation={rotating ? "playing" : "paused"}
      data-reduced-motion={reducedMotion}
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse" || event.pointerType === "pen")
          setHovered(true);
      }}
      onPointerMove={(event) => {
        const node = root.current;
        if (
          !node ||
          reducedMotion ||
          (event.pointerType !== "mouse" && event.pointerType !== "pen")
        )
          return;
        const box = node.getBoundingClientRect();
        const x = (event.clientX - box.left) / box.width - 0.5;
        const y = (event.clientY - box.top) / box.height - 0.5;
        node.style.setProperty("--ry", `${(x * 7).toFixed(2)}deg`);
        node.style.setProperty("--rx", `${(-y * 5).toFixed(2)}deg`);
      }}
      onPointerLeave={() => {
        setHovered(false);
        root.current?.style.setProperty("--rx", "0deg");
        root.current?.style.setProperty("--ry", "0deg");
      }}
      onFocusCapture={(event) => {
        // The playback control must retain its explicit Pause/Resume action on click.
        if ((event.target as HTMLElement).closest(".spotlight-playback"))
          return;
        setPaused(true);
      }}
    >
      <div className="spotlight-topline">
        <span className="spotlight-label">Spotlight</span>
        <span className="spotlight-angle">{entry.label}</span>
        <span className="spotlight-note">
          Featured projects · rotating, not a ranking
        </span>
        <span className="spotlight-note-short">Not a ranking</span>
        {entries.length > 1 && (
          <span className="spotlight-position" aria-hidden="true">
            {String(index + 1).padStart(2, "0")}
            <span> / {String(entries.length).padStart(2, "0")}</span>
          </span>
        )}
      </div>
      <button
        type="button"
        className="spotlight-open"
        aria-label={`View project: ${project.name}`}
        aria-describedby={storyId}
        onClick={() => openProject(project.id)}
      >
        <span className="spotlight-identity">
          <ProtocolLogo key={project.id} project={project} eager />
          <span>
            <strong title={project.name}>{project.name}</strong>
          </span>
        </span>
        <span className="spotlight-story" key={project.id}>
          <span
            id={storyId}
            className="spotlight-purpose"
            title={project.description}
          >
            {entry.summary}
          </span>
        </span>
        <span className="spotlight-explore">
          Explore project <ArrowRight size={14} />
        </span>
      </button>
      <div className="spotlight-bottomline">
        <div className="spotlight-facts">
          {entry.facts.slice(0, 2).map((fact) => (
            <span
              key={fact.label}
              title={/^networks?$/.test(fact.label) ? network : undefined}
            >
              <strong>{fact.value}</strong> {fact.label}
            </span>
          ))}
        </div>
        {entries.length > 1 && (
          <div
            className="spotlight-controls"
            role="group"
            aria-label="Spotlight controls"
          >
            <button
              type="button"
              aria-label={paused ? "Resume spotlight" : "Pause spotlight"}
              onClick={() => setPaused((value) => !value)}
              className="spotlight-playback"
            >
              {paused ? <Play size={14} /> : <Pause size={14} />}
              {paused ? "Resume" : "Pause"}
            </button>
            <button
              type="button"
              aria-label="Previous spotlight"
              onClick={() => move(-1)}
            >
              <ChevronLeft size={15} />
            </button>
            <button
              type="button"
              aria-label="Next spotlight"
              onClick={() => move(1)}
            >
              <ChevronRight size={15} />
            </button>
          </div>
        )}
      </div>
      {entries.length > 1 && (
        <div className="spotlight-rail" aria-hidden="true">
          {entries.map((item, position) => (
            <span key={item.project.id} data-active={position === index} />
          ))}
        </div>
      )}
      <span
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {announcement}
      </span>
    </aside>
  );
}

/** Holds the spotlight's footprint while the analytics snapshot loads. */
export function SpotlightPlaceholder() {
  return (
    <aside
      className="hook-spotlight spotlight-placeholder"
      aria-hidden="true"
    >
      <div className="spotlight-topline">
        <span className="spotlight-label">Spotlight</span>
      </div>
      <div style={{ display: "flex", gap: "1.5rem", alignItems: "center" }}>
        <span
          className="skeleton"
          style={{ width: "4.5rem", height: "4.5rem", borderRadius: 16 }}
        />
        <span style={{ flex: 1, display: "grid", gap: "0.6rem" }}>
          <span className="skeleton" style={{ width: "40%", height: "1.75rem" }} />
          <span className="skeleton" style={{ width: "75%", height: "1rem" }} />
        </span>
      </div>
    </aside>
  );
}
