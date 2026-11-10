import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import type { RadarProject } from "../../shared/types";
import { launchpadChains, launchpadRegistry } from "../../shared/launchpad-registry";
import type { View } from "../model";
import {
  enabledCallbacks,
  flagsFromBits,
  hookAddressIssues,
  hookPermissionBits,
  parseHookAddress,
} from "../hook-permissions";
import { shortAddress } from "../model";
import { PermissionGlyph } from "./PermissionGlyph";
import { ProtocolLogo } from "./ProtocolLogo";
import {
  Activity,
  BookOpen,
  ChartLine,
  Compass,
  Copy,
  GitCompareArrows,
  Network,
  Orbit,
  RefreshCw,
  Rocket,
  Search,
  Star,
  X,
} from "./Icons";
import { Modal } from "./Primitives";
import "./command-palette.css";
import { STATIC_EDITION, editionViews } from "../edition";

export type PaletteCommand =
  | { type: "view"; view: View }
  | { type: "network"; chain: string }
  | { type: "launchpads" }
  | { type: "platform"; id: string }
  | { type: "project"; id: string }
  | { type: "search"; query: string }
  | { type: "refresh" }
  | { type: "copy-link" }
  | { type: "copy-address"; address: string };

type Group = "Recent" | "Pages" | "Launchpads" | "Networks" | "Projects" | "Actions" | "Search";

interface Item {
  key: string;
  group: Group;
  label: string;
  hint: string;
  /** Extra words the query may match, never shown. */
  words: string;
  icon: ReactNode;
  command: PaletteCommand;
}

const pages: readonly { view: View; label: string; hint: string; icon: ReactNode }[] = [
  { view: "overview", label: "Discover", hint: "Browse hooks and projects", icon: <Compass size={17} /> },
  { view: "learn", label: "Learn", hint: "What hooks are and how they work", icon: <BookOpen size={17} /> },
  { view: "analytics", label: "Analytics", hint: "How much hooks trade and hold", icon: <ChartLine size={17} /> },
  { view: "chains", label: "Networks", hint: "Which hooks run on each network", icon: <Network size={17} /> },
  { view: "map", label: "By use case", hint: "Hook projects grouped by what they do", icon: <Orbit size={17} /> },
  { view: "activity", label: "Activity", hint: "Recent swaps and liquidity changes", icon: <Activity size={17} /> },
  { view: "compare", label: "Compare", hint: "Put hooks side by side", icon: <GitCompareArrows size={17} /> },
  { view: "watchlist", label: "Watchlist", hint: "Your saved projects", icon: <Star size={17} /> },
];

const LIMITS: Record<Group, number> = {
  Recent: 5,
  Pages: 4,
  Launchpads: 5,
  Networks: 4,
  Projects: 8,
  Actions: 3,
  Search: 1,
};
const ORDER: Group[] = ["Recent", "Pages", "Launchpads", "Networks", "Projects", "Actions", "Search"];

const RECENT_KEY = "hook-radar-recent-commands-v1";
const readRecent = (): string[] => {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string").slice(0, 5)
      : [];
  } catch {
    return [];
  }
};
const remember = (key: string) => {
  try {
    const next = [key, ...readRecent().filter((item) => item !== key)].slice(0, 5);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Remembering is a convenience; private windows and blocked storage skip it.
  }
};

const normalise = (text: string) =>
  text.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^$|(){}[\]\\]/g, "\\$&");

interface QueryWord {
  word: string;
  /** Matches the word at the start of any word in the text. */
  atWordStart: RegExp;
}
/** Words that would match every hint ("go to Learn") and carry no intent. */
const STOP_WORDS = new Set(["a", "an", "and", "for", "go", "of", "on", "open", "the", "to"]);
const queryWords = (query: string): QueryWord[] =>
  normalise(query)
    .split(/\s+/)
    .filter((word) => word && !STOP_WORDS.has(word))
    .map((word) => ({
      word,
      atWordStart: new RegExp(`(^|[\\s._/-])${escapeRegExp(word)}`),
    }));

/** Every word of the query must start a word of the item, or appear inside it. */
function score(query: QueryWord[], label: string, words: string) {
  const name = normalise(label);
  const haystack = `${name} ${words}`;
  let total = 0;
  for (const { word, atWordStart } of query) {
    if (name === word) total += 120;
    else if (name.startsWith(word)) total += 100;
    else if (atWordStart.test(haystack)) total += 70;
    else if (haystack.includes(word)) total += 35;
    else return 0;
  }
  return total - Math.min(name.length, 40) / 40;
}

const isApple = () =>
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);

/** The key combination shown beside the header button. */
export function paletteShortcutLabel() {
  return isApple() ? "⌘K" : "Ctrl K";
}

/** ⌘K on Apple devices, Ctrl+K elsewhere. Ctrl+K is left alone on a Mac, where
 * it is "kill line" in text fields, and the key is matched by position as well
 * as by letter so non-Latin layouts work. */
export function isPaletteShortcut(event: globalThis.KeyboardEvent) {
  if (event.altKey || event.shiftKey || event.isComposing) return false;
  const modifier = isApple()
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
  return modifier && (event.code === "KeyK" || event.key.toLowerCase() === "k");
}

export function CommandPalette({
  view,
  projects,
  networks,
  canRefresh,
  onClose,
  onRun,
}: {
  view: View;
  projects: readonly RadarProject[];
  networks: readonly { id: string; name: string }[];
  /** Whether the page's own Refresh control is available right now. */
  canRefresh: boolean;
  onClose: () => void;
  onRun: (command: PaletteCommand) => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const recent = useMemo(readRecent, []);

  const items = useMemo(() => {
    const networkName = new Map(networks.map((item) => [item.id, item.name]));
    const list: Item[] = [];
    // The static edition has no Activity page and lists the guide last, as its
    // tabs do; the live list keeps the order of `pages`.
    for (const view of editionViews(pages.map((page) => page.view))) {
      const page = pages.find((entry) => entry.view === view)!;
      list.push({
        key: `view:${page.view}`,
        group: "Pages",
        label: page.label,
        hint: page.hint,
        words: normalise(`${page.hint} ${page.view}`),
        icon: page.icon,
        command: { type: "view", view: page.view },
      });
    }
    list.push({
      key: "launchpads",
      group: "Launchpads",
      label: "Launchpads",
      hint: "Launch platforms on v4, by network",
      words: "launchpad launch platforms tokens",
      icon: <Rocket size={17} />,
      command: { type: "launchpads" },
    });
    for (const record of launchpadRegistry) {
      const names = launchpadChains(record).map((id) => networkName.get(id) || id);
      list.push({
        key: `platform:${record.id}`,
        group: "Launchpads",
        label: record.name,
        hint: names.length ? `Launchpad · ${names.join(" · ")}` : "Launchpad",
        words: normalise(`${record.id} launchpad ${names.join(" ")}`),
        icon: <Rocket size={17} />,
        command: { type: "platform", id: record.id },
      });
    }
    for (const network of networks)
      list.push({
        key: `network:${network.id}`,
        group: "Networks",
        label: network.name,
        hint: "Network · protocols, hooks and markets",
        words: normalise(`${network.id} chain network`),
        icon: <Network size={17} />,
        command: { type: "network", chain: network.id },
      });
    for (const project of projects)
      list.push({
        key: `project:${project.id}`,
        group: "Projects",
        label: project.name,
        // The first contract's short address tells apart projects that share a name.
        hint: [
          project.entityType === "platform" ? "Platform" : project.category,
          project.chains.length
            ? `${networkName.get(project.chains[0]) || project.chains[0]}${
                project.chains.length > 1 ? ` +${project.chains.length - 1}` : ""
              }`
            : "",
          project.deployments[0] ? shortAddress(project.deployments[0].address) : "",
        ]
          .filter(Boolean)
          .join(" · "),
        // Not the use case: "fees" would otherwise list every project filed under
        // Fees whatever its name; the Discover filters search by use case.
        words: normalise(project.id),
        icon: <ProjectMark project={project} />,
        command: { type: "project", id: project.id },
      });
    // Refresh is offered only while the page's own Refresh control would work.
    if (canRefresh)
      list.push({
        key: "action:refresh",
        group: "Actions",
        label: "Refresh data",
        hint: "Reload the directory and market data",
        words: "reload update sync",
        icon: <RefreshCw size={17} />,
        command: { type: "refresh" },
      });
    list.push({
      key: "action:copy-link",
      group: "Actions",
      label: "Copy link to this view",
      hint: "Share the current filters and page",
      words: "share url permalink",
      icon: <Copy size={17} />,
      command: { type: "copy-link" },
    });
    return list;
  }, [projects, networks, canRefresh]);

  const address = parseHookAddress(query);
  const bits = address ? hookPermissionBits(address) : null;
  const tokens = useMemo(() => queryWords(query), [query]);

  const results = useMemo(() => {
    const trimmed = query.trim();
    const out: Item[] = [];
    if (address) {
      out.push(
        {
          key: "search:address",
          group: "Search",
          label: `Search Discover for ${shortAddress(address)}`,
          hint: STATIC_EDITION
            ? "Look for the hook in this snapshot"
            : "Find the hook and its pools in the directory",
          words: "",
          icon: <Search size={17} />,
          command: { type: "search", query: address },
        },
        {
          key: "action:copy-address",
          group: "Actions",
          label: "Copy address",
          hint: address,
          words: "",
          icon: <Copy size={17} />,
          command: { type: "copy-address", address },
        },
      );
      return out;
    }
    if (!tokens.length) {
      const byKey = new Map(items.map((item) => [item.key, item]));
      for (const key of recent) {
        const item = byKey.get(key);
        if (item) out.push({ ...item, group: "Recent" });
      }
      for (const item of items)
        if (
          item.group === "Pages" ||
          item.key === "launchpads" ||
          item.group === "Actions"
        )
          out.push(item);
      return out;
    }
    const buckets = new Map<Group, { item: Item; value: number }[]>();
    for (const item of items) {
      if (item.group === "Actions" && query.trim().length < 3) continue;
      const value = score(tokens, item.label, item.words);
      if (value <= 0) continue;
      const bucket = buckets.get(item.group) || [];
      bucket.push({ item, value });
      buckets.set(item.group, bucket);
    }
    // The group holding the best match leads, so "base" puts the Base network
    // ahead of the launchpads that merely run on it. Actions rank last on a tie.
    const groups = ORDER.flatMap((group) => {
      const bucket = buckets.get(group);
      if (!bucket) return [];
      bucket.sort((a, b) => b.value - a.value || a.item.label.localeCompare(b.item.label));
      const lead = bucket[0].value - (group === "Actions" ? 40 : 0);
      return [{ group, bucket, lead }];
    });
    groups.sort((a, b) => b.lead - a.lead || ORDER.indexOf(a.group) - ORDER.indexOf(b.group));
    for (const { group, bucket } of groups)
      for (const { item } of bucket.slice(0, LIMITS[group])) out.push(item);
    out.push({
      key: "search:query",
      group: "Search",
      label: `Search Discover for “${trimmed}”`,
      hint: "Names, purposes and contract addresses",
      words: "",
      icon: <Search size={17} />,
      command: { type: "search", query: trimmed },
    });
    return out;
  }, [items, query, recent, address, tokens]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [active, results]);

  const run = (item: Item) => {
    if (item.group !== "Actions" && item.group !== "Search") remember(item.key);
    onClose();
    onRun(item.command);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Enter that commits an IME composition must not also run a command; Safari
    // reports such a keydown with isComposing false and keyCode 229.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    const last = results.length - 1;
    const move = (next: number) => {
      event.preventDefault();
      setActive(Math.max(0, Math.min(last, next)));
    };
    if (event.key === "ArrowDown") move(active >= last ? 0 : active + 1);
    else if (event.key === "ArrowUp") move(active <= 0 ? last : active - 1);
    else if (event.key === "PageDown") move(active + 6);
    else if (event.key === "PageUp") move(active - 6);
    else if (event.key === "Home" && !query) move(0);
    else if (event.key === "End" && !query) move(last);
    else if (event.key === "Enter" && results[active]) {
      event.preventDefault();
      run(results[active]);
    }
  };

  // Results arrive grouped in order; each run of one group becomes a labelled
  // group inside the listbox so assistive technology announces the headings.
  const groups: { group: Group; rows: ReactNode[] }[] = [];
  results.forEach((item, index) => {
    if (groups.at(-1)?.group !== item.group) groups.push({ group: item.group, rows: [] });
    groups.at(-1)!.rows.push(
      <div
        key={item.key + index}
        id={`${listId}-${index}`}
        role="option"
        aria-selected={index === active}
        className="palette-option"
        data-current={
          (item.command.type === "view" && item.command.view === view) || undefined
        }
        onMouseMove={() => active !== index && setActive(index)}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => run(item)}
      >
        <span className="palette-icon" aria-hidden="true">
          {item.icon}
        </span>
        <span className="palette-text">
          <span className="palette-label">{item.label}</span>
          <span className="palette-hint">{item.hint}</span>
        </span>
        {item.command.type === "view" && item.command.view === view && (
          <span className="palette-badge">Here</span>
        )}
        {index === active && (
          <kbd className="palette-enter" aria-hidden="true">
            ↵
          </kbd>
        )}
      </div>,
    );
  });

  const enabled = bits === null ? [] : enabledCallbacks(bits);
  const issues = bits === null || address === null ? [] : hookAddressIssues(bits, address);
  const realResults = results.filter((item) => item.group !== "Search" && item.group !== "Actions");
  // Clicking the panel's static text must not take focus out of the field.
  const keepFocus = (event: MouseEvent) => event.preventDefault();

  return (
    <Modal title="Jump to" onClose={onClose} variant="palette" initialFocus=".palette-field input">
      <div className="palette-field">
        <Search size={18} aria-hidden="true" />
        <input
          type="text"
          role="combobox"
          aria-label="Jump to a page, network, launchpad or project"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={results.length ? `${listId}-${active}` : undefined}
          aria-autocomplete="list"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="Search projects, networks, launchpads, or paste a hook address"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <kbd className="palette-esc" aria-hidden="true">
          esc
        </kbd>
        <button type="button" className="palette-close" aria-label="Close" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      {bits !== null && address && (
        <div className="palette-decode" onMouseDown={keepFocus}>
          <PermissionGlyph flags={flagsFromBits(bits)} />
          <div>
            <strong>
              {enabled.length} of 14 permission flags enabled
            </strong>
            <span>
              {enabled.length
                ? enabled.map((item) => item.name).join(" · ")
                : "No permission flags in this address."}
            </span>
            {issues.map((issue) => (
              <span key={issue} className="palette-decode-issue">
                {issue}
              </span>
            ))}
            <span className="palette-decode-note">
              Read from the address bits alone: what a hook may intercept, not what its code does or whether it is safe.
            </span>
          </div>
        </div>
      )}
      {projects.length === 0 && !address && (
        <p className="palette-note" onMouseDown={keepFocus}>
          Project names appear here once the directory has loaded. Search Discover finds any name now.
        </p>
      )}
      <div ref={listRef} id={listId} className="palette-results" role="listbox" aria-label="Results">
        {groups.map(({ group, rows }) => (
          <div key={group} role="group" aria-labelledby={`${listId}-group-${group}`}>
            <div
              id={`${listId}-group-${group}`}
              className="palette-group"
              onMouseDown={keepFocus}
            >
              {group}
            </div>
            {rows}
          </div>
        ))}
      </div>
      <p className="sr-only" role="status">
        {address
          ? `Address decoded: ${enabled.length} of 14 permission flags enabled.`
          : tokens.length
            ? `${realResults.length} match${realResults.length === 1 ? "" : "es"}`
            : ""}
      </p>
      <div className="palette-foot" aria-hidden="true" onMouseDown={keepFocus}>
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> move
        </span>
        <span>
          <kbd>↵</kbd> open
        </span>
        <span>
          <kbd>esc</kbd> close
        </span>
      </div>
    </Modal>
  );
}

function ProjectMark({ project }: { project: RadarProject }) {
  return <ProtocolLogo project={project} />;
}
