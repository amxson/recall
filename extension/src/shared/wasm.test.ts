import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { initSync } from "../wasm/recall_wasm";
import { packEmbeddings } from "../offscreen/embedder";
import { chunkText, RecallEngine } from "./wasm";

beforeAll(() => {
  const wasmPath = resolve(__dirname, "..", "wasm", "recall_wasm_bg.wasm");
  initSync({ module: readFileSync(wasmPath) });
});

describe("RecallEngine WASM wrapper", () => {
  it("chunks markdown, indexes hybrid vectors, and roundtrips snapshots", () => {
    const chunks = chunkText(
      "# Background Tasks\n\nSend email notifications after returning the HTTP response.\n\n## Dependency Injection\n\nBackgroundTasks also works inside dependencies.",
      "heading"
    );
    expect(chunks.length).toBe(2);
    expect(chunks[0].heading).toBe("Background Tasks");

    const engine = RecallEngine.create(3);
    const flat = packEmbeddings(
      [new Float32Array([0.9, 0.1, 0.0]), new Float32Array([0.2, 0.8, 0.0])],
      3
    );

    const inserted = engine.upsertDocument(
      "background-tasks",
      "https://fastapi.tiangolo.com/tutorial/background-tasks/",
      "Background Tasks",
      1_700_000_000_000,
      chunks,
      flat
    );
    expect(inserted).toBe(2);

    const hits = engine.searchHybrid("email after response", new Float32Array([0.95, 0.05, 0.0]), 2);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].doc_id).toBe("background-tasks");
    expect(hits[0].jump_url).toContain("#:~:text=");

    const snapshot = engine.toSnapshot();
    engine.free();

    const restored = RecallEngine.fromSnapshot(snapshot);
    expect(restored.stats().chunk_count).toBe(2);
    expect(restored.listDocuments()[0].doc_id).toBe("background-tasks");
    restored.free();
  });

  it("rejects mismatched dimensions in packEmbeddings", () => {
    expect(() =>
      packEmbeddings([new Float32Array([1, 2, 3]), new Float32Array([1, 2])], 3)
    ).toThrow(/length mismatch/);
  });
});
