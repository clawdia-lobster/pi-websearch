import type { Engine, SearchResult } from "../search.js";

const API_KEY = process.env.MOJEEK_API_KEY;

interface MojeekResult {
  url?: string;
  title?: string;
  desc?: string;
}

interface MojeekResponse {
  response?: {
    results?: MojeekResult[];
  };
}

export const searchMojeek: Engine = {
  name: "mojeek",
  available: Boolean(API_KEY),
  async search(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
    if (!API_KEY) return [];

    const url = new URL("https://www.mojeek.com/search");
    url.searchParams.set("q", query);
    url.searchParams.set("fmt", "json");
    url.searchParams.set("api_key", API_KEY);

    const res = await fetch(url.toString(), {
      signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "pi-websearch/1.0",
      },
    });
    if (!res.ok) throw new Error(`mojeek returned ${res.status}`);

    const data = (await res.json()) as MojeekResponse;
    const hits = data.response?.results ?? [];

    const out: SearchResult[] = [];
    for (const hit of hits) {
      if (!hit.url) continue;
      out.push({
        title: hit.title?.trim() || hit.url,
        url: hit.url,
        snippet: (hit.desc ?? "").trim(),
      });
    }
    return out;
  },
};
