import { searchMwmbl } from "./engines/mwmbl.js";
import { searchMojeek } from "./engines/mojeek.js";
import { searchMarginalia } from "./engines/marginalia.js";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchResponse {
  results: SearchResult[];
  /** Engine names actually queried, in priority order (the fallback chain executed). */
  engines: string[];
}

export interface Engine {
  name: string;
  available: boolean;
  search(query: string, signal?: AbortSignal): Promise<SearchResult[]>;
}

/**
 * Engines in priority order. Each is queried only when every higher-priority
 * engine returned zero results. Keyed engines expose `available` based on
 * whether their key is configured (marginalia defaults to the shared "public"
 * key; mwmbl works keyless but uses a key when provided).
 */
const engines: Engine[] = [searchMwmbl, searchMojeek, searchMarginalia];

export async function search(
  query: string,
  limit = 10,
  signal?: AbortSignal,
): Promise<SearchResponse> {
  const queried: string[] = [];

  for (const engine of engines) {
    if (!engine.available) continue;
    queried.push(engine.name);

    try {
      const results = await engine.search(query, signal);
      if (results.length > 0) {
        return {
          results: results.slice(0, limit),
          engines: queried,
        };
      }
    } catch {
      // Treat any engine failure (network, parse, quota) as zero results and
      // fall through to the next engine.
    }
  }

  return { results: [], engines: queried };
}
