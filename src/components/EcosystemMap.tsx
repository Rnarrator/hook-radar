import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type {
  Category,
  DirectoryMapNode,
  DirectoryPage,
  RadarProject,
} from "../../shared/types";
import { categories, count } from "../model";
import { discoveryCategories } from "../discovery";
import { FamilyFingerprint } from "../MarketProvenance";
import { ArrowRight, ChevronDown, Search } from "./Icons";
import { Empty } from "./Primitives";
import { ProtocolLogo } from "./ProtocolLogo";
import "./ecosystem-map.css";

export interface EcosystemMapProps {
  projects: RadarProject[];
  duplicateNames: Set<string>;
  openProject: (id: string) => void;
  chooseCategory: (category: string) => void;
  remoteGroups?: DirectoryPage["map"];
}

/** Matches the directory service: six highest-hook projects per use case. */
const TOP_PROJECTS = 6;
/** Below this width the map becomes a proportional strip plus a region list. */
const TREEMAP_MIN_WIDTH = 640;
/** Phone list: top three per region; the header opens the full use case. */
const PHONE_PROJECTS = 3;
/* Pixel budget used to decide how many project rows fit inside a region
   (kept in step with ecosystem-map.css). */
const NODE_HEIGHT = 46;
const HEADER_HEIGHT = 86;
const COMPACT_HEADER_HEIGHT = 52;
const FOOTER_HEIGHT = 26;
const TILE_CHROME = 36;

interface MapNode {
  id: string;
  name: string;
  hookCount: number;
  chainCount: number;
  project: RadarProject | null;
  remote: DirectoryMapNode | null;
}

interface MapRegion {
  category: Category;
  total: number;
  share: number;
  nodes: MapNode[];
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Squarified treemap (Bruls, Huizing & van Wijk). Input must be sorted
 * descending; output rectangles have areas exactly proportional to values. */
export function squarify(values: readonly number[], frame: Rect): Rect[] {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!(total > 0) || frame.w <= 0 || frame.h <= 0)
    return values.map(() => ({ x: frame.x, y: frame.y, w: 0, h: 0 }));
  const scale = (frame.w * frame.h) / total;
  const areas = values.map((value) => Math.max(0, value) * scale);
  const out: Rect[] = [];
  let rest = { ...frame };
  let index = 0;
  const worst = (row: number[], side: number) => {
    const sum = row.reduce((a, b) => a + b, 0);
    const max = Math.max(...row);
    const min = Math.min(...row);
    if (!(sum > 0) || !(min > 0)) return Infinity;
    return Math.max(
      (side * side * max) / (sum * sum),
      (sum * sum) / (side * side * min),
    );
  };
  while (index < areas.length) {
    const side = Math.min(rest.w, rest.h);
    const row = [areas[index]];
    let next = index + 1;
    while (
      next < areas.length &&
      worst([...row, areas[next]], side) <= worst(row, side)
    ) {
      row.push(areas[next]);
      next++;
    }
    const sum = row.reduce((a, b) => a + b, 0);
    if (rest.w >= rest.h) {
      const width = rest.h > 0 ? sum / rest.h : 0;
      let y = rest.y;
      for (const area of row) {
        const height = width > 0 ? area / width : 0;
        out.push({ x: rest.x, y, w: width, h: height });
        y += height;
      }
      rest = { x: rest.x + width, y: rest.y, w: rest.w - width, h: rest.h };
    } else {
      const height = rest.w > 0 ? sum / rest.w : 0;
      let x = rest.x;
      for (const area of row) {
        const width = height > 0 ? area / height : 0;
        out.push({ x, y: rest.y, w: width, h: height });
        x += width;
      }
      rest = { x: rest.x, y: rest.y + height, w: rest.w, h: rest.h - height };
    }
    index = next;
  }
  return out;
}

function percent(share: number) {
  if (!(share > 0)) return "0%";
  if (share < 0.001) return "<0.1%";
  return `${(share * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
}

const categoryDetail = new Map<string, string>(
  discoveryCategories.map((item) => [item.value, item.detail]),
);

function categoryToken(category: string) {
  return `var(--cat-${category.toLowerCase()}, var(--cat-other))`;
}

function NodeButton({
  node,
  duplicate,
  openProject,
}: {
  node: MapNode;
  duplicate: boolean;
  openProject: (id: string) => void;
}) {
  return (
    <button
      type="button"
      className="map-node"
      onClick={() => openProject(node.id)}
    >
      <ProtocolLogo
        project={
          node.project || {
            id: node.id,
            name: node.name,
            description: node.remote?.description || "",
            deployments: [],
          }
        }
        artwork={node.remote ? node.remote.artwork : undefined}
      />
      <span className="eco-node-text">
        <span className="eco-node-name">{node.name}</span>
        {duplicate &&
          (node.project ? (
            <FamilyFingerprint project={node.project} />
          ) : (
            node.remote?.fingerprint && (
              <span
                className="family-fingerprint"
                title={`Separate directory family: ${node.remote.fingerprint.address} on ${node.remote.fingerprint.chain}`}
              >
                <code>
                  {node.remote.fingerprint.address.slice(0, 6)}…
                  {node.remote.fingerprint.address.slice(-4)}
                </code>
                <span> / {node.remote.fingerprint.chain}</span>
              </span>
            )
          ))}
        <span className="eco-node-meta">
          {count(node.hookCount)} {node.hookCount === 1 ? "hook" : "hooks"} ·{" "}
          {count(node.chainCount)}{" "}
          {node.chainCount === 1 ? "network" : "networks"}
        </span>
      </span>
    </button>
  );
}

/** Use-case regions sized by how many listed projects each holds. Area encodes
 * a directory count only: never value, volume or market share. */
export function EcosystemMap({
  projects,
  duplicateNames,
  openProject,
  chooseCategory,
  remoteGroups,
}: EcosystemMapProps) {
  const id = useId();
  const frame = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  const regions = useMemo((): MapRegion[] => {
    const raw = remoteGroups
      ? remoteGroups.map((group) => ({
          category: group.category,
          total: group.total,
          nodes: group.projects.slice(0, TOP_PROJECTS).map(
            (node): MapNode => ({
              id: node.id,
              name: node.name,
              hookCount: node.deploymentCount,
              chainCount: node.chains.length,
              project: null,
              remote: node,
            }),
          ),
        }))
      : categories.map((category) => {
          const members = projects
            .filter((project) => project.category === category)
            .sort(
              (a, b) =>
                b.deployments.length - a.deployments.length ||
                a.name.localeCompare(b.name),
            );
          return {
            category: category as Category,
            total: members.length,
            nodes: members.slice(0, TOP_PROJECTS).map(
              (project): MapNode => ({
                id: project.id,
                name: project.name,
                hookCount: project.deployments.length,
                chainCount: project.chains.length,
                project,
                remote: null,
              }),
            ),
          };
        });
    const listed = raw.filter(
      (group) => Number.isFinite(group.total) && group.total > 0,
    );
    const total = listed.reduce((sum, group) => sum + group.total, 0);
    return listed
      .map((group) => ({ ...group, share: total ? group.total / total : 0 }))
      .sort(
        (a, b) =>
          b.total - a.total ||
          categories.indexOf(a.category) - categories.indexOf(b.category),
      );
  }, [projects, remoteGroups]);
  const total = regions.reduce((sum, region) => sum + region.total, 0);
  const hasRegions = regions.length > 0;
  // Measure before paint so phones never flash the desktop treemap.
  useLayoutEffect(() => {
    const element = frame.current;
    if (!element) return;
    const measure = () =>
      setWidth(Math.round(element.getBoundingClientRect().width));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasRegions]);
  const treemap = width >= TREEMAP_MIN_WIDTH;
  const height = Math.round(
    Math.min(680, Math.max(440, width * (width >= 1100 ? 0.46 : 0.62))),
  );
  const rects = useMemo(
    () =>
      treemap
        ? squarify(
            regions.map((region) => region.total),
            { x: 0, y: 0, w: width, h: height },
          )
        : [],
    [regions, treemap, width, height],
  );
  const headers = useRef<(HTMLButtonElement | null)[]>([]);

  /** Arrow keys move between region headers by geometry, not DOM order. */
  const moveFocus = (event: KeyboardEvent<HTMLButtonElement>, from: number) => {
    const keys = [
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "ArrowDown",
      "Home",
      "End",
    ];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    let target = from;
    if (event.key === "Home") target = 0;
    else if (event.key === "End") target = regions.length - 1;
    else if (!treemap) {
      target =
        event.key === "ArrowUp" || event.key === "ArrowLeft"
          ? Math.max(0, from - 1)
          : Math.min(regions.length - 1, from + 1);
    } else {
      const origin = rects[from];
      const cx = origin.x + origin.w / 2;
      const cy = origin.y + origin.h / 2;
      let best = Infinity;
      rects.forEach((rect, index) => {
        if (index === from) return;
        const x = rect.x + rect.w / 2;
        const y = rect.y + rect.h / 2;
        const dx = x - cx;
        const dy = y - cy;
        const ahead =
          event.key === "ArrowRight"
            ? rect.x >= origin.x + origin.w - 1
            : event.key === "ArrowLeft"
              ? rect.x + rect.w <= origin.x + 1
              : event.key === "ArrowDown"
                ? rect.y >= origin.y + origin.h - 1
                : rect.y + rect.h <= origin.y + 1;
        if (!ahead) return;
        const along =
          event.key === "ArrowRight" || event.key === "ArrowLeft"
            ? Math.abs(dx)
            : Math.abs(dy);
        const across =
          event.key === "ArrowRight" || event.key === "ArrowLeft"
            ? Math.abs(dy)
            : Math.abs(dx);
        const score = along + across * 2;
        if (score < best) {
          best = score;
          target = index;
        }
      });
    }
    headers.current[target]?.focus();
  };

  const regionLabel = (region: MapRegion) =>
    `${region.category}: ${count(region.total)} listed ${region.total === 1 ? "project" : "projects"}, ${percent(region.share)} of ${count(total)}. Browse in Discover`;

  const header = (region: MapRegion, index: number, compact = false) => (
    <button
      type="button"
      className="eco-region-header"
      ref={(element) => {
        headers.current[index] = element;
      }}
      aria-label={regionLabel(region)}
      onClick={() => chooseCategory(region.category)}
      onKeyDown={(event) => moveFocus(event, index)}
    >
      <span className="eco-region-title">
        <i aria-hidden="true" />
        <span className="eco-region-name">{region.category}</span>
        <ArrowRight size={14} />
      </span>
      <span className="eco-region-figure">
        <span className="eco-region-count">{count(region.total)}</span>
        <span className="eco-region-share">{percent(region.share)}</span>
      </span>
      {!compact && categoryDetail.get(region.category) && (
        <span className="eco-region-detail">
          {categoryDetail.get(region.category)}
        </span>
      )}
    </button>
  );

  if (!regions.length)
    return (
      <section className="eco-map" aria-labelledby={`${id}-title`}>
        <div className="map-root eco-map-heading">
          <h2 id={`${id}-title`}>Hooks by use case</h2>
        </div>
        <Empty
          title="No projects match these filters"
          icon={<Search size={27} />}
        >
          Clear a filter to see more hook projects.
        </Empty>
      </section>
    );

  return (
    <section
      className="eco-map"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-caption`}
    >
      <div className="map-root eco-map-heading">
        <div>
          <h2 id={`${id}-title`}>Hooks by use case</h2>
        </div>
        <p className="eco-map-total">
          {count(total)} listed {total === 1 ? "project" : "projects"} ·{" "}
          {count(regions.length)} {regions.length === 1 ? "use case" : "use cases"}
        </p>
      </div>
      <p className="eco-map-caption" id={`${id}-caption`}>
        <b>A bigger box means more projects.</b> Each project appears once,
        under what it mainly does, and the biggest names in each box are the
        ones with the most hooks. This shows how many projects there are, not
        how much they trade or hold.
      </p>
      <div
        className="eco-map-frame"
        ref={frame}
        data-layout={width === 0 ? "pending" : treemap ? "treemap" : "list"}
      >
        {treemap ? (
          <ol
            className="eco-treemap"
            style={{ height }}
            aria-label={`Use-case regions, largest first. Arrow keys move between regions.`}
          >
            {regions.map((region, index) => {
              const rect = rects[index];
              const narrow = rect.w < 150;
              const compact = rect.h < 170 || rect.w < 190;
              const headerHeight = compact
                ? COMPACT_HEADER_HEIGHT
                : HEADER_HEIGHT;
              // Tile chrome (padding, top rule) plus the header-to-list gap.
              const room = rect.h - TILE_CHROME - headerHeight;
              const fitsAll =
                region.total <= region.nodes.length &&
                Math.floor((room + 2) / NODE_HEIGHT) >= region.nodes.length;
              const capacity = narrow
                ? 0
                : fitsAll
                  ? region.nodes.length
                  : Math.min(
                      region.nodes.length,
                      Math.max(
                        0,
                        Math.floor((room - FOOTER_HEIGHT + 2) / NODE_HEIGHT),
                      ),
                    );
              const shown = region.nodes.slice(0, capacity);
              const remaining = region.total - shown.length;
              return (
                <li
                  key={region.category}
                  className="eco-tile"
                  data-compact={compact}
                  data-narrow={rect.w < 150}
                  style={{
                    left: `${(rect.x / width) * 100}%`,
                    top: `${(rect.y / height) * 100}%`,
                    width: `${(rect.w / width) * 100}%`,
                    height: `${(rect.h / height) * 100}%`,
                    ["--region" as string]: categoryToken(region.category),
                  }}
                >
                  <div className="eco-tile-inner">
                    {header(region, index, compact)}
                    {shown.length > 0 && (
                      <ul
                        className="eco-nodes"
                        aria-label={`Top ${region.category} projects by listed hooks`}
                      >
                        {shown.map((node) => (
                          <li key={node.id}>
                            <NodeButton
                              node={node}
                              duplicate={duplicateNames.has(
                                node.name.trim().toLowerCase(),
                              )}
                              openProject={openProject}
                            />
                          </li>
                        ))}
                      </ul>
                    )}
                    {remaining > 0 && shown.length > 0 && (
                      <p className="eco-tile-more">+{count(remaining)} more</p>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        ) : (
          <>
            <div
              className="eco-strip"
              role="img"
              aria-label={`Listed projects by use case: ${regions.map((region) => `${region.category} ${count(region.total)} (${percent(region.share)})`).join(", ")}`}
            >
              {regions.map((region) => (
                <span
                  key={region.category}
                  style={{
                    flexGrow: region.total,
                    ["--region" as string]: categoryToken(region.category),
                  }}
                />
              ))}
            </div>
            <ol className="eco-region-list">
              {regions.map((region, index) => (
                <li
                  key={region.category}
                  className="eco-region"
                  style={{
                    ["--region" as string]: categoryToken(region.category),
                  }}
                >
                  {header(region, index)}
                  <span className="eco-region-bar" aria-hidden="true">
                    <span style={{ width: `${region.share * 100}%` }} />
                  </span>
                  <ul
                    className="eco-nodes"
                    aria-label={`Top ${region.category} projects by listed hooks`}
                  >
                    {region.nodes.slice(0, PHONE_PROJECTS).map((node) => (
                      <li key={node.id}>
                        <NodeButton
                          node={node}
                          duplicate={duplicateNames.has(
                            node.name.trim().toLowerCase(),
                          )}
                          openProject={openProject}
                        />
                      </li>
                    ))}
                  </ul>
                  {region.total >
                    Math.min(PHONE_PROJECTS, region.nodes.length) && (
                    <p className="eco-tile-more">
                      +
                      {count(
                        region.total -
                          Math.min(PHONE_PROJECTS, region.nodes.length),
                      )}{" "}
                      more in {region.category}
                    </p>
                  )}
                </li>
              ))}
            </ol>
          </>
        )}
      </div>
      {treemap && (
        <details className="eco-map-table">
          <summary>
            View as table <ChevronDown size={14} />
          </summary>
          <div className="eco-map-table-scroll">
            <table>
              <caption className="sr-only">
                Listed projects by use case, with the projects that list the
                most hook contracts
              </caption>
              <thead>
                <tr>
                  <th scope="col">Use case</th>
                  <th scope="col" className="numeric">
                    Listed projects
                  </th>
                  <th scope="col" className="numeric">
                    Share of {count(total)}
                  </th>
                  <th scope="col">Projects listing the most hooks</th>
                </tr>
              </thead>
              <tbody>
                {regions.map((region) => (
                  <tr key={region.category}>
                    <th scope="row">
                      <span
                        className="eco-table-swatch"
                        style={{
                          ["--region" as string]: categoryToken(
                            region.category,
                          ),
                        }}
                        aria-hidden="true"
                      />
                      {region.category}
                    </th>
                    <td className="numeric">{count(region.total)}</td>
                    <td className="numeric">{percent(region.share)}</td>
                    <td>
                      {region.nodes
                        .map(
                          (node) =>
                            `${node.name} (${count(node.hookCount)} ${node.hookCount === 1 ? "hook" : "hooks"})`,
                        )
                        .join(", ")}
                      {region.total > region.nodes.length &&
                        `, +${count(region.total - region.nodes.length)} more`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </section>
  );
}
