/** Has the visitor asked their browser to use less data? The Save-Data hint
 * (Data Saver on Android, "Lite mode" and similar) and the reduced-data media
 * query both count. Read once per page load: a change mid-visit applies to the
 * next visit, so a page never changes its mind while someone is reading it. */
export function prefersLessData(): boolean {
  try {
    const connection = (
      navigator as Navigator & { connection?: { saveData?: boolean } }
    ).connection;
    if (connection?.saveData === true) return true;
  } catch {
    // No network information: fall through to the media query.
  }
  try {
    return matchMedia("(prefers-reduced-data: reduce)").matches;
  } catch {
    return false;
  }
}
