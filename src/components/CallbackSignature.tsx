import type { RadarProject } from "../../shared/types";
import { COMPARISON_CALLBACKS, callbackSignature } from "../comparison";
import { PermissionGlyph } from "./PermissionGlyph";

/** A project's callback permissions at a glance: the fingerprint with a cell
 * filled to the share of its classified hooks that enable that callback, and a
 * one-line reading. The numbers come from the same declarations as the
 * callback table; a callback no hook reports stays dashed, never off. */
export function CallbackSignature({
  project,
  className = "",
}: {
  project: RadarProject;
  className?: string;
}) {
  const signature = callbackSignature(project);
  const reported = COMPARISON_CALLBACKS.length - signature.unreported;
  const label = reported
    ? `Callback signature for ${project.name}: ${signature.all} enabled by every classified hook, ${signature.some} by some, ${signature.none} by none, ${signature.unreported} not reported`
    : `Callback signature for ${project.name}: no callback permissions reported`;
  return (
    <div className={`callback-signature ${className}`.trim()}>
      <PermissionGlyph shares={signature.shares} label={label} />
      <small>
        {reported
          ? `${signature.all} on every hook · ${signature.some} on some`
          : "Not reported"}
      </small>
    </div>
  );
}
