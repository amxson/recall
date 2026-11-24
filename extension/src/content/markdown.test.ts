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

  it("strips MkDocs Material permalinks, copy buttons, nav chrome, and line-number gutters", () => {
    const mkdocsHtml = `
      <nav>Sidebar links to skip</nav>
      <article>
        <h1>CORS<a class="headerlink" href="#cors" title="Permanent link">&para;</a></h1>
        <p>Configure <code>CORSMiddleware</code> for cross-origin requests.</p>
        <h2>Wildcards ¶</h2>
        <table>
          <tr>
            <td class="linenos">1\n2\n3</td>
            <td>
              <button class="md-clipboard">Copy to clipboard</button>
              <pre><code>allow_origins = ["https://example.com"]</code></pre>
            </td>
          </tr>
        </table>
      </article>
      <footer>Copyright footer</footer>
    `;

    const md = htmlToHeadingMarkdown(mkdocsHtml);
    expect(md).toContain("# CORS");
    expect(md).toContain("## Wildcards");
    expect(md).toContain('allow_origins = ["https://example.com"]');
    expect(md).not.toContain("¶");
    expect(md).not.toContain("Copy to clipboard");
    expect(md).not.toContain("Sidebar links");
    expect(md).not.toContain("Copyright footer");
  });

  it("handles GitHub-style heading anchors and inline SVGs cleanly", () => {
    const githubHtml = `
      <article class="markdown-body">
        <h2><a href="#install"><svg viewBox="0 0 16 16"></svg></a> Installation #</h2>
        <p>Run <code>cargo test --workspace</code> to verify all crates.</p>
      </article>
    `;

    const md = htmlToHeadingMarkdown(githubHtml);
    expect(md).toContain("## Installation");
    expect(md).toContain("Run cargo test --workspace to verify all crates.");
    expect(md).not.toContain("#\n");
  });

  it("decodes common HTML entities cleanly", () => {
    const md = htmlToHeadingMarkdown("<p>FastAPI &amp; Pydantic &lt;v2&gt; &quot;models&quot;</p>");
    expect(md).toBe('FastAPI & Pydantic <v2> "models"');
  });
});
