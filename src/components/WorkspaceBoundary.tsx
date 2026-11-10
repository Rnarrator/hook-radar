import { Component, Suspense } from "react";
import type { ReactNode } from "react";
import { Info, RefreshCw } from "./Icons";

interface BoundaryProps {
  label: string;
  children: ReactNode;
  /** A whole page, with the footer beneath it: its loading state is tall
   * enough that the footer is already below the screen, so it does not jump
   * into view when the page replaces it. */
  page?: boolean;
}

/** Contain a failed view while keeping navigation and browser preferences intact. */
export class RenderBoundary extends Component<
  BoundaryProps,
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <section className="workspace-state workspace-state-error" role="alert">
        <span className="workspace-state-icon" aria-hidden="true">
          <Info size={22} />
        </span>
        <h2>{this.props.label} couldn’t open</h2>
        <p>
          Reload this page to try again. Your browser-saved watchlist and
          filters are kept.
        </p>
        <button
          className="primary-button"
          type="button"
          onClick={() => location.reload()}
        >
          <RefreshCw size={16} /> Reload page
        </button>
      </section>
    );
  }
}

export function WorkspaceBoundary({ label, children, page }: BoundaryProps) {
  return (
    <RenderBoundary label={label}>
      <Suspense
        fallback={
          <section
            className="workspace-state"
            data-page={page ? "true" : undefined}
            role="status"
            aria-live="polite"
            aria-busy="true"
          >
            <span className="workspace-state-icon" aria-hidden="true">
              <RefreshCw size={22} />
            </span>
            <h2>Loading {label.toLowerCase()}…</h2>
            <p>Opening this view.</p>
          </section>
        }
      >
        {children}
      </Suspense>
    </RenderBoundary>
  );
}
