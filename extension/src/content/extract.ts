import { Readability } from "@mozilla/readability";

import type { PageExtractPayload } from "../shared/types";
import { htmlToHeadingMarkdown } from "./markdown";

const CHROME_NOISE_SELECTORS = [
  "nav",
  "footer",
  "aside",
  ".md-header",
  ".md-sidebar",
  ".md-footer",
  ".md-source",
  ".headerlink",
  "button.md-clipboard",
  "[aria-hidden='true']",
].join(",");

function pruneNoise(root: Document | Element): void {
  root.querySelectorAll(CHROME_NOISE_SELECTORS).forEach((el) => el.remove());
}

function extractCurrentPage(): PageExtractPayload {
  const url = window.location.href;
  const fallbackTitle = document.title || url;

  try {
    const clone = document.cloneNode(true) as Document;
    pruneNoise(clone);
    const reader = new Readability(clone, { charThreshold: 120 });
    const article = reader.parse();

    if (article && article.content) {
      const markdown = htmlToHeadingMarkdown(article.content);
      if (markdown.length >= 40) {
        return {
          url,
          title: (article.title || fallbackTitle).trim(),
          markdown,
        };
      }
    }
  } catch {
    // Fall back to main/article/body extraction below
  }

  const root =
    document.querySelector("article") ??
    document.querySelector("main") ??
    document.body;
  const clonedRoot = root ? (root.cloneNode(true) as Element) : null;
  if (clonedRoot) {
    pruneNoise(clonedRoot);
  }
  const markdown = htmlToHeadingMarkdown(clonedRoot ? clonedRoot.innerHTML : "");

  return {
    url,
    title: fallbackTitle.trim(),
    markdown,
  };
}

// chrome.scripting.executeScript returns the value of the final expression in the injected script
extractCurrentPage();
