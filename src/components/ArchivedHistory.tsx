import { Fragment, useEffect, useId, useRef, useState } from "react";
import {
  historyArchiveCsv,
  isHistoryArchivePage,
  observationTime,
} from "../history-archive";
import type { HistoryArchivePage } from "../history-archive";
import { count, money } from "../model";
import { ChevronDown, Download, History, RefreshCw } from "./Icons";
import "./archived-history.css";

type RequestPage = {
  cursor: string | null;
  trail: (string | null)[];
  watermark: number | null;
};
type LoadedPage = { request: RequestPage; data: HistoryArchivePage };
const firstPage = (): RequestPage => ({
  cursor: null,
  trail: [],
  watermark: null,
});
const MAX_BYTES = 4 * 1024 ** 2;
async function boundedPage(response: Response) {
  if (!response.body) throw new Error("The archive response was empty.");
  if (Number(response.headers.get("content-length")) > MAX_BYTES)
    throw new Error("The archive page was too large to read.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES)
        throw new Error("The archive page was too large to read.");
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Mount with the project ID as its key so another project's response cannot leak across navigation. */
export function ArchivedHistory({
  projectId,
  unavailable = false,
}: {
  projectId: string;
  unavailable?: boolean;
}) {
  const panelId = useId();
  const tableRef = useRef<HTMLDivElement>(null);
  const pages = useRef(new Map<string | null, HistoryArchivePage>());
  const [expanded, setExpanded] = useState(false);
  const [request, setRequest] = useState<RequestPage>(firstPage);
  const [loaded, setLoaded] = useState<LoadedPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [downloaded, setDownloaded] = useState(false);
  const [sourceOpen, setSourceOpen] = useState<string | null>(null);
  useEffect(() => {
    if (!expanded || unavailable) {
      setLoading(false);
      return;
    }
    const cached = pages.current.get(request.cursor);
    if (cached) {
      setLoaded({ request, data: cached });
      setLoading(false);
      setError("");
      setDownloaded(false);
      setSourceOpen(null);
      if (tableRef.current) tableRef.current.scrollTop = 0;
      return;
    }
    const controller = new AbortController();
    let active = true;
    const timeout = setTimeout(() => controller.abort(), 15000);
    setLoading(true);
    setError("");
    const params = new URLSearchParams({ limit: "25" });
    if (request.cursor) params.set("before", request.cursor);
    void fetch(
      `/api/projects/${encodeURIComponent(projectId)}/history?${params}`,
      {
        signal: controller.signal,
        headers: { Accept: "application/json" },
        redirect: "error",
      },
    )
      .then(async (response) => {
        if (!response.ok)
          throw new Error(
            response.status === 503
              ? "The archive is temporarily unavailable. Your last loaded page is kept."
              : "We couldn’t load the archive. Please try again.",
          );
        const data = await boundedPage(response);
        if (
          !isHistoryArchivePage(data, projectId) ||
          (request.watermark !== null &&
            data.watermark !== request.watermark) ||
          (data.nextCursor !== null &&
            (data.nextCursor === request.cursor ||
              request.trail.includes(data.nextCursor)))
        )
          throw new Error(
            "The archive response couldn’t be verified. Please try again.",
          );
        if (!active || controller.signal.aborted) return;
        pages.current.set(request.cursor, data);
        if (pages.current.size > 32) {
          // Keep the pinned first page for Previous; later cursors carry their
          // own watermark and can be fetched again without mixing generations.
          for (const key of pages.current.keys()) {
            if (key !== null && key !== request.cursor) {
              pages.current.delete(key);
              break;
            }
          }
        }
        setLoaded({ request, data });
        setDownloaded(false);
        setSourceOpen(null);
        if (tableRef.current) tableRef.current.scrollTop = 0;
      })
      .catch((failure: unknown) => {
        if (!active) return;
        setError(
          controller.signal.aborted
            ? "Loading took longer than expected. Please try again."
            : failure instanceof Error &&
                !["TypeError", "SyntaxError"].includes(failure.name)
              ? failure.message
              : "The archive couldn’t be reached. Check your connection and retry.",
        );
      })
      .finally(() => {
        clearTimeout(timeout);
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [expanded, projectId, request, unavailable]);
  const data = loaded?.data;
  const busy = loading || unavailable;
  const scoped = new Map(data?.scopes.map((scope) => [scope.id, scope]) || []);
  function downloadPage() {
    if (!data?.points.length) return;
    let url: string | undefined;
    try {
      url = URL.createObjectURL(
        new Blob([historyArchiveCsv(data)], { type: "text/csv;charset=utf-8" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `hook-radar-${projectId}-archived-page-${(loaded?.request.trail.length || 0) + 1}.csv`;
      link.click();
      setDownloaded(true);
    } catch {
      setError(
        "The download couldn’t start. Your archive page is still available.",
      );
    } finally {
      if (url) {
        const downloadUrl = url;
        setTimeout(() => URL.revokeObjectURL(downloadUrl), 30000);
      }
    }
  }
  return (
    <section className="archived-history">
      <button
        className="archive-disclosure dossier-toggle"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => setExpanded((value) => !value)}
      >
        <History size={16} />
        <span className="dossier-title">Archived observations</span>
        <span className="dossier-hint" aria-hidden="true">
          Saved 24H volume
        </span>
        <ChevronDown size={15} className={expanded ? "rotate" : ""} />
      </button>
      {expanded && (
        <div id={panelId} className="archive-content">
          <p className="archive-intro">
            Saved 24-hour volume measurements from earlier snapshots. Each value
            keeps its original observation time and project association.
          </p>
          <div
            className="archive-feedback"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {unavailable
              ? "Updates are unavailable. Any loaded archive page stays visible."
              : loading
                ? "Loading archived observations…"
                : error ||
                  (downloaded
                    ? "Page downloaded."
                    : data
                      ? `${count(data.total)} archived observations. Page ${(loaded?.request.trail.length || 0) + 1}.`
                      : "")}
          </div>
          {error && !busy && (
            <button
              className="control archive-retry"
              onClick={() => setRequest({ ...request })}
            >
              <RefreshCw size={14} /> Try again
            </button>
          )}
          {loading && !data && (
            <div className="archive-skeleton" aria-hidden="true">
              {[0, 1, 2, 3, 4].map((value) => (
                <span className="skeleton" key={value} />
              ))}
            </div>
          )}
          {data && !data.points.length && !loading && (
            <div className="archive-empty">
              <History size={22} />
              <strong>No archived observations yet</strong>
              <p>Older observations appear here as new measurements arrive.</p>
            </div>
          )}
          {!!data?.points.length && (
            <>
              <div className="archive-toolbar">
                <span>Newest archived first · times in UTC</span>
                <button className="detail-text-action" onClick={downloadPage}>
                  <Download size={14} /> Download this page
                </button>
              </div>
              <div
                className="archive-table-scroll"
                ref={tableRef}
                tabIndex={0}
                role="region"
                aria-label="Archived volume observations"
              >
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Observed at · UTC</th>
                      <th scope="col">24H volume · USD</th>
                      <th scope="col">Record</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.points.map((point) => {
                      const time = new Date(
                        observationTime(point.timestamp),
                      ).toISOString();
                      const scope = scoped.get(point.scopeId);
                      return (
                        <Fragment key={point.id}>
                          <tr>
                            <td>
                              <time dateTime={time} title={time}>
                                {time.slice(0, 10)}
                                <span>{time.slice(11, 19)}</span>
                              </time>
                            </td>
                            <td title={`${point.value} USD`}>
                              {money(point.value)}
                            </td>
                            <td>
                              <button
                                className="archive-source-toggle"
                                aria-expanded={sourceOpen === point.id}
                                aria-controls={`${panelId}-${point.id}`}
                                onClick={() =>
                                  setSourceOpen((value) =>
                                    value === point.id ? null : point.id,
                                  )
                                }
                              >
                                Source{" "}
                                <ChevronDown
                                  size={12}
                                  className={
                                    sourceOpen === point.id ? "rotate" : ""
                                  }
                                />
                              </button>
                            </td>
                          </tr>
                          {sourceOpen === point.id && (
                            <tr className="archive-source-row">
                              <td
                                colSpan={3}
                                id={`${panelId}-${point.id}`}
                                data-testid="archive-source"
                              >
                                <p>
                                  Captured{" "}
                                  {new Date(point.capturedAt)
                                    .toISOString()
                                    .replace("T", " ")
                                    .slice(0, 19)}{" "}
                                  UTC.{" "}
                                  {scope?.kind === "captured-public-legacy"
                                    ? "Preserved public capture."
                                    : "Previously published project window."}{" "}
                                  The capture records the project association
                                  then; historical ownership has not been
                                  verified.
                                </p>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <nav className="archive-pagination" aria-label="Archive pages">
                <button
                  className="control"
                  disabled={busy || !loaded?.request.trail.length}
                  onClick={() => {
                    if (!loaded?.request.trail.length) return;
                    setRequest({
                      cursor: loaded.request.trail.at(-1) ?? null,
                      trail: loaded.request.trail.slice(0, -1),
                      watermark: data.watermark,
                    });
                  }}
                >
                  Previous
                </button>
                <span>Page {(loaded?.request.trail.length || 0) + 1}</span>
                <button
                  className="control"
                  disabled={busy || !data.nextCursor}
                  onClick={() => {
                    if (!loaded || !data.nextCursor) return;
                    setRequest({
                      cursor: data.nextCursor,
                      trail: [...loaded.request.trail, loaded.request.cursor],
                      watermark: data.watermark,
                    });
                  }}
                >
                  Next
                </button>
              </nav>
            </>
          )}
          {data && (
            <button
              className="detail-text-action archive-refresh"
              disabled={busy}
              onClick={() => {
                pages.current.clear();
                setRequest(firstPage());
              }}
            >
              <RefreshCw size={14} /> Check for newer records
            </button>
          )}
        </div>
      )}
    </section>
  );
}
