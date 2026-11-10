/** A review date as a short day ("Oct 23, 2026"); the stored value is a UTC date. */
export function reviewDate(value: string | null | undefined): string {
  const time = value ? Date.parse(value) : NaN;
  return Number.isFinite(time)
    ? new Date(time).toLocaleDateString(undefined, {
        dateStyle: "medium",
        timeZone: "UTC",
      })
    : (value ?? "");
}
