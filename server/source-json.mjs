/** Retain ordinary JSON types, but reject a nonzero token rounded to zero.
 * Amount validators cannot recover its original digits after JSON.parse.
 * Other precision/identity policies remain the consuming validator's job.
 */
export function parseJsonWithoutUnderflow(text) {
  // Underflow needs a negative exponent or hundreds of fractional leading
  // zeros. Text inside strings may trigger extra checks, never bypass them.
  // Ordinary source/cache bodies retain the native parser's inexpensive path.
  if (typeof text === "string" && !/[eE]-|0\.0{300}/.test(text))
    return JSON.parse(text);
  return JSON.parse(text, (_key, value, context) => {
    if (typeof value === "number" && value === 0) {
      if (typeof context?.source !== "string")
        throw new TypeError("Exact JSON numeric source is unavailable.");
      const significand = context.source.split(/[eE]/, 1)[0];
      if (/[1-9]/.test(significand))
        throw new SyntaxError(
          "Source contains a nonzero number below supported precision.",
        );
    }
    return value;
  });
}
