// SPDX-License-Identifier: MIT
import type { Engine, SearchResult } from "../search.js";

// Marginalia is a curated, non-commercial index of "small web" pages. It is
// NOT part of the default fallback chain: its API is keyed and slow, and the
// shared `public` key is heavily rate-limited (429 daily/QPM limits), so it
// never pays to let it block a search. It is kept as a SELECTION-ONLY engine:
// reachable when the caller explicitly asks for it (`engines: ["marginalia"]`),
// valued for its novel, non-commercial angle that mainstream indexes filter
// out.
//
// Uses the current api2 API (api2.marginalia-search.com), passing the key in
// the `API-Key` header. The `public` key is shared and rate-limited; an
// email-obtained key (free, non-commercial; contact@marginalia-search.com) or
// a paid key lifts that limit and enables custom filters.
const API_KEY = process.env.MARGINALIA_API_KEY || "public";

interface MarginaliaResult {
  url?: string;
  title?: string;
  description?: string;
}

interface MarginaliaResponse {
  results?: MarginaliaResult[];
}

export const searchMarginalia: Engine = {
  name: "marginalia",
  available: true,
  selectOnly: true,
  async search(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
    const url = new URL("https://api2.marginalia-search.com/search");
    url.searchParams.set("query", query);
    url.searchParams.set("count", "20");

    const res = await fetch(url.toString(), {
      signal,
      headers: {
        "API-Key": API_KEY,
        "User-Agent": "pi-websearch/1.1",
      },
    });
    if (!res.ok) throw new Error(`marginalia returned ${res.status}`);

    const data = (await res.json()) as MarginaliaResponse;

    const out: SearchResult[] = [];
    for (const hit of data.results ?? []) {
      if (!hit.url) continue;
      out.push({
        title: hit.title?.trim() || hit.url,
        url: hit.url,
        snippet: (hit.description ?? "").trim(),
      });
    }
    return out;
  },
};
