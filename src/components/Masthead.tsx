import { count } from "../model";
import { STATIC_EDITION } from "../edition";

export interface MastheadTotals {
  projects: number | null;
  hooks: number | null;
  pools: number | null;
  networks: number | null;
}

/** Directory totals from the retained inventory. Unavailable stays "—", and
 * pool totals are what was found, not what is priced. Each figure has a short
 * note and a longer plain-language explanation for its hover text. */
export function MastheadFigures({
  projects,
  hooks,
  pools,
  networks,
  census = null,
}: MastheadTotals & {
  /** The static edition dates the indexer's counts: "census as of 27 Oct 2026". */
  census?: string | null;
}) {
  const rows: [string, number | null, string, string][] = [
    [
      "Projects",
      projects,
      "listed by name",
      "Teams and protocols that publish a public identity. One project can run many hooks.",
    ],
    [
      "Hooks",
      hooks,
      "found onchain",
      "Individual hook contracts that Radar has found onchain.",
    ],
    [
      "Pools",
      pools,
      "using a hook",
      "Trading pools that use a hook, whether or not Radar can price them yet.",
    ],
    // The edition's figure is the census's network count, the same "with
    // indexed pools" total the Networks page gives, and carries its date below.
    STATIC_EDITION
      ? [
          "Networks",
          networks,
          "with indexed pools",
          "Blockchains the census scanned for Uniswap v4 pools.",
        ]
      : [
          "Networks",
          networks,
          "chains we follow",
          "Blockchains where Uniswap v4 is live and that Radar follows.",
        ],
  ];
  return (
    <>
      <dl className="masthead-figures" aria-label="Directory totals">
        {rows.map(([label, value, note, help]) => (
          <div key={label} title={help}>
            <dt>{label}</dt>
            <dd>{count(value)}</dd>
            <dd className="masthead-note">{note}</dd>
          </div>
        ))}
      </dl>
      {census && (
        <p className="masthead-census" data-testid="masthead-census">
          {STATIC_EDITION ? "Hooks, pools and networks" : "Hooks and pools"}:{" "}
          {census}
        </p>
      )}
    </>
  );
}
