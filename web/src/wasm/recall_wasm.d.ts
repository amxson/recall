/* tslint:disable */
/* eslint-disable */

export class WasmRecallIndex {
    free(): void;
    [Symbol.dispose](): void;
    static from_json(snapshot: string): WasmRecallIndex;
    list_documents_json(): string;
    constructor(embedding_dim: number);
    remove_by_url(url: string): boolean;
    remove_document(doc_id: string): boolean;
    search_hybrid_json(query: string, query_embedding: Float32Array | number[], top_k: number, rrf_k?: number | null): string;
    search_keyword_json(query: string, top_k: number): string;
    search_semantic_json(query_embedding: Float32Array | number[], top_k: number): string;
    stats_json(): string;
    to_json(): string;
    /**
     * Upserts pre-chunked passages and an optional flat `Float32Array` of embeddings
     * (`chunks.len() * embedding_dim`). Passing an empty array indexes BM25 only.
     */
    upsert_document(doc_id: string, url: string, title: string, saved_at_ms: number, chunks_json: string, flat_embeddings: Float32Array | number[]): number;
}

export function chunk_text_json(text: string, strategy: string): string;

export function core_version(): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_wasmrecallindex_free: (a: number, b: number) => void;
    readonly chunk_text_json: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly core_version: () => [number, number];
    readonly wasmrecallindex_from_json: (a: number, b: number) => [number, number, number];
    readonly wasmrecallindex_list_documents_json: (a: number) => [number, number, number, number];
    readonly wasmrecallindex_new: (a: number) => [number, number, number];
    readonly wasmrecallindex_remove_by_url: (a: number, b: number, c: number) => number;
    readonly wasmrecallindex_remove_document: (a: number, b: number, c: number) => number;
    readonly wasmrecallindex_search_hybrid_json: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly wasmrecallindex_search_keyword_json: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly wasmrecallindex_search_semantic_json: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly wasmrecallindex_stats_json: (a: number) => [number, number, number, number];
    readonly wasmrecallindex_to_json: (a: number) => [number, number, number, number];
    readonly wasmrecallindex_upsert_document: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number) => [number, number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
