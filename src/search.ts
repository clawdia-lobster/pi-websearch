import { searchMwmbl } from "./engines/mwmbl.js";
import { searchMojeek } from "./engines/mojeek.js";
import { searchKagi } from "./engines/kagi.js";
import { searchMarginalia } from "./engines/marginalia.js";
import { searchDdg } from "./engines/ddg.js";
import {
  searchKagiEnrichWeb,
  searchKagiEnrichNews,
} from "./engines/kagi-enrich.js";
import { searchSearxng } from "./engines/searxng.js";
import {
  errorText,
  recordUsage,
  type UsageAttempt,
} from "./stats.js";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchResponse {
  results: SearchResult[];
  /** Engine names actually queried, in priority order (the fallback chain executed). */
  engines: string[];
  /**
   * Per-engine failures, so an empty or degraded answer is not reported as a
   * bare "no results": a suspended upstream or a bot challenge is a fact the
   * caller needs in order to choose a different engine.
   */
  notes: string[];
}

export interface Engine {
  name: string;
  available: boolean;
  search(query: string, signal?: AbortSignal): Promise<SearchResult[]>;
  /**
   * Remote from the default fallback chain: this engine is only reached when
   * the caller selects it explicitly with `engines`, never as an automatic
   * fallback. Used for niche or slow/keyless indexes (e.g. marginalia) whose
   * value is an explicit enquiry, not a blocking default hop.
   */
  selectOnly?: boolean;
}

/**
 * Engines in priority order. Each is queried only when every higher-priority
 * engine returned zero results. Keyed engines expose `available` based on
 * whether their key is configured (kagi requires KAGI_API_KEY; mwmbl works
 * keyless but uses a key when provided).
 *
 * kagi is a paid index with no free tier; it sits between the independent
 * engines and the mainstream/advertising-backed ones, so its per-query cost is
 * self-bounded: it only fires when mwmbl and Mojeek both return zero. ddg
 * (keyless DuckDuckGo Lite) is the mainstream index, and searxng the
 * meta-engine that federates the same upstreams from its own egress; both sit
 * after the independent engines, which answer the majority of technical,
 * academic and financial lookups without a shared or advertising-backed path.
 * searxng stays last because it re-introduces coupling to a shared instance.
 *
 * Engines flagged `selectOnly` (marginalia, kagi-enrich-*) are NOT in this
 * chain: they are excluded from the automatic fallback and only run on
 * explicit `engines` selection. The kagi-enrich-* engines are additionally
 * `available: false` pending a v1 endpoint (see kagi-enrich.ts).
 */
const engines: Engine[] = [
  searchMwmbl,
  searchMojeek,
  searchKagi,
  searchDdg,
  searchSearxng,
  searchMarginalia,
  searchKagiEnrichWeb,
  searchKagiEnrichNews,
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

// Hard per-engine budget: some engines (rate-limited public queries) stall
// connections indefinitely. Without this, one stalled engine would wedge the
// whole search forever.
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
  return searchWithEngines(engines, query, options);
}

/**
 * Search a supplied engine registry, applying the fallback and selection rules
 * and metering the call. `search()` passes the built-in registry; the seam
 * exists so those rules are testable with stub engines instead of the network.
 */
export async function searchWithEngines(
  registry: Engine[],
  query: string,
  options: SearchOptions = {},
): Promise<SearchResponse> {
  const { signal, engines: selected } = options;
  // A limit of zero would hand the caller nothing while the engine's answer is
  // still recorded, so the meter would report a win on a call that answered
  // nobody; a negative limit would silently drop the last result.
  const limit = Math.max(1, options.limit ?? 10);

  // Explicit engine selection: query every selected engine, merge results.
  // No fallback outside the selection -- zero merged results means the
  // selected engines have nothing. Misconfiguration raises rather than
  // silently skipping, so the caller knows an engine it asked for did not
  // run; runtime failures degrade to that engine contributing nothing.
  if (selected) {
    if (selected.length === 0) {
      throw new Error("engines list must not be empty");
    }
    const names = registry.map((e) => e.name);
    const unknown = selected.filter((n) => !names.includes(n));
    if (unknown.length > 0) {
      throw new Error(
        `unknown engine(s): ${unknown.join(", ")} (valid: ${names.join(", ")})`,
      );
    }
    const chosen = registry.filter((e) => selected.includes(e.name));
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
    const notes: string[] = [];
    const attempts: UsageAttempt[] = [];
    for (const engine of chosen) {
      queried.push(engine.name);
      const started = Date.now();
      try {
        const results = await engine.search(query, engineSignal(signal));
        attempts.push({
          engine: engine.name,
          outcome: results.length > 0 ? "answer" : "empty",
          results: results.length,
          ms: Date.now() - started,
        });
        perEngine.push(results);
      } catch (err) {
        // Runtime failure of one selected engine must not sink the others,
        // but it is recorded so the caller knows the merge was incomplete.
        notes.push(note(engine.name, err));
        attempts.push({
          engine: engine.name,
          outcome: "fail",
          results: 0,
          ms: Date.now() - started,
          error: errorText(err),
        });
        perEngine.push([]);
      }
    }
    const merged = interleave(perEngine).slice(0, limit);
    recordUsage({
      mode: "select",
      ok: merged.length > 0,
      winner: null,
      results: merged.length,
      attempts,
    });
    return {
      results: merged,
      engines: queried,
      notes,
    };
  }

  const queried: string[] = [];
  const notes: string[] = [];
  const attempts: UsageAttempt[] = [];

  for (const engine of registry) {
    if (engine.selectOnly) continue;
    if (!engine.available) continue;
    queried.push(engine.name);
    const started = Date.now();

    try {
      const results = await engine.search(query, engineSignal(signal));
      const ms = Date.now() - started;
      if (results.length > 0) {
        attempts.push({
          engine: engine.name,
          outcome: "answer",
          results: results.length,
          ms,
        });
        const sliced = results.slice(0, limit);
        recordUsage({
          mode: "chain",
          ok: sliced.length > 0,
          winner: engine.name,
          results: sliced.length,
          attempts,
        });
        return {
          results: sliced,
          engines: queried,
          notes,
        };
      }
      attempts.push({
        engine: engine.name,
        outcome: "empty",
        results: 0,
        ms,
      });
    } catch (err) {
      // Treat any engine failure (network, parse, quota) as zero results and
      // fall through to the next engine -- recording why, so the answer is not
      // silently reported as "no results".
      notes.push(note(engine.name, err));
      attempts.push({
        engine: engine.name,
        outcome: "fail",
        results: 0,
        ms: Date.now() - started,
        error: errorText(err),
      });
    }
  }

  recordUsage({
    mode: "chain",
    ok: false,
    winner: null,
    results: 0,
    attempts,
  });
  return { results: [], engines: queried, notes };
}

function note(engine: string, err: unknown): string {
  return `${engine}: ${err instanceof Error ? err.message : String(err)}`;
}
