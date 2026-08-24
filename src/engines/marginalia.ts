import type { Engine, SearchResult } from "../search.js";

// Marginalia's public key has a shared rate limit across all consumers; set
// MARGINALIA_API_KEY to use a private key with a separate limit.
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
