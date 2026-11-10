import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { safeUrl } from "../model";
import { EmptyInstrument, ExternalLink, X } from "./Icons";
export function External({
  href,
  children,
  className = "",
}: {
  href: string | null | undefined;
  children: ReactNode;
  className?: string;
}) {
  const url = safeUrl(href);
  return url ? (
    <a
      className={`external ${className}`}
      href={url}
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
      <ExternalLink size={13} />
    </a>
  ) : null;
}
export function Empty({
  title,
  children,
  action,
  icon,
  headingLevel = 3,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  /** Use 2 when the empty state sits directly under the page's h1. */
  headingLevel?: 2 | 3;
}) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <div className="empty-state">
      {icon ?? <EmptyInstrument />}
      <Heading>{title}</Heading>
      <p>{children}</p>
      {action}
    </div>
  );
}

export function Modal({
  title,
  children,
  onClose,
  drawer = false,
  variant,
  initialFocus,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  drawer?: boolean;
  /** "palette": a top-anchored, chrome-less dialog whose own field takes focus. */
  variant?: "palette";
  /** Selector for the element that takes focus first (default: the first button). */
  initialFocus?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // The latest close handler, without re-running the focus effect when a parent
  // passes a new function on every render (that would bounce focus out and in).
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const scroll = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const dialog = ref.current!;
    const background = document.querySelector(
      ".application-shell",
    ) as HTMLElement | null;
    if (background) background.inert = true;
    dialog.querySelector<HTMLElement>(initialFocus || "button")?.focus();
    const listener = (event: KeyboardEvent) => {
      // Escape during text composition cancels the composition, not the dialog.
      if (event.key === "Escape" && !event.isComposing) {
        event.preventDefault();
        closeRef.current();
      }
      if (event.key === "Tab") {
        const list = [
          ...dialog.querySelectorAll<HTMLElement>(
            'button, a[href], input, select, textarea, summary, [tabindex="0"]',
          ),
        ].filter((element) => {
          // Content of a closed <details> is not focusable; only its summary is.
          const closed = element.closest("details:not([open])");
          return (
            element.tabIndex >= 0 &&
            !element.hasAttribute("disabled") &&
            element.getClientRects().length > 0 &&
            (!closed ||
              (element.tagName === "SUMMARY" && element.parentElement === closed))
          );
        });
        if (!list.length) {
          event.preventDefault();
          return;
        }
        if (
          event.shiftKey &&
          (document.activeElement === list[0] ||
            !dialog.contains(document.activeElement))
        ) {
          event.preventDefault();
          list.at(-1)?.focus();
        } else if (
          !event.shiftKey &&
          (document.activeElement === list.at(-1) ||
            !dialog.contains(document.activeElement))
        ) {
          event.preventDefault();
          list[0].focus();
        }
      }
    };
    document.addEventListener("keydown", listener);
    return () => {
      document.body.style.overflow = scroll;
      if (background) background.inert = false;
      document.removeEventListener("keydown", listener);
      if (
        previous?.isConnected &&
        previous !== document.body &&
        previous !== document.documentElement &&
        previous.getClientRects().length > 0 &&
        !previous.closest("[inert], :disabled")
      ) {
        previous.focus();
        if (document.activeElement === previous) return;
      }
      // A watched row can disappear or a responsive layout can hide the opener.
      // Return to a persistent navigation anchor instead of the document body.
      const target =
        document.querySelector<HTMLElement>(
          '.application-shell nav [aria-current="page"]',
        ) || document.querySelector<HTMLElement>("#main h1");
      if (target) {
        const temporaryTabIndex =
          !target.hasAttribute("tabindex") && target.tabIndex < 0;
        if (temporaryTabIndex) target.tabIndex = -1;
        target.focus({ preventScroll: true });
        if (temporaryTabIndex)
          target.addEventListener(
            "blur",
            () => target.removeAttribute("tabindex"),
            { once: true },
          );
      }
    };
  }, [initialFocus]);
  return (
    <div
      className={`overlay ${drawer ? "drawer-overlay" : ""} ${variant === "palette" ? "palette-overlay" : ""}`.trim()}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid={
          variant === "palette"
            ? "command-palette"
            : drawer
              ? "project-drawer"
              : title === "Data & sources"
                ? "sources-modal"
                : "share-modal"
        }
        className={
          variant === "palette" ? "modal palette" : drawer ? "drawer" : "modal"
        }
      >
        {variant !== "palette" && (
          <div className="modal-chrome">
            <span>
              <span className="pixel-square" />
              {title}
            </span>
            <button
              className="icon-button"
              aria-label="Close panel"
              onClick={onClose}
            >
              <X size={19} />
            </button>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
