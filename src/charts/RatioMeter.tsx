import type { CSSProperties } from "react";
import "./charts.css";

export interface RatioMeterProps {
  /** Fraction of the whole (0 to 1). Null draws nothing: unknown is not zero. */
  ratio: number | null;
  className?: string;
}

/** A thin meter for one measured ratio (for example pools with trading out of
 * pools with a current volume). It repeats a figure already printed in words
 * beside it, so it is hidden from assistive technology. */
export function RatioMeter({ ratio, className = "" }: RatioMeterProps) {
  if (ratio === null || !Number.isFinite(ratio)) return null;
  const clamped = Math.max(0, Math.min(1, ratio));
  return (
    <span
      className={`chart-ratio-meter ${className}`.trim()}
      aria-hidden="true"
      style={{ "--ratio": clamped } as CSSProperties}
    />
  );
}
