import type { HtmlTagDescriptor } from "vite";

/** Only this explicitly public setting is exposed to the built document. */
export function publicOrigin(value: string | undefined): string | null {
  if (value === undefined || value === "") return null;
  if (value !== value.trim() || /[\u0000-\u0020\u007f<>"'\\]/.test(value))
    throw new Error(
      "RADAR_PUBLIC_ORIGIN must be a HTTPS origin without whitespace or credentials",
    );
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("RADAR_PUBLIC_ORIGIN must be a valid HTTPS origin");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(
      "RADAR_PUBLIC_ORIGIN must be a HTTPS origin without a path, query, fragment or credentials",
    );
  return url.origin;
}

export function publicMetadata(value: string | undefined): HtmlTagDescriptor[] {
  const origin = publicOrigin(value);
  const image = `${origin ?? ""}/social-card.png`;
  const tags: HtmlTagDescriptor[] = [
    { tag: "meta", attrs: { property: "og:image", content: image } },
    { tag: "meta", attrs: { property: "og:image:width", content: "1200" } },
    { tag: "meta", attrs: { property: "og:image:height", content: "630" } },
    { tag: "meta", attrs: { property: "og:image:type", content: "image/png" } },
    {
      tag: "meta",
      attrs: {
        property: "og:image:alt",
        content: "Hook Radar — explore Uniswap v4 hooks, pools and protocols",
      },
    },
    { tag: "meta", attrs: { name: "twitter:image", content: image } },
    {
      tag: "meta",
      attrs: {
        name: "twitter:image:alt",
        content: "Hook Radar — explore Uniswap v4 hooks, pools and protocols",
      },
    },
  ];
  if (origin)
    tags.push(
      { tag: "link", attrs: { rel: "canonical", href: `${origin}/` } },
      { tag: "meta", attrs: { property: "og:url", content: `${origin}/` } },
    );
  return tags.map((tag) => ({ ...tag, injectTo: "head" }));
}
