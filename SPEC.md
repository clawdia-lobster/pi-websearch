# Specification: pi-websearch

A pi extension that provides web search tools backed by independent,
privacy-respecting engines (mwmbl and Mojeek), decoupled from any shared
multi-user SearXNG instance.

## Problem

### Context

Clawdia (an AI coding agent) performs web search through the `web_search` tool
provided by the `pi-searxng` npm package. That tool forwards every query to a
single shared SearXNG instance (`https://letterbox.pw`), which federates out to
upstream engines: Brave, DuckDuckGo, Startpage, Wikipedia, and Wikidata.

The same SearXNG instance also serves a human user (Ati) who issues occasional
manual searches through it.

### Symptoms

Searches return no results. As of 2026-08-24, a query against the instance
returns `"number_of_results": 0` with these upstream engines failing:

| Engine | Failure mode |
|---|---|
| brave | `Suspended: too many requests` (HTTP 429) |
| duckduckgo | CAPTCHA |
| startpage | parsing error |
| wikidata | `Suspended: access denied` |
| wikipedia | works, but returns zero or one result per query |

`pi-searxng` maps only `data.results[]`, so a suspended/empty upstream response
surfaces to the agent as the literal string `No results found.`

The agent's query pattern is bursty and high-volume (multiple queries, sometimes
in parallel), which trips the rate limits that trigger SearXNG's per-engine
auto-suspensions. Because the suspension is on the shared instance's egress, the
human user's manual searches fail during the same cooldown windows — agent
traffic degrades the human's experience.

### Impact

- The agent loses web search: essentially every query returns empty.
- The shared instance becomes unreliable for its human user during cooldowns.
- There is no separate search path for the agent, so agent and human traffic
  contend for the same throttled egress.

### Current Workaround

None. The agent either retries (worsening the throttle), waits out the cooldown,
or does without search. There is no alternative backend available to the agent.

### Success Criteria

- The agent can search the web without touching the shared SearXNG instance.
- Agent search succeeds for the majority of technical/financial/academic
  lookups, which are the dominant query shape.
- Agent activity cannot trigger rate-limit suspensions that affect the human's
  SearXNG experience.
- No credentials are committed to version control.

## Solution

### Approach

Replace the SearXNG-backed `web_search` tool with a local pi extension that
queries independent engines directly. mwmbl (a bot-friendly, open-source,
keyless index) is the primary engine; Mojeek (UK-based, authenticated via API
key) is the first fallback, and marginalia (a curated, non-commercial index;
keyed, defaulting to the shared `public` key) is the second fallback. A
SearXNG instance (pointed at via `SEARXNG_URL`) is the final fallback: it is
added back deliberately (2026-08-28, user request), but only as a last resort
-- a meta-engine re-introduces the shared-egress coupling this package
removed, so it answers only when every independent engine came up empty. The
tool also re-provides `fetch_content` and `get_search_results` so the
`pi-searxng` dependency can be dropped entirely.

### Key Concepts

- **Engine** — a search backend with a query interface and a result-normalised
  output.
- **SearchResult** — the normalised unit: `{ title, url, snippet }`.
- **Fallback** — when the primary engine returns zero results, the secondary
  engine is queried and its results returned instead.
- **Mojeek API key** — a credential required by Mojeek's JSON API, supplied via
  environment variable and never stored in source control.

### Mental Model

A single `search()` call fans out to engines in priority order (mwmbl, then
Mojeek, then marginalia, then searxng), stopping at the first engine that
returns a non-empty list, and returns one normalised list. Callers — the `web_search`
tool — never know or care which engine produced a result. Each engine is
queried only when every higher-priority engine returned zero results, and only
engines whose key is available are consulted (mwmbl works keyless; marginalia
defaults to the `public` key; searxng requires `SEARXNG_URL`).

The caller may instead select an exact engine subset (`engines` parameter):
every selected engine is queried and results merged round-robin, deduplicated
by URL. This exists for the "independent engines answered, but thinly" case —
e.g. mwmbl returns two weak hits for a fresh-news query — letting the agent
pull in searxng's breadth on demand without making it the default path.

### Assumptions & Risks

- **mwmbl coverage is narrower than Brave/Google** for recent news and long-tail
  queries. The success criteria are scoped to technical/financial/academic
  lookups, where mwmbl returns Wikipedia/Stack Exchange/niche-wiki results.
  Mitigation: Mojeek fallback adds breadth.
- **Mojeek does not rate-limit keyed API requests.** Mojeek's documentation
  presents the JSON API as keyed and quota-based (not IP-throttled in the way
  Brave throttles anonymous scraping). If this assumption fails — e.g. the keyed
  endpoint also imposes aggressive per-IP limits — the fallback degrades to
  "empty result" and the Mojeek engine behaves no worse than the current
  SearXNG setup.
- **mwmbl's JSON API is keyless and unauthenticated.** If mwmbl introduces rate
  limits or requires auth, the primary-engine slot must be reconsidered.
- **The Mojeek API shape is stable.** The spec pins the observed response shape
  (`response.results[]` with `url`/`title`/`desc`). If Mojeek changes this
  schema, normalisation breaks and must be updated.
- **SearXNG's JSON output must stay enabled** on the target instance
  (`search.formats` includes `json`), and the instance's upstream engines must
  not all be rate-limit-suspended. As the final fallback, its failure degrades
  to "empty result" and behaves no worse than the pre-package `pi-searxng`
  setup, but it re-introduces shared-egress coupling; volume stays low
  precisely because only emptied-out queries reach it.

### Boundaries

In scope:

- `web_search` tool backing mwmbl + Mojeek, with keyless-primary/keyed-fallback
  priority.
- `fetch_content` tool (URL fetch + GitHub repo clone), carried over unchanged.
- `get_search_results` tool (retrieve a prior result set by ID).
- `get_search_content` tool (page through retained fetched content by
  `responseId`, or locate passages with `findText`).
- Retention of the full extracted markdown, bounded (500k chars/page, 64 pages,
  in-memory only).
- Normalisation of mwmbl and Mojeek responses into a single `SearchResult`
  shape.
- Configurable Mojeek API key via environment variable.

Out of scope:

- Any modification to SearXNG itself or its engines.
- Search of images, news, or verticals — general web search only.
- Caching beyond the in-memory `get_search_results` ID map (no persistence).
- Result ranking or relevance tuning beyond engine-provided order.
- Authentication/authorisation of the user (single-user extension).
- Implementation progress tracking (see PLAN.md).

### Alternatives Considered

1. **Re-enable a curated engine set in SearXNG (`mwmbl`, `mojeek`, `wikipedia`).**
   Rejected: still routes agent traffic through the shared instance's egress;
   does not decouple agent volume from the human's instance.

2. **Add Brave Search API (keyed) as primary.**
   Rejected by the user on privacy grounds (avoiding US surveillance
   advertisers); Brave, DuckDuckGo, Google are all American.

3. **Scrape Mojeek's public HTML UI (no key).**
   Rejected: the SearXNG engine already does this and Mojeek may throttle
   datacenter IPs on the anonymous path; the keyed JSON API is the documented,
   unthrottled route.

4. **Write a SearXNG custom engine for the paid Mojeek API.**
   Rejected: keeps the shared-instance coupling, and the NixOS SearXNG module
   does not cleanly expose custom engines.

## Contract

### Interface

```typescript
// Internal search function (engine-agnostic)
search(query: string, limit?: number): Promise<{ results: SearchResult[] }>

SearchResult = {
  title: string      // human-readable title; falls back to the URL if absent
  url: string        // canonical result URL
  snippet: string    // description/extract; empty string if absent
}
```

Registered tools (pi `registerTool`):

```typescript
web_search({ query: string, limit?: number, engines?: string[] })
  // -> text: numbered markdown list of results, or "No results found."
  // -> details: { resultCount, query, engines: string[] }
  // engines: query exactly these engines and merge results (round-robin,
  //    deduped by URL); default is the fallback chain

fetch_content({ url: string })
  // -> text: readability-extracted body, or cloned-repo file listing for GitHub URLs
  // -> details: { responseId, ... } -- the retained full-page id for get_search_content

get_search_results({ searchId: string })
  // -> text: the cached result set for a prior web_search, or "Search not found"

get_search_content({ responseId: string, offset?: number, limit?: number, findText?: string, findMode?: "exact" | "case-insensitive" })
  // -> text: a slice of a retained fetched page (offset/limit, default first 30000 chars),
  //    or bounded passages around findText matches (case-insensitive by default), or
  //    "Content not found." for an unknown/evicted id
```

Engine endpoints:

| Engine | Request | Response |
|---|---|---|
| mwmbl | `GET https://mwmbl.org/api/v2/search/?q=<query>` | `{ query, number_of_results, results: [{ url, title, title_highlights, content, content_highlights, engine, score }, ...], monthly_usage, monthly_limit }` |
| mojeek | `GET https://www.mojeek.com/search?q=<query>&fmt=json&api_key=<KEY>` | `{ response: { head: {...}, results: [{ url, title, desc }, ...] } }` |
| marginalia | `GET https://api.marginalia.nu/<KEY>/search/<query>?format=json&index=0&count=<n>` | `{ license, page, pages, query, results: [{ url, title, description, quality, ... }, ...] }` |
| searxng | `GET <SEARXNG_URL>?q=<query>&format=json` | `{ query, number_of_results, results: [{ url, title, content, engine, ... }, ...] }` |

Normalisation:

- mwmbl — `title` -> `title`; `content` -> `snippet` (the v2 API already returns
  plain concatenated text, superseding the v1 segment-array format).
- mojeek — `title` -> `title`; `desc` -> `snippet`.
- marginalia — `title` -> `title`; `description` -> `snippet`.

### Constraints

- Engine API keys MUST be read from environment variables (`MOJEEK_API_KEY`,
  `MARGINALIA_API_KEY`, `SEARXNG_API_KEY`) and MUST NOT be committed, logged,
  or returned in tool output. `SEARXNG_URL` is likewise environment-supplied:
  private instance hostnames do not belong in this repo.
- The Mojeek engine MUST NOT be queried when `MOJEEK_API_KEY` is unset; mwmbl
  and marginalia remain available in that case.
- mwmbl MUST be the primary engine and is queried keyless (mwmbl exposes no
  search-scoped API key). Mojeek is queried only when mwmbl returns zero
  results; marginalia only when both mwmbl and Mojeek return zero results.
- marginalia MAY be queried with the shared `public` key when
  `MARGINALIA_API_KEY` is unset.
- Both engines' output MUST be normalised to `SearchResult[]` before leaving
  the extension (the caller has no knowledge of the source).
- Result URLs MUST be preserved verbatim (no rewriting, no tracking stripping).
- The `web_search` tool SHOULD return `No results found.` when both engines
  return zero results, matching the prior observable behaviour.
- The `web_search` tool MAY return a maximum of `limit` results (default 10),
  consistent with the prior `pi-searxng` behaviour.

### Errors

| Condition | Behaviour |
|---|---|
| mwmbl returns zero results | Query Mojeek (if key set), then marginalia |
| all engines return zero | Return `No results found.` |
| Mojeek reachable but `head` status is an error (e.g. daily limit reached) | Treat as zero results; do not crash |
| `MOJEEK_API_KEY` unset | Skip Mojeek; mwmbl + marginalia only |
| Network failure / non-2xx from an engine | Treat that engine as zero results; try the next |
| `get_search_results` with an unknown ID | Return `Search not found.` |
| fetch of a URL fails | Return the error message as text |

## Verification

### Examples

```text
web_search({ query: "sharpe ratio" })
-> mwmbl returns en.wikipedia.org/wiki/Sharpe_ratio,
   quant.stackexchange.com/q/50518, handwiki.org/wiki/Sharpe_ratio
1. **Sharpe ratio - Wikipedia**
   https://en.wikipedia.org/wiki/Sharpe_ratio
   In finance, the Sharpe ratio ...

web_search({ query: "obscure foo" })
-> mwmbl returns []; Mojeek (key set) returns results; those are returned.

web_search({ query: "obscure foo" })   // MOJEEK_API_KEY unset
-> mwmbl returns []; Mojeek skipped; "No results found."
```

### Acceptance Criteria

- [ ] Given a query mwmbl answers, `web_search` returns mwmbl results in
      `SearchResult[]` form with concatenated `title`/`snippet` text.
- [ ] Given a query mwmbl does not answer but Mojeek does (key set), `web_search`
      returns Mojeek results, and the mwmbl/Mojeek fallback order is preserved.
- [ ] Given `MOJEEK_API_KEY` is unset, Mojeek is never queried and no key leak
      occurs in output or logs.
- [ ] Given both engines return zero results, `web_search` returns
      `No results found.`
- [ ] Given a network error from mwmbl, Mojeek is still attempted (and vice
      versa); the tool never throws.
- [ ] Given the Mojeek key, it appears in no committed file and no tool output.
- [ ] `fetch_content` retrieves a normal URL and clones a GitHub URL (parity
      with `pi-searxng`).
- [ ] `get_search_results` returns the cached set for a valid ID and
      `Search not found.` for an unknown ID.
- [ ] Removing `npm:pi-searxng` from the package list and adding this extension
      leaves all three tools functional.

---

*Version: 1.2 | Updated: 2026-09-04*

## Changelog

- 1.2 (2026-09-04): Added `get_search_content` for bounded retrieval over
  fetched pages: `fetch_content` now retains the full extracted markdown and
  returns a `responseId`; `get_search_content` slices it (`offset`/`limit`) or
  locates passages (`findText`, exact or case-insensitive). No fuzzy matching.
  Retention is in-memory only (lost on session end), capped per-page and by
  entry count.
- 1.1 (2026-08-24): Added marginalia as a third fallback engine; moved mwmbl
  to the v2 API (`/api/v2/search/`, returning plain concatenated
  `title`/`content` text); documented `MARGINALIA_API_KEY` (default `public`).
- 1.0 (2026-08-24): Initial specification.
