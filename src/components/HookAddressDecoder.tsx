import { useId, useMemo, useState } from "react";
import { launchpadRegistry } from "../../shared/launchpad-registry";
import {
  enabledCallbacks,
  flagsFromBits,
  hookAddressIssues,
  hookPermissionBits,
  parseHookAddress,
} from "../hook-permissions";
import { PermissionGlyph } from "./PermissionGlyph";
import { Info } from "./Icons";
import "./hook-address-decoder.css";

interface Example {
  platform: string;
  hook: string;
  address: string;
  callbacks: number;
}

/** Real hooks from the launchpad registry, picked to show different shapes:
 * the fewest callbacks, a middle case and the most. */
function registryExamples(): Example[] {
  const all: Example[] = [];
  const seen = new Set<string>();
  for (const record of launchpadRegistry)
    for (const path of record.paths)
      for (const hook of path.hooks) {
        if (seen.has(hook.address)) continue;
        seen.add(hook.address);
        all.push({
          platform: record.name,
          hook: hook.name,
          address: hook.address,
          callbacks: enabledCallbacks(hook.permissions).length,
        });
      }
  const withCallbacks = all
    .filter((item) => item.callbacks > 0)
    .sort((a, b) => a.callbacks - b.callbacks || a.address.localeCompare(b.address));
  if (withCallbacks.length < 3) return withCallbacks;
  const picks = [
    withCallbacks[0],
    withCallbacks[Math.floor(withCallbacks.length / 2)],
    withCallbacks[withCallbacks.length - 1],
  ];
  // One example per platform, so the three buttons read as different things.
  return picks.filter(
    (item, index) =>
      picks.findIndex((other) => other.platform === item.platform) === index,
  );
}

const binary = (bits: number) => {
  const text = bits.toString(2).padStart(14, "0");
  return `${text.slice(0, 2)} ${text.slice(2, 6)} ${text.slice(6, 10)} ${text.slice(10)}`;
};

/** Reads the 14 permission bits out of a hook address, locally: nothing typed
 * here is sent anywhere. */
export function HookAddressDecoder() {
  const [value, setValue] = useState("");
  // A half-typed address is not an error yet: the message waits for a stray
  // character, a full-length or overlong entry, or the person leaving the field.
  const [left, setLeft] = useState(false);
  const inputId = useId();
  const noteId = useId();
  const examples = useMemo(registryExamples, []);
  const address = parseHookAddress(value);
  const bits = address ? hookPermissionBits(address) : null;
  const enabled = bits === null ? [] : enabledCallbacks(bits);
  const issues =
    bits === null || address === null ? [] : hookAddressIssues(bits, address);
  const typed = value.trim();
  const invalid =
    typed !== "" &&
    address === null &&
    (left || typed.length >= 42 || /[^0-9a-fA-F]/.test(typed.replace(/^0x/, "")));
  return (
    <section
      className="learn-decoder"
      aria-labelledby="learn-decoder-heading"
      data-testid="hook-address-decoder"
    >
      <div className="learn-decoder-copy">
        <span className="learn-kicker">04 · Read an address</span>
        <h2 id="learn-decoder-heading">An address that spells its powers.</h2>
        <p>
          A v4 hook does not register what it wants to do. Its permissions are
          the last 14 bits of its own address, which is why hook builders mine
          for a matching address before they deploy. Paste one to read it. The
          decoding happens in your browser; nothing is sent anywhere.
        </p>
        <label className="learn-decoder-field" htmlFor={inputId}>
          <span>Hook address</span>
          <input
            id={inputId}
            type="text"
            inputMode="text"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder="0x…"
            value={value}
            aria-invalid={invalid || undefined}
            aria-describedby={noteId}
            onChange={(event) => {
              setValue(event.target.value);
              if (event.target.value.trim() === "") setLeft(false);
            }}
            onBlur={() => setLeft(true)}
          />
        </label>
        <p
          id={noteId}
          className="learn-decoder-note"
          data-invalid={invalid || undefined}
        >
          {invalid
            ? "Enter an address of 0x followed by 40 hexadecimal characters."
            : "Any 20-byte address has these bits; only an address that PoolManager accepts is a usable hook."}
        </p>
        {examples.length > 0 && (
          <div className="learn-decoder-examples">
            <span className="kicker">Or try a hook from the launchpad registry</span>
            <div>
              {examples.map((item) => (
                <button
                  key={item.address}
                  type="button"
                  className="control"
                  onClick={() => setValue(item.address)}
                >
                  {item.platform}
                  <small>
                    {item.callbacks} flag{item.callbacks === 1 ? "" : "s"}
                  </small>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <p className="sr-only" role="status">
        {bits === null
          ? ""
          : `${enabled.length} of 14 permission flags enabled in this address.`}
      </p>
      <div className="learn-decoder-plate">
        {bits === null || address === null ? (
          <p className="learn-decoder-empty">
            <PermissionGlyph flags={{}} size="large" />
            <span>The fingerprint appears here once there is an address to read.</span>
          </p>
        ) : (
          <>
            <p className="learn-decoder-address">
              <code>
                <span>{address.slice(0, -4)}</span>
                <mark>{address.slice(-4)}</mark>
              </code>
            </p>
            <p className="learn-decoder-bits">
              <span className="kicker">Low 14 bits</span>
              <code>{binary(bits)}</code>
              <span>
                = {enabled.length} of 14 permission flags
              </span>
            </p>
            <PermissionGlyph flags={flagsFromBits(bits)} size="large" />
            {enabled.length > 0 && (
              <ul className="learn-decoder-list">
                {enabled.map((item) => (
                  <li key={item.name}>
                    <code>{item.name}</code>
                    <span>{item.summary}</span>
                  </li>
                ))}
              </ul>
            )}
            {issues.map((issue) => (
              <p key={issue} className="learn-decoder-issue">
                <Info size={15} aria-hidden="true" />
                {issue}
              </p>
            ))}
            <p className="learn-decoder-foot">
              These bits show what a hook is allowed to intercept, not what its
              code does or whether it is safe.
            </p>
          </>
        )}
      </div>
    </section>
  );
}
