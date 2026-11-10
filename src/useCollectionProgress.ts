import { useEffect, useRef, useState } from "react";
import type { PoolIndexCoverage } from "../shared/types";
import { networkCaughtUp } from "../shared/indexing";
import { collectionProgressFact } from "./collection-progress";
import type { CollectionProgressFact } from "./collection-progress";

/** One quiet health request lane, independent of application data and errors. */
export function useCollectionProgress(inventory?: PoolIndexCoverage) {
  const [result, setResult] = useState<{
    signature: string;
    fact: CollectionProgressFact;
  } | null>(null);
  const lastAttempt = useRef(-Infinity);
  const inFlight = useRef<AbortController | null>(null);
  const needed = Boolean(
    inventory?.networks.some((network) => !networkCaughtUp(network)),
  );
  const signature = JSON.stringify(
    inventory?.networks.map((network) => [
      network.chain,
      network.chainId,
      network.manager,
      network.startBlock,
      network.scannedToBlock,
      network.targetBlock,
      network.poolCount,
      network.hookPoolCount,
      network.hookCount,
    ]),
  );
  const latestSignature = useRef(signature);
  latestSignature.current = signature;

  useEffect(() => {
    setResult(null);
    if (!inventory || !needed) return;
    let active = true;
    let nextTimer: ReturnType<typeof setTimeout> | undefined;
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    const visible = () => document.visibilityState !== "hidden";
    const clearFact = () => {
      clearTimeout(expiryTimer);
      setResult(null);
    };
    const schedule = (wait: number) => {
      clearTimeout(nextTimer);
      if (active && visible())
        nextTimer = setTimeout(() => void request(), wait);
    };
    const request = async () => {
      if (!active || !visible()) return;
      const remaining = Math.max(0, lastAttempt.current + 15000 - Date.now());
      if (remaining || inFlight.current) {
        schedule(remaining || 15000);
        return;
      }
      lastAttempt.current = Date.now();
      const controller = new AbortController();
      inFlight.current = controller;
      const deadline = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch("/api/health", {
          signal: controller.signal,
          cache: "no-store",
        });
        if (!response.ok) throw new Error("Collector status unavailable");
        const value: unknown = await response.json();
        if (
          !active ||
          !visible() ||
          controller.signal.aborted ||
          latestSignature.current !== signature
        )
          return;
        const fact = collectionProgressFact(value, inventory, Date.now());
        clearFact();
        if (fact) {
          setResult({ signature, fact });
          expiryTimer = setTimeout(
            clearFact,
            Math.max(0, fact.expiresAt - Date.now()),
          );
        }
      } catch {
        if (active) clearFact();
      } finally {
        clearTimeout(deadline);
        if (inFlight.current === controller) inFlight.current = null;
        schedule(Math.max(0, lastAttempt.current + 15000 - Date.now()));
      }
    };
    const visibility = () => {
      if (visible()) void request();
      else {
        clearTimeout(nextTimer);
        inFlight.current?.abort();
        clearFact();
      }
    };
    document.addEventListener("visibilitychange", visibility);
    void request();
    return () => {
      active = false;
      clearTimeout(nextTimer);
      clearTimeout(expiryTimer);
      inFlight.current?.abort();
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [signature, needed]);
  return needed && result && result.signature === signature
    ? result.fact
    : null;
}
