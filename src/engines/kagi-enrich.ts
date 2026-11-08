// SPDX-License-Identifier: MIT
import type { Engine, SearchResult } from "../search.js";

// PLACEHOLDER -- Kagi Enrichment (Teclis web index + TinyGem news index).
//
// As of 2026-11-08 these engines are NOT available: Kagi exposes enrichment
// only through the legacy v0 API (`GET /api/v0/enrich/web` and
// `GET /api/v0/enrich/news`) authenticated with a *legacy* `Bot $TOKEN`
// (KAGI_API_TOKEN), which is a different credential from the v1 Bearer
// `KAGI_API_KEY` this extension holds. The v1 API has no /enrich route yet
// (its OpenAPI client exposes only /search and /extract), so there is no
// endpoint we can reach with the key we have -- every request 401s.
//
// When Kagi ships a v1 enrichment endpoint (e.g. `/api/v1/enrich/web` and
// `/api/v1/enrich/news`, Bearer `KAGI_API_KEY`), enable these engines by:
//   1. setting `available: Boolean(API_KEY)` below,
//   2. filling in the real endpoint URL and response shape in search().
// The engines are otherwise fully wired: they sit in the registry as
// selectOnly (never an automatic fallback) and their results/errors flow
// through the normal selection path.

const API_KEY = process.env.KAGI_API_KEY; // unused until a v1 endpoint exists

async function placeholder(_query: string): Promise<SearchResult[]> {
  throw new Error("kagi enrich: no v1 endpoint yet (see src/engines/kagi-enrich.ts)");
}

export const searchKagiEnrichWeb: Engine = {
  name: "kagi-enrich-web",
  available: false, // placeholder: set to Boolean(API_KEY) when v1 lands
  selectOnly: true,
  async search(query: string, _signal?: AbortSignal): Promise<SearchResult[]> {
    return placeholder(query);
  },
};

export const searchKagiEnrichNews: Engine = {
  name: "kagi-enrich-news",
  available: false, // placeholder: set to Boolean(API_KEY) when v1 lands
  selectOnly: true,
  async search(query: string, _signal?: AbortSignal): Promise<SearchResult[]> {
    return placeholder(query);
  },
};
