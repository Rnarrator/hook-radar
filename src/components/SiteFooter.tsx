import { inlineTime } from "../model";
import { STATIC_EDITION, fullTimeLabel } from "../edition";
import { External } from "./Primitives";
import { SourceCredit } from "./EditionStatus";
import { paletteShortcutLabel } from "./CommandPalette";

/** Provenance and the way to suggest a hook, on every Discover-style page. */
export function SiteFooter({
  updatedAt,
  sources,
  onSources,
  onJump,
  onShortcuts,
}: {
  /** Omit (undefined) on pages that load no snapshot, such as the guide. */
  updatedAt?: string | null;
  /** Edition: the sources the snapshot on the page names; the credit line is
   * built from them. Omit on pages that load no snapshot (nothing is credited). */
  sources?: readonly { id?: unknown; status?: unknown }[] | null;
  onSources: () => void;
  /** Opens the jump palette: the way in where the header has no room for its button. */
  onJump?: () => void;
  /** Opens the keyboard shortcut list. Shown where there is a keyboard. */
  onShortcuts?: () => void;
}) {
  return (
    <footer className="footer">
      <span>
        {updatedAt !== undefined && (
          <>
            <span className="status-led" />
            {updatedAt
              ? STATIC_EDITION
                ? `Snapshot taken ${fullTimeLabel(updatedAt) ?? "at an unknown time"}`
                : `Snapshot updated ${inlineTime(updatedAt)}`
              : "Snapshot time unavailable"}
          </>
        )}
        <span className="footer-version">RADAR / V1.0</span>
      </span>
      <div>
        {onJump && (
          <button className="footer-jump" onClick={onJump}>
            Jump to <kbd aria-hidden="true">{paletteShortcutLabel()}</kbd>
          </button>
        )}
        {onShortcuts && (
          <button className="footer-shortcuts" onClick={onShortcuts}>
            Shortcuts <kbd aria-hidden="true">?</kbd>
          </button>
        )}
        <button onClick={onSources}>Data & sources</button>
        <External href="https://github.com/Uniswap/hooklist">
          Suggest a hook
        </External>
      </div>
      {STATIC_EDITION && <SourceCredit sources={sources} />}
      {STATIC_EDITION && (
        <p
          className="footer-credit footer-notices"
          data-testid="third-party-notices"
        >
          Protocol logos belong to their owners.{" "}
          {/* A root-absolute literal: the edition build makes it relative to
              where the site is served from (editionAssetPaths). */}
          <a
            href="/third-party-notices.txt"
            target="_blank"
            rel="noopener noreferrer"
          >
            Third-party notices
          </a>
        </p>
      )}
    </footer>
  );
}
