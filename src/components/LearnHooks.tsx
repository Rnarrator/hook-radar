import { useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import {
  ArrowLeftRight,
  ArrowRight,
  ChevronDown,
  ExternalLink,
  Filter,
  Layers,
  Network,
} from "./Icons";
import { HookAddressDecoder } from "./HookAddressDecoder";
import { SOURCES_DIALOG } from "../edition";
import "./learn-hooks.css";

const operations = {
  swap: {
    label: "Swap",
    before: "beforeSwap",
    core: "swap",
    coreLabel: "Exchange tokens",
    after: "afterSwap",
    beforeDetail: "Apply rules before a trade.",
    afterDetail: "Respond to the swap result.",
  },
  liquidity: {
    label: "Add liquidity",
    before: "beforeAddLiquidity",
    core: "modifyLiquidity",
    coreLabel: "Add liquidity to a position",
    after: "afterAddLiquidity",
    beforeDetail: "Check or prepare a deposit.",
    afterDetail: "Respond to the liquidity change.",
  },
  initialize: {
    label: "Create pool",
    before: "beforeInitialize",
    core: "initialize",
    coreLabel: "Initialize the pool",
    after: "afterInitialize",
    beforeDetail: "Check the pool configuration.",
    afterDetail: "Respond to pool creation.",
  },
} as const;

type Operation = keyof typeof operations;
type Stage = "before" | "core" | "after";
const stages: Stage[] = ["before", "core", "after"];

const useCases = [
  {
    category: "Fees",
    name: "Fees that adapt",
    detail:
      "Dynamic liquidity provider (LP) fees can change between swaps or for each swap. Eligibility is fixed at pool creation; protocol and hook fees are separate. Dynamic does not mean lower.",
    action: "Explore fee hooks",
    Icon: Filter,
  },
  {
    category: "Orders",
    name: "More ways to trade",
    detail:
      "Builders can implement limit orders or other execution strategies around pool operations. Supported order types and execution guarantees vary by protocol.",
    action: "Explore order hooks",
    Icon: ArrowLeftRight,
  },
  {
    category: "Liquidity",
    name: "Programmable liquidity",
    detail:
      "Hook logic can coordinate liquidity strategies, track position changes or attach incentives. A strategy’s rules matter as much as the pool it uses.",
    action: "Explore liquidity hooks",
    Icon: Layers,
  },
  {
    category: "Launches",
    name: "Custom market launches",
    detail:
      "Launch protocols can use hooks to enforce trading rules or fee schedules when a token’s market opens. Each launch design has its own constraints.",
    action: "Explore launch hooks",
    Icon: Network,
  },
] as const;

const documentation = [
  {
    title: "Hooks explained",
    description: "Callbacks and pool configuration",
    href: "https://developers.uniswap.org/docs/protocols/v4/concepts/hooks",
  },
  {
    title: "Inside v4",
    description: "PoolManager and shared architecture",
    href: "https://developers.uniswap.org/docs/protocols/v4/concepts/architecture",
  },
  {
    title: "Build your first hook",
    description: "A practical developer walkthrough",
    href: "https://developers.uniswap.org/docs/protocols/v4/guides/hooks/your-first-hook",
  },
  {
    title: "Hook security",
    description: "What to assess in an implementation",
    href: "https://developers.uniswap.org/docs/protocols/v4/security",
  },
] as const;

export function LearnHooks({
  onExplore,
}: {
  onExplore: (category?: string) => void;
}) {
  const [operation, setOperation] = useState<Operation>("swap");
  const [stage, setStage] = useState<Stage>("before");
  const stageButtons = useRef<Record<Stage, HTMLButtonElement | null>>({
    before: null,
    core: null,
    after: null,
  });
  const selected = operations[operation];
  const stageCopy: Record<
    Stage,
    { step: string; lane: string; title: string; code: string; text: string }
  > = {
    before: {
      step: "01",
      lane: "Hook contract",
      title: "Before callback",
      code: selected.before,
      text: selected.beforeDetail,
    },
    core: {
      step: "02",
      lane: "PoolManager",
      title: "PoolManager",
      code: selected.core,
      text: selected.coreLabel,
    },
    after: {
      step: "03",
      lane: "Hook contract",
      title: "After callback",
      code: selected.after,
      text: selected.afterDetail,
    },
  };
  const active = stageCopy[stage];
  const moveStage = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = stages.indexOf(stage);
    const next =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? stages[Math.min(stages.length - 1, index + 1)]
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? stages[Math.max(0, index - 1)]
          : event.key === "Home"
            ? stages[0]
            : event.key === "End"
              ? stages[stages.length - 1]
              : null;
    if (!next) return;
    event.preventDefault();
    setStage(next);
    stageButtons.current[next]?.focus();
  };

  return (
    <article className="learn-page" data-testid="learn-page">
      <div className="learn-introduction">
        <div className="learn-intro-copy">
          <span className="learn-kicker">A field guide · Uniswap v4</span>
          <p className="learn-lead">
            A hook is a small program that adds a custom feature to a Uniswap v4
            pool, such as a different fee, a limit order or a token launch.
            Builders write hooks; anyone can trade in a pool that uses one.
          </p>
          <button
            type="button"
            className="primary-button learn-primary"
            onClick={() => onExplore()}
          >
            Explore hooks <ArrowRight size={17} />
          </button>
        </div>
        <dl className="learn-core-facts" aria-label="Four words to know">
          <div>
            <dt>Pool</dt>
            <dd>
              Where two tokens are traded. People deposit tokens and earn a
              fee from each trade.
            </dd>
          </div>
          <div>
            <dt>Hook</dt>
            <dd>
              An optional add-on to a pool. It can change the fee, add rules or
              react when someone trades.
            </dd>
          </div>
          <div>
            <dt>Swap</dt>
            <dd>One trade: you give one token and get another.</dd>
          </div>
          <div>
            <dt>Liquidity</dt>
            <dd>The tokens sitting in a pool that make trading possible.</dd>
          </div>
        </dl>
      </div>

      <section
        className="learn-lifecycle"
        aria-labelledby="learn-lifecycle-heading"
      >
        <div className="learn-section-heading">
          <div>
            <span className="learn-kicker">01 · How it works</span>
            <h2 id="learn-lifecycle-heading">Before. Pool operation. After.</h2>
          </div>
          <div
            className="learn-operation-switch segmented"
            role="group"
            aria-label="Pool operation"
          >
            {(Object.keys(operations) as Operation[]).map((key) => (
              <button
                type="button"
                key={key}
                aria-pressed={operation === key}
                aria-controls="learn-hook-lifecycle"
                onClick={() => setOperation(key)}
              >
                {operations[key].label}
              </button>
            ))}
          </div>
        </div>
        <p className="learn-section-intro">
          Every v4 pool shares one contract, the PoolManager, which calls a hook
          at set moments called callbacks. A hook is optional, and one hook can
          serve many pools. Pick an operation to see where a hook’s own logic
          can run.
        </p>
        <section
          id="learn-hook-lifecycle"
          className="learn-flow"
          aria-label="Hook lifecycle"
          data-operation={operation}
          data-stage={stage}
        >
          <div className="learn-flow-plate">
            <span className="learn-flow-caption" aria-hidden="true">
              Illustration · callback order
            </span>
            <div className="learn-lanes" aria-hidden="true">
              <span className="learn-lane learn-lane-hook">Hook contract</span>
              <span className="learn-lane learn-lane-core">PoolManager</span>
            </div>
            <svg
              className="learn-flow-path"
              viewBox="0 0 1000 200"
              preserveAspectRatio="none"
              aria-hidden="true"
              focusable="false"
            >
              <line
                className="learn-lane-guide"
                x1="0"
                x2="1000"
                y1="50"
                y2="50"
              />
              <line
                className="learn-lane-guide"
                x1="0"
                x2="1000"
                y1="150"
                y2="150"
              />
              <path
                className="learn-flow-segment"
                data-segment="entry"
                d="M0 150 H130 C165 150 165 50 200 50 H313"
              />
              <path
                className="learn-flow-segment"
                data-segment="before"
                d="M313 50 H416 C446 50 446 150 476 150 H580"
              />
              <path
                className="learn-flow-segment"
                data-segment="core"
                d="M580 150 H683 C713 150 713 50 743 50 H847"
              />
              <path
                className="learn-flow-segment"
                data-segment="after"
                d="M847 50 H930 C965 50 965 150 1000 150"
              />
            </svg>
            <ol className="learn-flow-steps">
              {stages.map((key) => {
                const copy = stageCopy[key];
                return (
                  <li
                    key={key}
                    className={`learn-flow-step ${key === "core" ? "learn-flow-core" : "learn-flow-hook"}`}
                  >
                    <button
                      type="button"
                      ref={(element) => {
                        stageButtons.current[key] = element;
                      }}
                      aria-pressed={stage === key}
                      onClick={() => setStage(key)}
                      onKeyDown={moveStage}
                    >
                      <span className="learn-flow-label">
                        <span aria-hidden="true">{copy.step}</span> {copy.title}
                      </span>
                      <code>{copy.code}</code>
                      <span className="learn-flow-text">{copy.text}</span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </div>
          <div
            className="learn-stage-detail"
            id="learn-stage-detail"
            aria-live="polite"
          >
            <span className="learn-kicker">
              Step {active.step} of 03 · {active.lane}
            </span>
            <p>
              <code>{active.code}</code> {active.text}
            </p>
            <p className="learn-stage-note">
              {stage === "core"
                ? "Performed by the shared PoolManager, the contract that holds pool state and coordinates operations."
                : "Only called when the hook’s permissions enable this callback."}
            </p>
          </div>
          <p className="learn-flow-note" aria-live="polite" aria-atomic="true">
            <strong>{selected.label} illustration.</strong> Only callbacks
            enabled by the hook’s permissions are called. A hook can use either,
            both or neither of these callbacks.
          </p>
        </section>
        <p className="learn-flow-footnote">
          Hooks also support removing liquidity and donations. Custom accounting
          can change token amounts or replace the default swap calculation. This
          diagram illustrates callback order, not a transaction simulation.
        </p>
      </section>

      <section
        className="learn-usecases"
        aria-labelledby="learn-usecases-heading"
      >
        <div className="learn-section-heading">
          <div>
            <span className="learn-kicker">02 · What becomes possible</span>
            <h2 id="learn-usecases-heading">One interface. Different ideas.</h2>
          </div>
          <p>Explore the projects putting hooks to work.</p>
        </div>
        <div className="learn-usecase-grid">
          {useCases.map(({ category, name, detail, action, Icon }) => (
            <div
              className="learn-usecase"
              key={category}
              data-category={category}
            >
              <div className="learn-usecase-title">
                <span className="learn-usecase-icon" aria-hidden="true">
                  <Icon size={18} />
                </span>
                <span className="learn-usecase-category">{category}</span>
              </div>
              <h3>{name}</h3>
              <p>{detail}</p>
              <button type="button" onClick={() => onExplore(category)}>
                {action} <ArrowRight size={16} />
              </button>
            </div>
          ))}
        </div>
      </section>

      <section
        className="learn-reading"
        aria-labelledby="learn-reading-heading"
      >
        <div>
          <span className="learn-kicker">03 · Read the radar</span>
          <h2 id="learn-reading-heading">Know what you’re comparing.</h2>
          <p>
            A pool, a hook and a project describe different things. Start with a
            project, then inspect its contracts and pools on each network.
          </p>
        </div>
        <div>
          <dl className="learn-definitions">
            <div>
              <dt>Pool</dt>
              <dd>A market with its own configuration and liquidity.</dd>
            </div>
            <div>
              <dt>Hook</dt>
              <dd>The contract that supplies custom pool behavior.</dd>
            </div>
            <div>
              <dt>Project</dt>
              <dd>
                A directory grouping for a protocol, potentially spanning
                multiple hooks and networks.
              </dd>
            </div>
          </dl>
          <p className="learn-data-note">
            <strong>Check the scope and timestamp.</strong> Discovered pools and
            pools with fresh pricing are different sets. Missing or stale
            measurements do not mean zero activity.{" "}
            {SOURCES_DIALOG
              ? "Use data details to understand what each figure covers."
              : "Read the scope label beside a figure to see what it covers."}
          </p>
        </div>
      </section>

      <HookAddressDecoder />

      <section className="learn-faq" aria-labelledby="learn-faq-heading">
        <div className="learn-section-heading">
          <div>
            <span className="learn-kicker">
              05 · A few important distinctions
            </span>
            <h2 id="learn-faq-heading">Before you go deeper.</h2>
          </div>
        </div>
        <div className="learn-faq-list">
          <details>
            <summary>
              Can a pool switch to a different hook?
              <ChevronDown size={18} />
            </summary>
            <p>
              No. The hook address is part of the pool’s identity, its PoolKey.
              Choosing another address creates a different pool. That does not
              make a hook’s own logic immutable: inspect any upgrade or admin
              controls.
            </p>
          </details>
          <details>
            <summary>
              Are hooks required for every pool?
              <ChevronDown size={18} />
            </summary>
            <p>
              No. A v4 pool can operate without a hook. For pools that use one,
              callback permissions determine which interaction points are
              enabled, not what the underlying code guarantees.
            </p>
          </details>
          <details>
            <summary>
              Are callback flags the same as callbacks?
              <ChevronDown size={18} />
            </summary>
            <p>
              v4 has 10 lifecycle callbacks: five before-and-after pairs. Four
              additional permission flags allow supported callbacks to adjust
              token amounts. That makes 14 flags, not 14 callbacks. See the{" "}
              <a
                href="https://github.com/Uniswap/v4-core/blob/main/src/libraries/Hooks.sol"
                target="_blank"
                rel="noopener noreferrer"
              >
                official permission definitions
                <ExternalLink size={13} />
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
              .
            </p>
          </details>
          <details>
            <summary>
              What about extensions inside a protocol?
              <ChevronDown size={18} />
            </summary>
            <p>
              A protocol may route its hook through extensions or other
              contracts. Those are part of that protocol’s design, not extra
              native hook slots in a v4 pool. Review the extension logic and its
              controls too.
            </p>
          </details>
          <details>
            <summary>
              Does a verified contract mean it is safe?
              <ChevronDown size={18} />
            </summary>
            <p>
              Source verification makes code inspectable; it is not an audit.
              Callback flags are not a safety rating, and audits of v4 core do
              not automatically cover third-party hooks. Check hook-specific
              reviews, permissions and external dependencies before using a
              protocol.
            </p>
          </details>
        </div>
      </section>

      <footer
        className="learn-resources"
        aria-labelledby="learn-resources-heading"
      >
        <div className="learn-section-heading">
          <div>
            <span className="learn-kicker">From the source</span>
            <h2 id="learn-resources-heading">Keep learning with Uniswap.</h2>
          </div>
          <span className="learn-docs-label">Official documentation</span>
        </div>
        <div className="learn-resource-grid">
          {documentation.map((item) => (
            <a
              key={item.href}
              href={item.href}
              target="_blank"
              rel="noopener noreferrer"
            >
              <span>
                <strong>{item.title}</strong>
                <span>{item.description}</span>
              </span>
              <ExternalLink size={17} />
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          ))}
        </div>
      </footer>
    </article>
  );
}
