# pi-websearch

Web search for pi that talks to independent engines -- mwmbl, Mojeek, and
marginalia -- with an optional SearXNG instance as final fallback. It provides
three tools, `web_search`, `fetch_content`, and `get_search_results`, and is a
drop-in replacement for `pi-searxng`.

## Engines

By default search fans out to the engines in priority order and stops at the
first that returns results: mwmbl, then Mojeek, then marginalia, then SearXNG.

The caller can instead select exactly which engines to query by passing
`engines` to `web_search`, e.g. `["mwmbl", "searxng"]` to skip marginalia.
Every selected engine is queried and results are merged with round-robin
interleaving (deduplicated by URL), so each engine contributes; one engine's
zero results or network failure does not prevent the others from answering.
Unknown or unconfigured engine names raise an error rather than being skipped
silently.

- **mwmbl** works without a key.
- **Mojeek** needs `MOJEEK_API_KEY`; it is skipped when that variable is unset.
- **marginalia** uses `MARGINALIA_API_KEY`, falling back to the shared `public`
  key when unset.
- **searxng** needs `SEARXNG_URL` (the instance's search endpoint, e.g.
  `https://example.com/search`); it is skipped when unset. It sits last in the
  chain: a SearXNG instance is a meta-engine that queries the major upstream
  engines from its own egress, so it is reserved for queries the independent
  engines cannot answer. `SEARXNG_API_KEY` is used when the instance runs its
  bot limiter.

## Configuration

| Variable | Engine | Required? |
| --- | --- | --- |
| `MOJEEK_API_KEY` | Mojeek | Yes, to use Mojeek |
| `MARGINALIA_API_KEY` | marginalia | No, defaults to `public` |
| `SEARXNG_URL` | searxng | Yes, to use searxng |
| `SEARXNG_API_KEY` | searxng | No, only for limiter-enabled instances |
| `USEFUL_LIST_PATH` | useful-list | No, defaults to `./useful-list.txt` |

Keys are read only from the environment and are never committed, logged, or
returned in tool output.

## Useful-hit list

Whenever `fetch_content` successfully retrieves a page, its domain is appended
to a flat list (`useful-list.txt` by default, override with `USEFUL_LIST_PATH`).
The signal is *consumption*, not appearance in results: a URL only qualifies
once it was actually fetched. Maintainers can batch-submit the accumulated
domains to an independent index (e.g. `mwmbl-mod add`) so the pages the
assistant genuinely relied on feed back into the commons. Entries are
deduplicated, `www.`-stripped, and best-effort -- list writing can never break
a fetch.

See [SPEC.md](SPEC.md) for the system specification.

## License

MIT. Derived in part from [pi-searxng](https://github.com/jcha0713/pi-searxng)
(`index.ts`, `extract.ts`, `github.ts`), also MIT licensed. See [LICENSE](LICENSE).
