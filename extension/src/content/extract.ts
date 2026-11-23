import { Readability } from "@mozilla/readability";

import type { PageExtractPayload } from "../shared/types";
import { htmlToHeadingMarkdown } from "./markdown";

function extractCurrentPage(): PageExtractPayload {
  const url = window.location.href;
  const fallbackTitle = document.title || url;

  try {
    const clone = document.cloneNode(true) as Document;
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
  const markdown = htmlToHeadingMarkdown(root ? root.innerHTML : "");

  return {
    url,
    title: fallbackTitle.trim(),
    markdown,
  };
}

// chrome.scripting.executeScript returns the value of the final expression in the injected script
extractCurrentPage();
