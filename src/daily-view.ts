import { createContext, useContext } from "react";
import type { DailyLens, DailySpan } from "./daily.ts";

/** What a screen needs to know about 7D and 30D, wherever it sits in the page:
 * the span being shown (null when none is), the lens over the file, and whether
 * the figures are on their way, there, or failed. Outside the edition, and when
 * no span is chosen, it is "off" and every screen shows what it always showed. */
export type DailyPhase = "off" | "loading" | "ready" | "error";

export interface DailyView {
  span: DailySpan | null;
  lens: DailyLens | null;
  phase: DailyPhase;
}

export const NO_DAILY: DailyView = { span: null, lens: null, phase: "off" };

const DailyViewContext = createContext<DailyView>(NO_DAILY);

export const DailyViewProvider = DailyViewContext.Provider;
export const useDailyView = (): DailyView => useContext(DailyViewContext);
