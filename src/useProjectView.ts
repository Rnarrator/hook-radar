import { useEffect, useRef, useState } from "react";
import {
  PROJECT_VIEW_MAX_BYTES,
  type ProjectView,
} from "../shared/project-view";
import { isProjectView } from "./project-view-validation";

const READINESS_MAX_BYTES = 64 * 1024;

async function boundedJson(
  response: Response,
  maxBytes: number,
  sizeMessage: string,
): Promise<unknown> {
  if (
    !response.body ||
    Number(response.headers.get("content-length")) > maxBytes
  ) {
    await response.body?.cancel().catch(() => {});
    throw new Error(sizeMessage);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) throw new Error(sizeMessage);
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function useProjectView(
  projectId: string | null,
  enabled: boolean,
  retry: number,
) {
  const [state, setState] = useState<{
    id: string;
    data?: ProjectView;
    error?: string;
    loading: boolean;
  }>({ id: "", loading: false });
  // A project the service reported missing is not asked for again each time
  // the page's own loading state changes: only the person's Retry asks again.
  const missing = useRef<{ id: string; retry: number } | null>(null);

  // Discard the previous selection during render, before reopening it can
  // reuse an older response ahead of effect cleanup. Disabling the same active
  // project during bulk hydration retains its complete, paired context.
  if (state.id !== "" && projectId !== state.id)
    setState({ id: "", loading: false });
  useEffect(() => {
    if (!enabled || !projectId) return;
    if (missing.current?.id === projectId && missing.current.retry === retry)
      return;
    const controller = new AbortController();
    let disposed = false;
    const deadline = setTimeout(() => controller.abort(), 30000);
    setState({ id: projectId, loading: true });
    void (async () => {
      try {
        // Initial absence of a recovery response is not proof of readiness.
        // A small check keeps direct project links independent of bulk loading.
        const readiness = await fetch("/api/ready", {
          signal: controller.signal,
          cache: "no-store",
        });
        if (readiness.status !== 200) {
          await readiness.body?.cancel().catch(() => {});
          throw new Error(
            readiness.status === 503
              ? "Project data is being verified. Retry shortly."
              : "Project readiness could not be verified. Please retry.",
          );
        }
        const ready = await boundedJson(
          readiness,
          READINESS_MAX_BYTES,
          "The readiness response exceeded its safe size. Please retry.",
        ).catch((cause: unknown) => {
          if (cause instanceof SyntaxError)
            throw new Error(
              "Project readiness returned an unsupported response. Please retry.",
            );
          throw cause;
        });
        controller.signal.throwIfAborted();
        if (disposed) return;
        if (
          !ready ||
          typeof ready !== "object" ||
          Array.isArray(ready) ||
          !("ok" in ready) ||
          ready.ok !== true ||
          !("service" in ready) ||
          ready.service !== "hook-radar" ||
          ("state" in ready && ready.state !== "ready")
        )
          throw new Error(
            "Project readiness could not be verified. Please retry.",
          );
        const response = await fetch(
          `/api/projects/${encodeURIComponent(projectId)}/view`,
          { signal: controller.signal, cache: "no-store" },
        );
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          if (response.status === 404) missing.current = { id: projectId, retry };
          throw new Error(
            response.status === 404
              ? "This project is no longer in the directory."
              : response.status === 503
                ? "Project data is being verified. Retry shortly."
                : response.status === 413
                  ? "This project needs the full analytics view. Load the full dashboard to continue."
                  : "Project details could not load. Please retry.",
          );
        }
        const value = await boundedJson(
          response,
          PROJECT_VIEW_MAX_BYTES,
          "Project details exceeded their safe response size.",
        );
        controller.signal.throwIfAborted();
        if (!isProjectView(value, projectId))
          throw new Error("Project details returned an unsupported response.");
        if (!disposed) setState({ id: projectId, data: value, loading: false });
      } catch (cause) {
        if (!disposed)
          setState({
            id: projectId,
            loading: false,
            error: controller.signal.aborted
              ? "Project details took too long. Please retry."
              : cause instanceof Error &&
                  !["TypeError", "SyntaxError"].includes(cause.name)
                ? cause.message
                : "Project details could not load. Check your connection and retry.",
          });
      } finally {
        clearTimeout(deadline);
      }
    })();
    return () => {
      disposed = true;
      clearTimeout(deadline);
      controller.abort();
    };
  }, [projectId, enabled, retry]);
  return state.id === projectId
    ? state
    : { id: projectId || "", loading: Boolean(projectId && enabled) };
}
