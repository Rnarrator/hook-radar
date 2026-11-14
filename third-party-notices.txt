# Third-party notices

Runtime UI dependencies: React/React DOM (MIT), Lucide React 1.59.0 (ISC, with Feather-derived icons under MIT) and three.js 0.186.1 (MIT, loaded on demand for the masthead radar instrument). The Hook Radar mark, favicon, app icons and social card are original works made for this project. Protocol artwork is separate from the Lucide utility icon set.

Protocol logos belong to their owners. They are unchanged original artwork from the respective official websites and repositories, keep their native colours and are not licensed with this project's code. The site shows them only to identify projects: display does not imply endorsement, sponsorship or verification of contract ownership. Asset URLs, identity evidence, retrieval dates and SHA-256 hashes are recorded in `public/protocols/sources.json` in the repository. Where there is no verified logo the site shows neutral artwork, never an invented protocol mark.

Development/testing tools: Vite and its React plugin (MIT), TypeScript (Apache-2.0), Playwright (Apache-2.0), axe-core and its Playwright integration (MPL-2.0), Prettier (MIT), and their lockfile-resolved dependencies. Package license metadata is available through the installed package manifests.

Self-hosted fonts (SIL Open Font License 1.1): Geist and Geist Mono (Copyright 2024 The Geist Project Authors), served from `public/fonts/observatory/` as Latin and Latin-extended WOFF2 subsets with their license texts, and Press Start 2P (display type: titles, wordmark and figures), served from `public/fonts/PressStart2P-Regular.ttf` with its notice. IBM Plex Mono, used by an earlier design of the interface, is no longer referenced by it; its files and license notice remain in the repository's `public/fonts/` folder.

Public data comes from these services, read by a scheduled job that names itself in its requests, waits between its requests to the same service and stops asking a service that refuses it: DEX Screener (prices, volume and liquidity of the pools), GeckoTerminal (finding pools, and a fallback when DEX Screener does not return one), the v4.xyz indexer (hook and pool identities), the Uniswap hooklist (the registry of named hooks), Frontier (deployment information, and the market figures of the pools of its own hooks) and Goldsky (Frontier AMM index) (the public index of those pools that Frontier's configuration names). Each snapshot records which of them supplied data and when, and each keeps its own terms. DEX Screener, GeckoTerminal, the v4.xyz indexer, Uniswap, Frontier, Goldsky and the project names shown on the site identify their own sources or directory entries and do not imply endorsement of Hook Radar.

## Lucide / Feather utility icons

ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

---

The following Lucide icons are derived from the Feather project:

airplay, alert-circle, alert-octagon, alert-triangle, aperture, arrow-down-circle, arrow-down-left, arrow-down-right, arrow-down, arrow-left-circle, arrow-left, arrow-right-circle, arrow-right, arrow-up-circle, arrow-up-left, arrow-up-right, arrow-up, at-sign, calendar, cast, check, chevron-down, chevron-left, chevron-right, chevron-up, chevrons-down, chevrons-left, chevrons-right, chevrons-up, circle, clipboard, clock, code, columns, command, compass, corner-down-left, corner-down-right, corner-left-down, corner-left-up, corner-right-down, corner-right-up, corner-up-left, corner-up-right, crosshair, database, divide-circle, divide-square, dollar-sign, download, external-link, feather, frown, hash, headphones, help-circle, info, italic, key, layout, life-buoy, link-2, link, loader, lock, log-in, log-out, maximize, meh, minimize, minimize-2, minus-circle, minus-square, minus, monitor, moon, more-horizontal, more-vertical, move, music, navigation-2, navigation, octagon, pause-circle, percent, plus-circle, plus-square, plus, power, radio, rss, search, server, share, shopping-bag, sidebar, smartphone, smile, square, table-2, tablet, target, terminal, trash-2, trash, triangle, tv, type, upload, x-circle, x-octagon, x-square, x, zoom-in, zoom-out

The MIT License (MIT) (for the icons listed above)

Copyright (c) 2013-present Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
