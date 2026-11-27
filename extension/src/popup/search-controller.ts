import type { SearchMode, SearchResponse } from "../shared/types";

export const EMPTY_SEARCH_RESPONSE: SearchResponse = {
  results: [],
  embed_ms: 0,
  search_ms: 0,
  total_ms: 0,
};

export interface SearchControllerCallbacks {
  execute: (query: string, mode: SearchMode) => Promise<SearchResponse>;
  onSearching: () => void;
  onResults: (resp: SearchResponse, query: string) => void;
  onError: (message: string) => void;
}

/**
 * Coordinates popup search requests with monotonic sequence IDs so clearing
 * the input or typing a newer query always invalidates earlier in-flight hits.
 */
export class SearchController {
  private seq = 0;

  constructor(private readonly callbacks: SearchControllerCallbacks) {}

  invalidate(): void {
    this.seq += 1;
  }

  clear(): void {
    this.seq += 1;
    this.callbacks.onResults(EMPTY_SEARCH_RESPONSE, "");
  }

  async run(query: string, mode: SearchMode): Promise<void> {
    const seq = ++this.seq;
    if (!query.trim()) {
      this.callbacks.onResults(EMPTY_SEARCH_RESPONSE, "");
      return;
    }

    this.callbacks.onSearching();
    try {
      const resp = await this.callbacks.execute(query, mode);
      if (seq !== this.seq) return;
      this.callbacks.onResults(resp, query);
    } catch (err) {
      if (seq !== this.seq) return;
      this.callbacks.onError(err instanceof Error ? err.message : String(err));
    }
  }
}
