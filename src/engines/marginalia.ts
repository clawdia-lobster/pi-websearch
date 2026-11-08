// SPDX-License-Identifier: MIT
import type { Engine, SearchResult } from "../search.js";

// Marginalia is a curated, non-commercial index of "small web" pages. It is
// NOT part of the default fallback chain: its API is public-key/slow and
// answers only a modest share of queries while sometimes timing out under
// bot-prevention, so it never pays to let it block a search. It is kept as a
// SELECTION-ONLY engine: reachable when the caller explicitly asks for it
// (`engines: ["marginalia"]`), valued for its novel, non-commercial angle
// that mainstream indexes filter out.
//
// The code is keyless in the sense that it always makes a request: it falls
// back to the shared "public" key when MARGINALIA_API_KEY is unset. A private
// key buys a separate rate limit.
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
    const url = new URL(
      `https://api.marginalia.nu/${API_KEY}/search/${encodeURIComponent(query)}`,
    );
    url.searchParams.set("format", "json");
    url.searchParams.set("index", "0");
    url.searchParams.set("count", "20");

    const res = await fetch(url.toString(), {
      signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "pi-websearch/1.0",
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
