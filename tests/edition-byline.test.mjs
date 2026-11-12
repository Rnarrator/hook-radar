// The maker's line in the footer: "Built by @0x_narrator", the handle linking to
// their X profile. It is a plain span (the footer's plain items are pinned: no
// paragraph), it opens safely in a new tab, and it is not part of the provider
// credits, so it stays whatever the credits switch says.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const footer = (
  await readFile(
    new URL("../src/components/SiteFooter.tsx", import.meta.url),
    "utf8",
  )
).replace(/\r\n/g, "\n");
const css = (
  await readFile(new URL("../src/design/shell.css", import.meta.url), "utf8")
).replace(/\r\n/g, "\n");

test("the footer's maker line links to the owner's X profile and opens safely", () => {
  assert.match(footer, /<span className="footer-byline">/);
  assert.match(footer, /Built by/);
  const link = footer.match(
    /<a\s+href="https:\/\/x\.com\/0x_narrator"\s+target="_blank"\s+rel="noopener noreferrer"\s*>\s*@0x_narrator\s*<\/a>/,
  );
  assert.ok(link, "the handle is a link to https://x.com/0x_narrator");
});

test("the maker line is a span outside the credits, and the footer has no other new paragraph", () => {
  const at = footer.indexOf('className="footer-byline"');
  const credits = footer.indexOf("{FOOTER_CREDITS");
  assert.ok(at > 0 && credits > 0 && at < credits, "it stands before, not inside, the credits blocks");
  assert.doesNotMatch(footer, /STATIC_EDITION && </, "not an edition-only credit");
  // The footer's only paragraph is the credits' notices line (credits switch on).
  assert.equal((footer.match(/<p\b/g) || []).length, 1);
});

test("the maker line is small and quiet, on a row of its own, and its link is underlined", () => {
  assert.match(css, /\.footer > \.footer-byline \{[^}]*flex: 1 1 100%;/);
  assert.match(css, /\.footer > \.footer-byline \{[^}]*font-size: var\(--fs-micro\);/);
  assert.match(css, /\.footer \.footer-byline a \{[^}]*text-decoration: underline;/);
});
