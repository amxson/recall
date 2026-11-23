import { describe, expect, it } from "vitest";

import { htmlToHeadingMarkdown } from "./markdown";

describe("htmlToHeadingMarkdown", () => {
  it("preserves headings, lists, code blocks, and strips script/style noise", () => {
    const html = `
      <article>
        <style>.hidden { display: none; }</style>
        <script>console.log("ignore me")</script>
        <h1>Background Tasks</h1>
        <p>Run tasks <strong>after</strong> returning an HTTP response.</p>
        <h2>Using <code>BackgroundTasks</code></h2>
        <ul>
          <li>Import BackgroundTasks</li>
          <li>Call <code>add_task()</code></li>
        </ul>
        <pre><code>def send_email(addr: str):
    return addr</code></pre>
      </article>
    `;

    const md = htmlToHeadingMarkdown(html);
    expect(md).toContain("# Background Tasks");
    expect(md).toContain("## Using BackgroundTasks");
    expect(md).toContain("- Import BackgroundTasks");
    expect(md).toContain("def send_email(addr: str):");
    expect(md).not.toContain("ignore me");
    expect(md).not.toContain("display: none");
  });

  it("decodes common HTML entities cleanly", () => {
    const md = htmlToHeadingMarkdown("<p>FastAPI &amp; Pydantic &lt;v2&gt; &quot;models&quot;</p>");
    expect(md).toBe('FastAPI & Pydantic <v2> "models"');
  });
});
