import type { View } from "../model";
import "./loading-plates.css";

/** The frame of the page that is about to appear, drawn with the shared
 * skeleton shimmer under the loading message, so a slow first load shows its
 * shape instead of an empty screen. Purely decorative: it holds no text, no
 * numbers and no data, and is hidden from assistive technology (the loading
 * message above it is the announcement). */
export function LoadingPlates({ view }: { view: View }) {
  const figures = view === "analytics" || view === "chains";
  return (
    <div className="loading-plates" aria-hidden="true" data-layout={figures ? "figures" : "list"}>
      {figures ? (
        <>
          <div className="loading-plates-figures">
            {[0, 1, 2, 3].map((index) => (
              <div key={index} className="loading-plates-figure">
                <span className="skeleton" data-size="label" />
                <span className="skeleton" data-size="figure" />
                <span className="skeleton" data-size="note" />
              </div>
            ))}
          </div>
          <div className="loading-plates-plate">
            <span className="skeleton" data-size="title" />
            {[88, 64, 47, 33, 21].map((width) => (
              <span key={width} className="skeleton" data-size="bar" style={{ width: `${width}%` }} />
            ))}
          </div>
        </>
      ) : (
        <div className="loading-plates-list">
          {[0, 1, 2, 3, 4].map((index) => (
            <div key={index} className="loading-plates-row">
              <span className="skeleton" data-size="avatar" />
              <span className="loading-plates-lines">
                <span className="skeleton" data-size="line" />
                <span className="skeleton" data-size="subline" />
              </span>
              <span className="skeleton" data-size="value" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
