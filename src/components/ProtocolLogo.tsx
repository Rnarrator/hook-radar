import { useState } from "react";
import type { RadarProject } from "../../shared/types";
import {
  getProtocolArtwork,
  protocolArtwork,
  publicAsset,
} from "../protocol-logos";
import { fallbackMark } from "../fallback-mark";
import type { ProtocolArtwork } from "../protocol-logos";

export function ProtocolLogo({
  project,
  large = false,
  eager = false,
  artwork: suppliedArtwork,
}: {
  project: Pick<RadarProject, "id" | "name" | "description" | "deployments">;
  large?: boolean;
  eager?: boolean;
  artwork?: ProtocolArtwork | null;
}) {
  const artwork =
    suppliedArtwork === undefined
      ? getProtocolArtwork(project)
      : suppliedArtwork;
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const available = artwork && failedSource !== artwork.src;
  // A server-supplied artwork carries only protocol and src; the plate belongs
  // to the shipped file, so it is looked up by src.
  const plate = available
    ? (artwork.plate ??
      Object.values(protocolArtwork).find((entry) => entry.src === artwork.src)
        ?.plate)
    : undefined;
  return (
    <span
      className={`protocol-logo${large ? " large" : ""}${available ? "" : " unavailable"}`}
      title={
        available
          ? `${artwork.protocol} · official artwork`
          : artwork
            ? `${artwork.protocol} · protocol logo unavailable`
            : `${project.name} · no verified protocol logo`
      }
      aria-hidden="true"
      data-protocol={available ? artwork.protocol : undefined}
      data-plate={plate}
    >
      {available ? (
        <img
          src={publicAsset(artwork.src)}
          alt=""
          loading={large || eager ? "eager" : "lazy"}
          decoding="async"
          draggable={false}
          onError={() => setFailedSource(artwork.src)}
        />
      ) : (
        <span className="protocol-logo-fallback">
          <svg viewBox="0 0 7 7" focusable="false" aria-hidden="true">
            {fallbackMark(project.id).map((cell) => (
              <rect
                key={`${cell.x}-${cell.y}`}
                x={cell.x + 1.09}
                y={cell.y + 1.09}
                width="0.82"
                height="0.82"
                rx="0.12"
                data-on={cell.on || undefined}
                data-accent={cell.accent || undefined}
              />
            ))}
          </svg>
        </span>
      )}
    </span>
  );
}
