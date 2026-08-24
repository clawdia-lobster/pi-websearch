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
queries independent engines directly. mwmbl (a bot-friendly, keyless, open-
source index) is the primary engine; Mojeek (UK-based, authenticated via API
key) is the fallback when mwmbl returns nothing. The tool also re-provides
`fetch_content` and `get_search_results` so the `pi-searxng` dependency can be
dropped entirely.

### Key Concepts

- **Engine** — a search backend with a query interface and a result-normalised
  output.
- **SearchResult** — the normalised unit: `{ title, url, snippet }`.
- **Fallback** — when the primary engine returns zero results, the secondary
  engine is queried and its results returned instead.
- **Mojeek API key** — a credential required by Mojeek's JSON API, supplied via
  environment variable and never stored in source control.

### Mental Model

A single `search()` call fans out to at most two engines in priority order
(mwmbl, then Mojeek) and returns one normalised list. Callers — the `web_search`
tool — never know or care which engine produced a result.

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

### Boundaries

In scope:

- `web_search` tool backing mwmbl + Mojeek, with keyless-primary/keyed-fallback
  priority.
- `fetch_content` tool (URL fetch + GitHub repo clone), carried over unchanged.
- `get_search_results` tool (retrieve a prior result set by ID).
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
web_search({ query: string, limit?: number })
  // -> text: numbered markdown list of results, or "No results found."
  // -> details: { resultCount, query, engines: string[] }

fetch_content({ url: string })
  // -> text: readability-extracted body, or cloned-repo file listing for GitHub URLs

get_search_results({ searchId: string })
  // -> text: the cached result set for a prior web_search, or "Search not found"
```

Engine endpoints:

| Engine | Request | Response |
|---|---|---|
| mwmbl | `GET https://mwmbl.org/api/v1/search?s=<query>` | JSON array of `{ url, title: [{value,is_bold},...], extract: [{value,is_bold},...], source }` |
| mojeek | `GET https://www.mojeek.com/search?q=<query>&fmt=json&api_key=<KEY>` | `{ response: { head: {...}, results: [{ url, title, desc }, ...] } }` |

Normalisation:

- mwmbl — `title` and `snippet` are arrays of segments; concatenate `.value`
  in order to form plain text.
- mojeek — `title` -> `title`; `desc` -> `snippet`.

### Constraints

- The Mojeek API key MUST be read from the environment variable `MOJEEK_API_KEY`
  and MUST NOT be committed, logged, or returned in tool output.
- The Mojeek engine MUST NOT be queried when `MOJEEK_API_KEY` is unset; mwmbl
  remains the sole engine in that case.
- mwmbl MUST be the primary engine; Mojeek MUST be queried only when mwmbl
  returns zero results for a query.
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
| mwmbl returns zero results | Query Mojeek (if key set) and return its results |
| both engines return zero | Return `No results found.` |
| Mojeek reachable but `head` status is an error (e.g. daily limit reached) | Treat as zero results; do not crash |
| `MOJEEK_API_KEY` unset | Skip Mojeek; mwmbl only |
| Network failure / non-2xx from an engine | Treat that engine as zero results; try the other |
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

*Version: 1.0 | Updated: 2026-08-24*

## Changelog

- 1.0 (2026-08-24): Initial specification.
