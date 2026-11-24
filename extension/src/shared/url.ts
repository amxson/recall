/**
 * Strips URL hash fragments and trailing slashes so re-saving the same page
 * from a `#:~:text=` jump link updates the existing document rather than duplicating it.
 */
export function normalizeUrlToDocId(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    parsed.hash = "";
    const pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return `${parsed.origin}${pathname}${parsed.search}`;
  } catch {
    return rawUrl.split("#")[0].replace(/\/+$/, "");
  }
}
