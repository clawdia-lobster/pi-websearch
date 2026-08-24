import type { Engine, SearchResult } from "../search.js";

interface MwmblHit {
  url: string;
  title?: string;
  content?: string;
}

function normalize(hits: MwmblHit[]): SearchResult[] {
  const out: SearchResult[] = [];
  for (const hit of hits) {
    if (!hit.url) continue;
    out.push({
      title: hit.title?.trim() || hit.url,
      url: hit.url,
      snippet: (hit.content ?? "").trim(),
    });
  }
  return out;
}

export const searchMwmbl: Engine = {
  name: "mwmbl",
  available: true, // keyless, unauthenticated
  async search(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
    const url = new URL("https://mwmbl.org/api/v2/search/");
    url.searchParams.set("q", query);

    const res = await fetch(url.toString(), {
      signal,
      headers: {
        Accept: "application/json",
        // mwmbl's proxy mis-reports compression; request identity to avoid
        // undici failing to decompress the body ("incorrect header check").
        "Accept-Encoding": "identity",
        "User-Agent": "pi-websearch/1.0",
      },
    });
    if (!res.ok) throw new Error(`mwmbl returned ${res.status}`);

    const data = (await res.json()) as { results?: MwmblHit[] };
    return normalize(data.results ?? []);
  },
};
