import { SNAPSHOT_TRANSPORT_TYPE } from "./snapshot-transport.ts";

export const DASHBOARD_SNAPSHOT_TYPE =
  "application/vnd.hook-radar.dashboard+json";
export const DASHBOARD_SNAPSHOT_ACCEPT = `${DASHBOARD_SNAPSHOT_TYPE};version=1, ${SNAPSHOT_TRANSPORT_TYPE};version=1;q=0.9, application/json;q=0.8`;

/** Opt in explicitly. Older servers can still select the full compact or JSON
 * fallback; unsupported versions and ambiguous parameters never opt readers in. */
export function wantsDashboardSnapshot(accept: string | undefined): boolean {
  if (!accept || accept.length > 8192) return false;
  let dashboardQuality = -1,
    fallbackQuality = -1;
  for (const entry of accept.split(",")) {
    const [media, ...parameters] = entry.trim().toLowerCase().split(";");
    const type = media.trim();
    if (
      type !== DASHBOARD_SNAPSHOT_TYPE &&
      type !== SNAPSHOT_TRANSPORT_TYPE &&
      type !== "application/json"
    )
      continue;
    let version = "",
      quality = 1,
      valid = true;
    const seen = new Set<string>();
    for (const parameter of parameters) {
      const pair = parameter.trim().split("=");
      if (pair.length !== 2) {
        valid = false;
        continue;
      }
      const [name, raw] = pair.map((part) => part.trim());
      if (seen.has(name) || !["version", "q"].includes(name) || !raw)
        valid = false;
      seen.add(name);
      if (name === "version") version = raw === "1" || raw === '"1"' ? "1" : "";
      if (name === "q") {
        if (!/^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(raw)) valid = false;
        quality = Number(raw);
      }
    }
    if (!valid || (type !== "application/json" && version !== "1")) continue;
    if (type === DASHBOARD_SNAPSHOT_TYPE)
      dashboardQuality = Math.max(dashboardQuality, quality);
    else fallbackQuality = Math.max(fallbackQuality, quality);
  }
  return dashboardQuality > 0 && dashboardQuality >= fallbackQuality;
}
