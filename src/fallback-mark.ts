/** The mark shown where a project has no verified protocol logo: a small
 * symmetric pixel pattern generated from the project's id. It is deliberately
 * abstract, never a logo, and carries no data: the same id always draws the
 * same pattern, and nothing about the project is read from it. */

export interface FallbackCell {
  x: number;
  y: number;
  on: boolean;
  /** One or two lit cells (mirrored) carry the signal colour. */
  accent: boolean;
}

const SIZE = 5;
/** Columns 0 to 2 are chosen; columns 3 and 4 mirror columns 1 and 0. */
const MIRROR = [0, 1, 2, 1, 0] as const;
const CHOSEN = 3;

function hash(text: string, salt: number): number {
  let value = (0x811c9dc5 ^ salt) >>> 0;
  for (const character of text) {
    value ^= character.codePointAt(0)!;
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value >>> 0;
}

function bitCount(value: number): number {
  let count = 0;
  for (let rest = value; rest; rest &= rest - 1) count++;
  return count;
}

/** The 25 cells of the pattern for `seed`, row by row. */
export function fallbackMark(seed: string): FallbackCell[] {
  // A pattern that is nearly empty or nearly full reads as a smudge: draw again
  // (deterministically) a few times until it has some structure.
  let bits = 0;
  for (let attempt = 0; attempt < 8; attempt++) {
    bits = hash(seed, Math.imul(attempt, 0x9e3779b1)) & 0x7fff;
    const lit = bitCount(bits);
    if (lit >= 6 && lit <= 11) break;
  }
  const chosen = (x: number, y: number) =>
    Boolean((bits >> (y * CHOSEN + MIRROR[x])) & 1);
  const lit: { x: number; y: number }[] = [];
  for (let y = 0; y < SIZE; y++)
    for (let c = 0; c < CHOSEN; c++)
      if (chosen(c, y)) lit.push({ x: c, y });
  // Accents come from a second, independent draw over the chosen half.
  const accents = new Set<string>();
  if (lit.length) {
    const second = hash(seed, 0x2545f491);
    const first = lit[second % lit.length];
    accents.add(`${first.x},${first.y}`);
    if (lit.length > 3) {
      const other = lit[(second >>> 8) % lit.length];
      accents.add(`${other.x},${other.y}`);
    }
  }
  const cells: FallbackCell[] = [];
  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++)
      cells.push({
        x,
        y,
        on: chosen(x, y),
        accent: accents.has(`${MIRROR[x]},${y}`) && chosen(x, y),
      });
  return cells;
}
