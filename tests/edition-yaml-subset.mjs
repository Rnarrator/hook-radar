// A small parser for the subset of YAML the edition's workflows use. There is no
// YAML library in this project. It refuses anything it does not know (anchors,
// tags, tabs, flow maps, duplicate keys) instead of guessing. Shared by the
// workflow tests (edition-package-workflows, edition-gate); it is tested in
// edition-package-workflows.test.mjs.

export function parseYaml(source) {
  const lines = source
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((text, index) => ({ text, number: index + 1 }));
  for (const { text, number } of lines)
    if (/^\s*\t/.test(text)) throw new Error(`line ${number}: tab indentation`);
  let index = 0;
  const fail = (message) => {
    throw new Error(
      `line ${lines[Math.min(index, lines.length - 1)].number}: ${message}`,
    );
  };
  const indentOf = (text) => text.length - text.trimStart().length;
  const blank = (text) => text.trim() === "" || text.trim().startsWith("#");
  const skip = () => {
    while (index < lines.length && blank(lines[index].text)) index += 1;
  };

  function scalar(raw) {
    let text = raw.trim();
    if (text.startsWith('"')) {
      const end = text.search(/(?<!\\)"(?=\s*(?:#.*)?$)/);
      if (end <= 0) fail("unterminated double-quoted string");
      return JSON.parse(text.slice(0, end + 1));
    }
    if (text.startsWith("'")) {
      const match = text.match(/^'((?:[^']|'')*)'\s*(?:#.*)?$/);
      if (!match) fail("unterminated single-quoted string");
      return match[1].replaceAll("''", "'");
    }
    text = text.replace(/\s+#.*$/, "");
    if (/^[&*!]/.test(text))
      fail(`unsupported YAML (anchor, alias or tag): ${text}`);
    if (text === "{}") return {};
    if (text === "[]") return [];
    if (text.startsWith("{")) fail("flow mappings are not supported");
    if (text.startsWith("[")) {
      if (!text.endsWith("]") || /[[{]/.test(text.slice(1, -1)))
        fail("only flat flow sequences are supported");
      return text
        .slice(1, -1)
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
        .map(scalar);
    }
    if (text === "true") return true;
    if (text === "false") return false;
    if (text === "null" || text === "~" || text === "") return null;
    if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
    return text;
  }

  function blockScalar(header, keyIndent) {
    const chomp = header.includes("-")
      ? "strip"
      : header.includes("+")
        ? "keep"
        : "clip";
    const folded = header.startsWith(">");
    const collected = [];
    let blockIndent = null;
    while (index < lines.length) {
      const { text } = lines[index];
      if (text.trim() === "") {
        collected.push("");
        index += 1;
        continue;
      }
      const indent = indentOf(text);
      if (indent <= keyIndent) break;
      blockIndent ??= indent;
      if (indent < blockIndent) fail("block scalar indentation");
      collected.push(text.slice(blockIndent));
      index += 1;
    }
    while (collected.length && collected.at(-1) === "") collected.pop();
    const body = folded ? collected.join(" ") : collected.join("\n");
    return chomp === "strip" ? body : `${body}\n`;
  }

  const KEY = /^((?:"[^"]*"|'[^']*'|[^\s"'#][^:]*?)):(?:\s+(.*))?$/;

  function value(rest, keyIndent) {
    if (
      rest === undefined ||
      rest.trim() === "" ||
      rest.trim().startsWith("#")
    ) {
      skip();
      if (index < lines.length && indentOf(lines[index].text) > keyIndent)
        return block(keyIndent + 1);
      return null;
    }
    if (/^[|>][+-]?\s*(?:#.*)?$/.test(rest.trim()))
      return blockScalar(rest.trim(), keyIndent);
    return scalar(rest);
  }

  function mapping(indent) {
    const out = {};
    for (;;) {
      skip();
      if (index >= lines.length) break;
      const { text } = lines[index];
      const here = indentOf(text);
      if (here < indent) break;
      if (here > indent) fail("unexpected indentation");
      if (/^-(?:\s|$)/.test(text.trim()))
        fail("a sequence at the same indent as its key is not supported");
      const match = text.trim().match(KEY);
      if (!match) fail(`expected "key: value", got: ${text.trim()}`);
      const key = match[1].replace(/^(["'])(.*)\1$/, "$2");
      if (Object.hasOwn(out, key)) fail(`duplicate key ${key}`);
      index += 1;
      out[key] = value(match[2], indent);
    }
    return out;
  }

  function sequence(indent) {
    const out = [];
    for (;;) {
      skip();
      if (index >= lines.length) break;
      const { text } = lines[index];
      const here = indentOf(text);
      if (here < indent) break;
      if (here > indent) fail("unexpected indentation");
      const trimmed = text.trim();
      if (!/^-(?:\s|$)/.test(trimmed)) break;
      const content = trimmed.slice(1).trimStart();
      const column = here + (trimmed.length - content.length);
      if (content === "" || content.startsWith("#")) {
        index += 1;
        skip();
        out.push(
          index < lines.length && indentOf(lines[index].text) > indent
            ? block(indent + 1)
            : null,
        );
      } else if (KEY.test(content)) {
        lines[index] = { ...lines[index], text: " ".repeat(column) + content };
        out.push(mapping(column));
      } else {
        index += 1;
        out.push(scalar(content));
      }
    }
    return out;
  }

  function block(minIndent) {
    skip();
    if (index >= lines.length) return null;
    const indent = indentOf(lines[index].text);
    if (indent < minIndent) return null;
    return /^-(?:\s|$)/.test(lines[index].text.trim())
      ? sequence(indent)
      : mapping(indent);
  }

  const result = block(0);
  skip();
  if (index < lines.length) fail("content after the document");
  return result ?? {};
}
