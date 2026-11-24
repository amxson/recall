/**
 * Converts a cleaned HTML fragment (e.g. from Mozilla Readability) into compact
 * heading-preserving Markdown suitable for recall-core's heading-aware chunker.
 */
export function htmlToHeadingMarkdown(html: string): string {
  if (!html.trim()) return "";

  // Strip non-content blocks, UI buttons, nav/footer chrome, and code line-number gutters
  let s = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, "")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, "")
    .replace(/<button\b[^>]*>[\s\S]*?<\/button>/gi, "")
    .replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, "")
    .replace(/<form\b[^>]*>[\s\S]*?<\/form>/gi, "")
    .replace(/<a\b[^>]*class=["'][^"']*headerlink[^"']*["'][^>]*>[\s\S]*?<\/a>/gi, "")
    .replace(/<(?:td|div|span)\b[^>]*class=["'][^"']*(?:linenos|line-numbers|gutter)[^"']*["'][^>]*>[\s\S]*?<\/(?:td|div|span)>/gi, "");

  // Preserve headings as markdown ATX headers and strip trailing permalink glyphs (e.g. ¶ or #)
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level: string, inner: string) => {
    const hashes = "#".repeat(Number(level));
    const text = decodeEntities(stripTags(inner))
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/\s+/g, " ")
      .replace(/\s*[¶#§]\s*$/, "")
      .trim();
    return text ? `\n\n${hashes} ${text}\n\n` : "\n\n";
  });

  // Preserve preformatted code blocks
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner: string) => {
    const code = decodeEntities(stripTags(inner)).trim();
    return code ? `\n\n\`\`\`\n${code}\n\`\`\`\n\n` : "\n\n";
  });

  // Preserve list items and block breaks
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner: string) => {
    const item = decodeEntities(stripTags(inner)).replace(/\s+/g, " ").trim();
    return item ? `\n- ${item}` : "";
  });

  s = s.replace(/<(?:p|div|section|article|blockquote|tr|br)\b[^>]*\/?>/gi, "\n");
  s = s.replace(/<\/(?:p|div|section|article|blockquote|ul|ol|table)>/gi, "\n\n");

  const plain = decodeEntities(stripTags(s)).replace(/[\u200B-\u200D\uFEFF]/g, "");
  return normalizeMarkdownLines(plain);
}

function stripTags(input: string): string {
  return input.replace(/<[^>]+>/g, " ");
}

function decodeEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&para;/gi, "¶")
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

function normalizeMarkdownLines(input: string): string {
  const lines = input.split(/\r?\n/);
  const out: string[] = [];
  let inFence = false;
  let blankStreak = 0;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith("```")) {
      inFence = !inFence;
      blankStreak = 0;
      out.push(trimmed);
      continue;
    }

    if (inFence) {
      out.push(rawLine.trimEnd());
      continue;
    }

    if (!trimmed) {
      blankStreak += 1;
      if (blankStreak === 1 && out.length > 0) {
        out.push("");
      }
      continue;
    }

    blankStreak = 0;
    out.push(
      trimmed
        .replace(/\s+([.,;:!?])/g, "$1")
        .replace(/\s{2,}/g, " ")
    );
  }

  return out.join("\n").trim();
}
