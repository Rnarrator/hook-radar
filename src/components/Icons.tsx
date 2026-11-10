import type { LucideIcon, LucideProps } from "lucide-react";
import {
  ArrowRight as ArrowRightGlyph,
  ArrowDown as ArrowDownGlyph,
  ArrowUp as ArrowUpGlyph,
  ArrowLeftRight as ArrowLeftRightGlyph,
  ChevronDown as ChevronDownGlyph,
  ChevronRight as ChevronRightGlyph,
  ChevronLeft as ChevronLeftGlyph,
  Check as CheckGlyph,
  X as XGlyph,
  Search as SearchGlyph,
  Copy as CopyGlyph,
  Download as DownloadGlyph,
  ExternalLink as ExternalLinkGlyph,
  SlidersHorizontal as FilterGlyph,
  Info as InfoGlyph,
  Network as NetworkGlyph,
  Radio as RadioGlyph,
  RefreshCw as RefreshGlyph,
  ShieldCheck as ShieldGlyph,
  Star as StarGlyph,
  CodeXml as CodeGlyph,
  Layers as LayersGlyph,
  Play as PlayGlyph,
  Pause as PauseGlyph,
  History as HistoryGlyph,
  Compass as CompassGlyph,
  ChartLine as ChartLineGlyph,
  ChartColumn as ChartColumnGlyph,
  Orbit as OrbitGlyph,
  BookOpen as BookOpenGlyph,
  Activity as ActivityGlyph,
  GitCompareArrows as GitCompareArrowsGlyph,
  Rocket as RocketGlyph,
  Command as CommandGlyph,
  Menu as MenuGlyph,
  Telescope as TelescopeGlyph,
  Crosshair as CrosshairGlyph,
  CircleAlert as CircleAlertGlyph,
  CircleCheck as CircleCheckGlyph,
  Link as LinkGlyph,
  Maximize2 as Maximize2Glyph,
  Minus as MinusGlyph,
  Plus as PlusGlyph,
  ArrowUpRight as ArrowUpRightGlyph,
  Table2 as TableGlyph,
} from "lucide-react";

// Utility symbols use Lucide's consistent optical grid. Protocol artwork and
// the Hook Radar mark are deliberately independent of the utility set.
function utility(Glyph: LucideIcon) {
  return function UtilityIcon({
    size = 16,
    strokeWidth = 1.75,
    ...props
  }: LucideProps) {
    return (
      <Glyph
        size={size}
        strokeWidth={strokeWidth}
        aria-hidden="true"
        focusable="false"
        {...props}
      />
    );
  };
}

export const ArrowRight = utility(ArrowRightGlyph);
export const ArrowDown = utility(ArrowDownGlyph);
export const ArrowUp = utility(ArrowUpGlyph);
export const ArrowLeftRight = utility(ArrowLeftRightGlyph);
export const ChevronDown = utility(ChevronDownGlyph);
export const ChevronRight = utility(ChevronRightGlyph);
export const ChevronLeft = utility(ChevronLeftGlyph);
export const Check = utility(CheckGlyph);
export const X = utility(XGlyph);
export const Search = utility(SearchGlyph);
export const Copy = utility(CopyGlyph);
export const Download = utility(DownloadGlyph);
export const ExternalLink = utility(ExternalLinkGlyph);
export const Filter = utility(FilterGlyph);
export const Info = utility(InfoGlyph);
export const Network = utility(NetworkGlyph);
export const Radio = utility(RadioGlyph);
export const RefreshCw = utility(RefreshGlyph);
export const ShieldCheck = utility(ShieldGlyph);
export const Star = utility(StarGlyph);
export const Code2 = utility(CodeGlyph);
export const Layers = utility(LayersGlyph);
export const Play = utility(PlayGlyph);
export const Pause = utility(PauseGlyph);
export const History = utility(HistoryGlyph);
export const Compass = utility(CompassGlyph);
export const ChartLine = utility(ChartLineGlyph);
export const ChartColumn = utility(ChartColumnGlyph);
export const Orbit = utility(OrbitGlyph);
export const BookOpen = utility(BookOpenGlyph);
export const Activity = utility(ActivityGlyph);
export const GitCompareArrows = utility(GitCompareArrowsGlyph);
export const Rocket = utility(RocketGlyph);
export const Command = utility(CommandGlyph);
export const Menu = utility(MenuGlyph);
export const Telescope = utility(TelescopeGlyph);
export const Crosshair = utility(CrosshairGlyph);
export const CircleAlert = utility(CircleAlertGlyph);
export const CircleCheck = utility(CircleCheckGlyph);
export const LinkIcon = utility(LinkGlyph);
export const Maximize2 = utility(Maximize2Glyph);
export const Minus = utility(MinusGlyph);
export const Plus = utility(PlusGlyph);
export const ArrowUpRight = utility(ArrowUpRightGlyph);
export const Table = utility(TableGlyph);
/** The drawn instrument that stands in for "nothing here": a dial, a
 * crosshair and one signal point, with no data in it. */
export function EmptyInstrument() {
  return (
    <svg
      className="empty-instrument"
      viewBox="0 0 96 96"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="48" cy="48" r="38" stroke="currentColor" strokeOpacity=".3" strokeWidth="1.5" />
      <circle
        cx="48"
        cy="48"
        r="24"
        stroke="currentColor"
        strokeOpacity=".22"
        strokeWidth="1.5"
        strokeDasharray="2 5"
      />
      <path
        d="M48 8v16M48 72v16M8 48h16M72 48h16"
        stroke="currentColor"
        strokeOpacity=".45"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <circle cx="48" cy="48" r="3.2" fill="var(--signal)" />
    </svg>
  );
}

/** The Hook Radar mark: a dial, a sweep and a hook whose eye is the blip.
 * Vector artwork drawn for this product; protocol logos are separate. */
export function Logo({ detail = false }: { detail?: boolean }) {
  return (
    <svg
      className="radar-logo"
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="32" cy="32" r="28" stroke="currentColor" strokeWidth="2.6" />
      {detail && (
        <circle
          cx="32"
          cy="32"
          r="17"
          stroke="currentColor"
          strokeOpacity=".26"
          strokeWidth="1.4"
        />
      )}
      <path
        className="radar-logo-sweep"
        d="M32 32V4A28 28 0 0 1 59 24Z"
        fill="var(--signal)"
        fillOpacity=".34"
      />
      <path
        d="M34 20v19.5a8 8 0 0 1-16 0V35"
        stroke="currentColor"
        strokeWidth="3.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="34" cy="16" r="3.6" fill="var(--signal)" />
    </svg>
  );
}
