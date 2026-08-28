import { searchMwmbl } from "./engines/mwmbl.js";
import { searchMojeek } from "./engines/mojeek.js";
import { searchMarginalia } from "./engines/marginalia.js";
import { searchSearxng } from "./engines/searxng.js";

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
 * key; mwmbl works keyless but uses a key when provided). searxng requires
 * SEARXNG_URL and sits last: a meta-engine that queries the major upstream
 * engines, reserved for when the independent engines all come up empty.
 */
const engines: Engine[] = [
  searchMwmbl,
  searchMojeek,
  searchMarginalia,
  searchSearxng,
];

export interface SearchOptions {
  limit?: number;
  signal?: AbortSignal;
  /**
   * Query exactly these engines (by name), in chain priority order, instead
   * of running the fallback chain. All selected engines are queried and their
   * results merged (round-robin interleave, deduped by URL) so each one
   * contributes; one engine's zero results or network failure does not
   * prevent the others from answering.
   */
  engines?: string[];
}

// Hard per-engine budget: some engines (marginalia with certain queries,
// rate-limited public keys) stall connections indefinitely. Without this,
// one stalled engine would wedge the whole search forever.
const ENGINE_TIMEOUT_MS = 15000;

function engineSignal(signal?: AbortSignal): AbortSignal {
  return AbortSignal.any(
    [AbortSignal.timeout(ENGINE_TIMEOUT_MS), ...(signal ? [signal] : [])],
  );
}

/** Engine names accepted by search(); also surfaced in tool errors. */
export const ENGINE_NAMES = engines.map((e) => e.name);

/** Round-robin interleave so every list contributes, deduped by URL. */
function interleave(lists: SearchResult[][]): SearchResult[] {
  const out: SearchResult[] = [];
  const seen = new Set<string>();
  const max = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < max; i++) {
    for (const list of lists) {
      const r = list[i];
      if (r && !seen.has(r.url)) {
        seen.add(r.url);
        out.push(r);
      }
    }
  }
  return out;
}

export async function search(
  query: string,
  options: SearchOptions = {},
): Promise<SearchResponse> {
  const { limit = 10, signal, engines: selected } = options;

  // Explicit engine selection: query every selected engine, merge results.
  // No fallback outside the selection -- zero merged results means the
  // selected engines have nothing. Misconfiguration raises rather than
  // silently skipping, so the caller knows an engine it asked for did not
  // run; runtime failures degrade to that engine contributing nothing.
  if (selected) {
    if (selected.length === 0) {
      throw new Error("engines list must not be empty");
    }
    const unknown = selected.filter((n) => !ENGINE_NAMES.includes(n));
    if (unknown.length > 0) {
      throw new Error(
        `unknown engine(s): ${unknown.join(", ")} (valid: ${ENGINE_NAMES.join(", ")})`,
      );
    }
    const chosen = engines.filter((e) => selected.includes(e.name));
    const unavailable = chosen
      .filter((e) => !e.available)
      .map((e) => e.name);
    if (unavailable.length > 0) {
      throw new Error(
        `engine(s) not configured (missing API key or URL): ${unavailable.join(", ")}`,
      );
    }

    const perEngine: SearchResult[][] = [];
    const queried: string[] = [];
    for (const engine of chosen) {
      queried.push(engine.name);
      try {
        perEngine.push(await engine.search(query, engineSignal(signal)));
      } catch {
        // Runtime failure of one selected engine must not sink the others.
        perEngine.push([]);
      }
    }
    return {
      results: interleave(perEngine).slice(0, limit),
      engines: queried,
    };
  }

  const queried: string[] = [];

  for (const engine of engines) {
    if (!engine.available) continue;
    queried.push(engine.name);

    try {
      const results = await engine.search(query, engineSignal(signal));
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
