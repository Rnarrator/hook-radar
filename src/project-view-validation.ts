import type { ProjectView } from "../shared/project-view";
import {
  chain,
  inventory,
  isDiscoveryProject,
} from "./discovery-validation.ts";
import { isPoolKey } from "../shared/pool-key.ts";

const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const amount = (v: unknown) =>
  v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0);
const date = (v: unknown) =>
  typeof v === "string" && Number.isFinite(Date.parse(v));

export function isProjectView(
  value: unknown,
  projectId: string,
): value is ProjectView {
  if (
    !object(value) ||
    value.schemaVersion !== 1 ||
    value.ready !== true ||
    !object(value.presentation) ||
    value.presentation.profile !== "project" ||
    value.presentation.version !== 1 ||
    !date(value.generatedAt) ||
    !["live", "partial", "cached", "offline"].includes(String(value.status)) ||
    !object(value.project) ||
    value.project.id !== projectId ||
    !Array.isArray(value.project.history) ||
    !value.project.history.every(
      (point) =>
        object(point) &&
        typeof point.timestamp === "number" &&
        Number.isFinite(point.timestamp) &&
        typeof point.value === "number" &&
        Number.isFinite(point.value) &&
        point.value >= 0,
    ) ||
    (value.project.historyPointCount !== undefined &&
      value.project.historyPointCount !== value.project.history.length) ||
    !Array.isArray(value.chains) ||
    !value.chains.every(chain) ||
    new Set(value.chains.map((row) => row.slug)).size !== value.chains.length ||
    (value.inventory !== undefined && !inventory(value.inventory)) ||
    !Array.isArray(value.pools)
  )
    return false;
  const { history, ...project } = value.project;
  if (!isDiscoveryProject({ ...project, historyPointCount: history.length }))
    return false;
  const networks = new Set(value.chains.map((row) => row.slug));
  return (
    new Set(value.pools.map((pool) => pool?.id)).size === value.pools.length &&
    value.pools.every(
      (pool) =>
        object(pool) &&
        ["id", "name", "address", "url", "source"].every(
          (key) => typeof pool[key] === "string",
        ) &&
        pool.projectId === projectId &&
        typeof pool.chain === "string" &&
        networks.has(pool.chain) &&
        (pool.hookAddress === null || typeof pool.hookAddress === "string") &&
        (pool.poolKey === undefined ||
          isPoolKey(pool.poolKey, pool.hookAddress)) &&
        Array.isArray(pool.tokens) &&
        pool.tokens.every((token) => typeof token === "string") &&
        amount(pool.liquidityUsd) &&
        object(pool.volumeUsd) &&
        ["h1", "h6", "h24"].every((key) =>
          amount((pool.volumeUsd as Record<string, unknown>)[key]),
        ) &&
        (pool.liquidityStatus === undefined ||
          ["reported", "inconsistent", "unverified", "unavailable"].includes(
            String(pool.liquidityStatus),
          )) &&
        (pool.liquidityNote === undefined ||
          (typeof pool.liquidityNote === "string" &&
            pool.liquidityNote.length <= 500)),
    )
  );
}
