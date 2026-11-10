import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { Filters } from "../model";
import {
  decodeSavedFilters,
  defaultSavedFilterName,
  discoveryFilterSummary,
  encodeSavedFilters,
  MAX_SAVED_FILTER_NAME,
  MAX_SAVED_FILTERS,
  putSavedFilter,
  sameDiscoveryFilters,
  SAVED_FILTERS_KEY,
  type SavedFilterView,
} from "../discovery";
import { Check, ChevronDown, X } from "./Icons";

// Storage failures must not erase a user's changes when discovery remounts.
// This is tab-local memory only; reloads are explicitly disclosed as its limit.
let volatileViews: SavedFilterView[] | null = null;
function readViews() {
  if (typeof window === "undefined")
    return { views: [], notice: "", persistent: true };
  if (volatileViews)
    return {
      views: volatileViews,
      notice:
        "These saved filters are temporary until reload. Reload to reconnect browser storage.",
      persistent: false,
    };
  try {
    const result = decodeSavedFilters(
      window.localStorage.getItem(SAVED_FILTERS_KEY),
    );
    return {
      views: result.views,
      notice: result.corrupt
        ? "Some saved filters could not be read. You can save a new view."
        : "",
      persistent: true,
    };
  } catch {
    return {
      views: [],
      notice:
        "Browser storage is unavailable. Saved filters will last until this page is reloaded.",
      persistent: false,
    };
  }
}

/** True only in the static edition's build: the variable src/edition.ts reads
 * for STATIC_EDITION. It is read again here, not imported, because the tests
 * load this module on its own, where no other module can be resolved. */
const editionBuild = (() => {
  try {
    return import.meta.env.VITE_STATIC_EDITION === "1";
  } catch {
    return false;
  }
})();

/** The id of a new saved view: a version 4 UUID. crypto.randomUUID exists only
 * on a secure origin (https or localhost) and the static edition can be served
 * over plain http, so there it builds the same shape from random bytes
 * (getRandomValues works on any origin, Math.random is the last resort). The id
 * is only a local key, never a secret. The live page always asks randomUUID. */
export function newSavedFilterId(): string {
  const source = globalThis.crypto;
  if (!editionBuild || typeof source?.randomUUID === "function")
    return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof source?.getRandomValues === "function")
    source.getRandomValues(bytes);
  else
    for (let i = 0; i < bytes.length; i++)
      bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

/** Personal filter shortcuts; never imply a saved sort, timeframe or market estimate. */
export function SavedDiscoveryFilters({
  filters,
  onChoose,
  disabled = false,
}: {
  filters: Filters;
  onChoose: (filters: Partial<Filters>) => void;
  disabled?: boolean;
}) {
  const [initial] = useState(readViews);
  const [views, setViews] = useState<SavedFilterView[]>(initial.views);
  const [notice, setNotice] = useState(initial.notice);
  const [persistent, setPersistent] = useState(initial.persistent);
  const [position, setPosition] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const [open, setOpen] = useState(false);
  const [composing, setComposing] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState(() => defaultSavedFilterName(filters));
  const [error, setError] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLElement>(null);
  const id = useId();
  const matching = views.find((view) =>
    sameDiscoveryFilters(view.filters, filters),
  );
  const showForm = composing || editing !== null || views.length === 0;
  const editingView = views.find((view) => view.id === editing);

  useEffect(() => {
    const synchronize = (event: StorageEvent) => {
      if (event.key !== null && event.key !== SAVED_FILTERS_KEY) return;
      if (volatileViews) {
        setNotice(
          "Other tabs changed saved filters. This tab’s changes stay temporary until reload.",
        );
        return;
      }
      const next = decodeSavedFilters(
        event.key === null ? null : event.newValue,
      );
      if (next.corrupt) {
        setNotice(
          "Saved filters in browser storage could not be read. Keeping this tab’s saved filters.",
        );
        return;
      }
      setViews(next.views);
      setNotice("Saved filters updated in another tab.");
    };
    window.addEventListener("storage", synchronize);
    return () => window.removeEventListener("storage", synchronize);
  }, []);

  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      if (event.target instanceof Node && !root.current?.contains(event.target))
        setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      if (!trigger.current || !panel.current) return;
      const anchor = trigger.current.getBoundingClientRect();
      const bounds = panel.current.getBoundingClientRect();
      setPosition({
        left: Math.max(
          16,
          Math.min(
            anchor.right - bounds.width,
            window.innerWidth - bounds.width - 16,
          ),
        ),
        top: Math.max(
          16,
          Math.min(anchor.bottom + 8, window.innerHeight - bounds.height - 16),
        ),
      });
    };
    place();
    const resize = new ResizeObserver(place);
    if (panel.current) resize.observe(panel.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      resize.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  useEffect(() => {
    if (open && (composing || editing)) nameInput.current?.focus();
  }, [open, composing, editing]);

  const persist = (
    operation: (current: SavedFilterView[]) => {
      views: SavedFilterView[];
      error: string | null;
    },
    success: string,
  ) => {
    let current = volatileViews || views;
    let writable = volatileViews === null;
    if (writable)
      try {
        const latest = decodeSavedFilters(
          window.localStorage.getItem(SAVED_FILTERS_KEY),
        );
        if (!latest.corrupt) current = latest.views;
      } catch {
        writable = false;
      }
    const result = operation(current);
    if (result.error) {
      setViews(current);
      setError(result.error);
      nameInput.current?.focus();
      return null;
    }
    const next = result.views;
    setViews(next);
    if (!writable) {
      volatileViews = next;
      setPersistent(false);
      setNotice(
        `${success} This tab’s changes are temporary until reload. Browser-saved filters will not be overwritten.`,
      );
      return next;
    }
    try {
      window.localStorage.setItem(SAVED_FILTERS_KEY, encodeSavedFilters(next));
      volatileViews = null;
      setPersistent(true);
      setNotice(success);
    } catch {
      volatileViews = next;
      setPersistent(false);
      setNotice(
        `${success} Browser storage is unavailable; this change lasts until this page is reloaded.`,
      );
    }
    return next;
  };

  const resetForm = () => {
    setComposing(false);
    setEditing(null);
    setName(defaultSavedFilterName(filters));
    setError("");
  };

  return (
    <div
      className="discovery-saved"
      ref={root}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      <button
        type="button"
        className="saved-filters-trigger"
        ref={trigger}
        aria-label={`Saved filters${views.length ? ` · ${views.length} saved` : ""}`}
        aria-expanded={open}
        aria-controls={`${id}-panel`}
        onClick={() => {
          if (!open) {
            resetForm();
            setPosition(null);
          }
          setOpen(!open);
        }}
      >
        <span className="saved-filters-label-long">Saved filters</span>
        <span className="saved-filters-label-short">Saved</span>
        {views.length > 0 && (
          <span className="saved-filters-count">{views.length}</span>
        )}
        <ChevronDown size={13} />
      </button>
      {open && (
        <section
          className="saved-filters-panel"
          id={`${id}-panel`}
          ref={panel}
          aria-label="Saved filters"
          style={{
            top: position?.top ?? 16,
            left: position?.left ?? 16,
            visibility: position ? "visible" : "hidden",
          }}
        >
          <header>
            <div>
              <h3>Saved filters</h3>
              <p>Search, network, use case and hook features.</p>
            </div>
            <button
              type="button"
              className="icon-button"
              aria-label="Close saved filters"
              onClick={() => {
                setOpen(false);
                trigger.current?.focus();
              }}
            >
              <X size={15} />
            </button>
          </header>
          {views.length > 0 && (
            <ul className="saved-filter-list">
              {views.map((view) => {
                const active = sameDiscoveryFilters(view.filters, filters);
                return (
                  <li key={view.id}>
                    <button
                      type="button"
                      className="saved-filter-apply"
                      disabled={disabled}
                      aria-label={`Apply saved filters: ${view.name}`}
                      aria-current={active ? "true" : undefined}
                      onClick={() => {
                        onChoose({ ...view.filters });
                        setNotice(`${view.name} applied.`);
                        setOpen(false);
                        trigger.current?.focus();
                      }}
                    >
                      <span>
                        <strong>{view.name}</strong>
                        <small>
                          {discoveryFilterSummary(view.filters).join(" · ")}
                        </small>
                      </span>
                      {active && <Check size={15} />}
                    </button>
                    <div className="saved-filter-manage">
                      <button
                        type="button"
                        aria-label={`Rename saved filters: ${view.name}`}
                        onClick={() => {
                          setEditing(view.id);
                          setName(view.name);
                          setComposing(false);
                          setError("");
                        }}
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        aria-label={`Remove saved filters: ${view.name}`}
                        onClick={() => {
                          const next = persist(
                            (current) => ({
                              views: current.filter(
                                (item) => item.id !== view.id,
                              ),
                              error: null,
                            }),
                            `${view.name} removed.`,
                          );
                          if (!next) return;
                          if (editing === view.id) resetForm();
                          if (!next.length) {
                            setComposing(true);
                            setName(defaultSavedFilterName(filters));
                          } else trigger.current?.focus();
                        }}
                      >
                        Remove
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {disabled && (
            <p className="saved-filter-note">
              Saved filters can be applied after data verification finishes.
            </p>
          )}
          {showForm ? (
            <form
              className="saved-filter-form"
              onSubmit={(event) => {
                event.preventDefault();
                const next = persist(
                  (current) =>
                    putSavedFilter(current, {
                      id: editing || newSavedFilterId(),
                      name,
                      filters: editingView?.filters || filters,
                      ...(editing ? { replaceId: editing } : {}),
                    }),
                  editing ? "Saved filter renamed." : "Filters saved.",
                );
                if (!next) return;
                resetForm();
                trigger.current?.focus();
              }}
            >
              <label htmlFor={`${id}-name`}>
                {editing ? "Rename saved filters" : "Save current filters"}
              </label>
              {!editing && (
                <p className="saved-filter-scope">
                  {discoveryFilterSummary(filters).join(" · ")}
                </p>
              )}
              <input
                id={`${id}-name`}
                ref={nameInput}
                value={name}
                maxLength={MAX_SAVED_FILTER_NAME}
                autoComplete="off"
                placeholder="Name this view"
                aria-invalid={Boolean(error)}
                aria-describedby={error ? `${id}-error` : undefined}
                onChange={(event) => {
                  setName(event.target.value);
                  setError("");
                }}
              />
              {error && (
                <p
                  id={`${id}-error`}
                  className="saved-filter-error"
                  role="alert"
                >
                  {error}
                </p>
              )}
              <div className="saved-filter-form-actions">
                <button
                  type="submit"
                  className="control primary"
                  disabled={disabled && !editing}
                >
                  {editing ? "Save name" : "Save filters"}
                </button>
                {(composing || editing) && (
                  <button
                    type="button"
                    className="control"
                    onClick={() => {
                      resetForm();
                      trigger.current?.focus();
                      if (!views.length) {
                        setOpen(false);
                      }
                    }}
                  >
                    Cancel
                  </button>
                )}
                <small>
                  {views.length} / {MAX_SAVED_FILTERS} saved
                </small>
              </div>
            </form>
          ) : (
            <button
              type="button"
              className="saved-filter-create control"
              disabled={
                disabled ||
                views.length >= MAX_SAVED_FILTERS ||
                Boolean(matching)
              }
              title={
                matching
                  ? "These filters are already saved."
                  : views.length >= MAX_SAVED_FILTERS
                    ? "Remove a saved filter to add another."
                    : undefined
              }
              onClick={() => {
                setComposing(true);
                setEditing(null);
                setName(defaultSavedFilterName(filters));
                setError("");
              }}
            >
              {matching
                ? "Current filters are saved"
                : views.length >= MAX_SAVED_FILTERS
                  ? "Eight filter views saved"
                  : "Save current filters"}
            </button>
          )}
          <p className="saved-filter-storage">
            {persistent
              ? "Stored in this browser."
              : "Available until this page is reloaded."}{" "}
            Sort and timeframe are unchanged.
          </p>
          {notice && (
            <p
              className="saved-filter-feedback"
              role="status"
              aria-live="polite"
            >
              {notice}
            </p>
          )}
        </section>
      )}
      {!open && notice && (
        <span className="sr-only" role="status" aria-live="polite">
          {notice}
        </span>
      )}
    </div>
  );
}
