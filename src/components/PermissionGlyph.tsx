import { HOOK_CALLBACKS, hookCallback } from "../hook-permissions";
import "./permission-glyph.css";

/** Two rows by eight columns, read as before (top) and after (bottom) for each
 * pool operation, then the four returns-delta flags as round cells. The two
 * liquidity deltas exist only as "after" flags, so their "before" cell is empty
 * rather than misreading the flag as a "before" one. */
const COLUMNS: readonly (readonly [string | null, string])[] = [
  ["beforeInitialize", "afterInitialize"],
  ["beforeAddLiquidity", "afterAddLiquidity"],
  ["beforeRemoveLiquidity", "afterRemoveLiquidity"],
  ["beforeSwap", "afterSwap"],
  ["beforeDonate", "afterDonate"],
  ["beforeSwapReturnsDelta", "afterSwapReturnsDelta"],
  [null, "afterAddLiquidityReturnsDelta"],
  [null, "afterRemoveLiquidityReturnsDelta"],
];
const COLUMN_LABELS = ["Init", "Add", "Remove", "Swap", "Donate", "Δ swap", "Δ add", "Δ rem."];
const FIRST_DELTA_COLUMN = 5;
const kindOf = new Map(HOOK_CALLBACKS.map((item) => [item.name, item.kind]));

type Flags = Readonly<Record<string, boolean | undefined>>;
/** Per callback, the share (0 to 1) of a project's classified hooks that enable
 * it; null or missing means no hook reports it. */
type Shares = Readonly<Record<string, number | null | undefined>>;

type CellState = "on" | "off" | "unknown" | "partial";

function cellState(
  name: string,
  flags: Flags,
  shares: Shares | undefined,
): { state: CellState; share?: number } {
  if (shares) {
    const share = shares[name];
    if (typeof share !== "number") return { state: "unknown" };
    if (share <= 0) return { state: "off", share: 0 };
    if (share >= 1) return { state: "on", share: 1 };
    return { state: "partial", share };
  }
  const value = flags[name];
  return typeof value !== "boolean"
    ? { state: "unknown" }
    : { state: value ? "on" : "off" };
}

/** A share as a percentage that never reads as 0 or 100 while some hooks differ. */
function sharePhrase(share: number): string {
  const percent = share * 100;
  if (percent < 1) return "under 1%";
  if (percent > 99) return "over 99%";
  return `${Math.round(percent)}%`;
}

/** Drawn level of a partly filled cell: a sliver or a nearly full cell would
 * read as empty or full, so the level stays inside 25 to 75 percent. The true
 * share is in the cell's title and the accessible name. */
export function drawnShare(share: number): number {
  return Math.min(0.75, Math.max(0.25, share));
}

/** Hover text for one cell: which callback it is, and its state. */
function cellTitle(name: string, { state, share }: ReturnType<typeof cellState>, grouped: boolean) {
  if (state === "unknown") return `${name}: not reported`;
  if (state === "off") return `${name}: not enabled`;
  const summary = hookCallback(name)?.summary ?? "";
  if (state === "partial")
    return `${name}: enabled by ${sharePhrase(share ?? 0)} of the hooks that report it. ${summary}`.trim();
  return `${name}: enabled${grouped ? " by every hook that reports it" : ""}. ${summary}`.trim();
}

/** The fourteen permission flags of a hook as a small fingerprint.
 *
 * A filled cell is a callback the hook's address enables, an empty cell one it
 * does not, and a dashed cell one the source did not report: unknown is never
 * drawn as off. With `shares` the same grid summarises a project's hooks: a
 * partly filled cell is a callback only some of them enable. */
export function PermissionGlyph({
  flags = {},
  shares,
  label: givenLabel,
  size = "small",
  className = "",
  decorative = false,
}: {
  flags?: Flags;
  shares?: Shares;
  /** Replaces the generated accessible name (for example for a project summary). */
  label?: string;
  size?: "small" | "large";
  className?: string;
  /** The same facts are written out next to it: hide it from assistive technology. */
  decorative?: boolean;
}) {
  const large = size === "large";
  const names = COLUMNS.flat().filter((name): name is string => name !== null);
  const states = new Map(names.map((name) => [name, cellState(name, flags, shares)]));
  const enabled = names.filter((name) => states.get(name)!.state === "on");
  const partial = names.filter((name) => states.get(name)!.state === "partial");
  const unknown = names.filter((name) => states.get(name)!.state === "unknown");
  const label =
    givenLabel ??
    (unknown.length === names.length
      ? "Permission flags not reported"
      : `${enabled.length} of 14 permission flags enabled${
          shares ? " on every hook" : ""
        }${enabled.length ? `: ${enabled.join(", ")}` : ""}${
          partial.length
            ? `. ${partial.length} enabled on some hooks: ${partial.join(", ")}`
            : ""
        }${unknown.length ? `. ${unknown.length} not reported` : ""}`);
  return (
    <span
      className={`permission-glyph ${className}`.trim()}
      data-size={size}
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : label}
      aria-hidden={decorative || undefined}
      title={large || decorative ? undefined : label}
    >
      {large && (
        <>
          <span className="permission-glyph-axis" aria-hidden="true">
            <span>before</span>
            <span>after</span>
          </span>
          {COLUMN_LABELS.map((text, column) => (
            <span
              key={text}
              className="permission-glyph-label"
              data-lead={column === FIRST_DELTA_COLUMN || undefined}
              style={{ gridColumn: column + 2, gridRow: 1 }}
              aria-hidden="true"
            >
              {text}
            </span>
          ))}
        </>
      )}
      {COLUMNS.map((pair, column) =>
        pair.map((name, row) => {
          if (name === null) return null;
          const cell = states.get(name)!;
          return (
            <span
              key={name}
              className="permission-glyph-cell"
              data-kind={kindOf.get(name)}
              data-lead={column === FIRST_DELTA_COLUMN || undefined}
              data-state={cell.state}
              style={{
                // Small glyph: a spacer track sits between the operation columns
                // and the returns-delta columns, so those columns shift one over.
                gridColumn:
                  column + (large ? 2 : column >= FIRST_DELTA_COLUMN ? 2 : 1),
                gridRow: row + (large ? 2 : 1),
                ...(cell.state === "partial"
                  ? ({ "--share": drawnShare(cell.share ?? 0.5) } as Record<string, number | undefined>)
                  : {}),
              }}
              title={cellTitle(name, cell, Boolean(shares))}
              aria-hidden="true"
            />
          );
        }),
      )}
    </span>
  );
}

/** The four states a callback signature cell can show. */
export function PermissionGlyphKey({ className = "" }: { className?: string }) {
  const items: readonly [CellState, string, number?][] = [
    ["on", "Every hook"],
    ["partial", "Some hooks", 0.5],
    ["off", "No hook"],
    ["unknown", "Not reported"],
  ];
  return (
    <ul className={`permission-glyph-key ${className}`.trim()} aria-label="Cell key">
      {items.map(([state, text, share]) => (
        <li key={state}>
          <span
            className="permission-glyph-cell"
            data-state={state}
            style={share === undefined ? undefined : ({ "--share": share } as Record<string, number>)}
            aria-hidden="true"
          />
          {text}
        </li>
      ))}
    </ul>
  );
}
