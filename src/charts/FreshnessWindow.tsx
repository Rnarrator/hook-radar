import { STATIC_EDITION } from "../edition";
import { formatAge, formatUtcClock } from "./format";
import "./charts.css";

export interface FreshnessWindowProps {
  /** Evaluation clock (epoch ms). */
  now: number;
  /** Qualification window, e.g. 5 minutes. */
  maxAgeMs: number;
  /** Original source clocks of the oldest / newest contributing observation. */
  oldest: number | null;
  newest: number | null;
  /** Number of contributing observations. */
  count: number;
  label: string;
}

/** Where the contributing measurements sit inside the qualification window.
 * Left is "now", right is the expiry age; the band spans newest → oldest
 * original observation clocks. Nothing here is estimated. */
export function FreshnessWindow({
  now,
  maxAgeMs,
  oldest,
  newest,
  count,
  label,
}: FreshnessWindowProps) {
  const known = count > 0 && oldest !== null && newest !== null;
  const fraction = (time: number) =>
    Math.max(0, Math.min(1, (now - time) / maxAgeMs)) * 100;
  const minutes = Math.round(maxAgeMs / 60000);
  const description = known
    ? `${label}: ${count.toLocaleString("en-US")} measurements observed between ${formatUtcClock(oldest!)} and ${formatUtcClock(newest!)}; ${STATIC_EDITION ? `at the snapshot time the oldest was ${formatAge(now - oldest!)} old` : `oldest is ${formatAge(now - oldest!)} old`} of a ${minutes}-minute limit.`
    : `${label}: no current measurements inside the ${minutes}-minute window.`;
  return (
    <div className="chart-window" role="img" aria-label={description}>
      <div className="chart-window-track" aria-hidden="true">
        {Array.from({ length: minutes + 1 }, (_, index) => (
          <span
            key={index}
            className="chart-window-tick"
            style={{ left: `${(index / minutes) * 100}%` }}
          />
        ))}
        {known && (
          <span
            className="chart-window-band"
            style={{
              left: `${fraction(newest!)}%`,
              width: `${Math.max(0.6, fraction(oldest!) - fraction(newest!))}%`,
            }}
          />
        )}
        {known && (
          <span
            className="chart-window-marker"
            style={{ left: `${fraction(oldest!)}%` }}
          />
        )}
      </div>
      <div className="chart-window-scale" aria-hidden="true">
        <span>{STATIC_EDITION ? "snapshot" : "now"}</span>
        <span>{minutes}m · excluded beyond</span>
      </div>
    </div>
  );
}
