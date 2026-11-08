// SPDX-License-Identifier: MIT
import type { Engine, SearchResult } from "../search.js";

// Kagi is a paid commercial index with no free tier: each query costs money
// (API credit, ~$12 per 1,000 queries at the standard rate). It is therefore
// keyed and sits AFTER the independent engines (mwmbl, Mojeek, marginalia),
// reachable only when they all return zero results -- its cost is self-bounded
// by that fallback position. The key comes from the environment
// (KAGI_API_KEY); without it the engine is unavailable and never queried.
//
// The v1 Search API is a simple POST with Bearer auth and a JSON body; the
// web results are under `data.search`, each carrying `url`, `title` and
// `snippet`.

const API_KEY = process.env.KAGI_API_KEY;

const ENDPOINT = "https://kagi.com/api/v1/search";

interface KagiResult {
  url?: string;
  title?: string;
  snippet?: string;
}

interface KagiResponse {
  data?: {
    search?: KagiResult[];
  };
}

export const searchKagi: Engine = {
  name: "kagi",
  available: Boolean(API_KEY),
  async search(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
    if (!API_KEY) return [];

    const res = await fetch(ENDPOINT, {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "pi-websearch/1.1",
      },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) throw new Error(`kagi returned ${res.status}`);

    const data = (await res.json()) as KagiResponse;

    const out: SearchResult[] = [];
    for (const hit of data.data?.search ?? []) {
      if (!hit.url) continue;
      out.push({
        title: hit.title?.trim() || hit.url,
        url: hit.url,
        snippet: (hit.snippet ?? "").trim(),
      });
    }
    return out;
  },
};
