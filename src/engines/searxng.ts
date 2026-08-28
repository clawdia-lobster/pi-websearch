import type { Engine, SearchResult } from "../search.js";

// SearXNG is a meta-engine: one query fans out to major upstream engines from
// the instance's own egress. That is exactly the traffic pattern this package
// was written to avoid (see SPEC.md: agent bursts used to trip rate-limit
// suspensions on a shared instance), so searxng sits LAST in the fallback
// chain -- it only answers when every independent engine came up empty.
//
// Point SEARXNG_URL at an instance's search endpoint (e.g.
// https://example.com/search). The engine is skipped when unset, so private
// instance hostnames stay out of this repo. Set SEARXNG_API_KEY when the
// instance runs its bot limiter.
const BASE_URL = process.env.SEARXNG_URL?.replace(/\/+$/, "");
const API_KEY = process.env.SEARXNG_API_KEY;

interface SearxngResult {
  url?: string;
  title?: string;
  content?: string;
}

interface SearxngResponse {
  results?: SearxngResult[];
}

export const searchSearxng: Engine = {
  name: "searxng",
  available: Boolean(BASE_URL),
  async search(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
    if (!BASE_URL) return [];

    const url = new URL(BASE_URL);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");

    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": "pi-websearch/1.1",
    };
    if (API_KEY) headers["X-Searx-API-Key"] = API_KEY;

    // The instance may 308-redirect /search to /search/search; fetch follows
    // redirects by default.
    const res = await fetch(url.toString(), { signal, headers });
    if (!res.ok) throw new Error(`searxng returned ${res.status}`);

    const data = (await res.json()) as SearxngResponse;

    const out: SearchResult[] = [];
    for (const hit of data.results ?? []) {
      if (!hit.url) continue;
      out.push({
        title: hit.title?.trim() || hit.url,
        url: hit.url,
        snippet: (hit.content ?? "").trim(),
      });
    }
    return out;
  },
};
