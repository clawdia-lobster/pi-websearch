# pi-websearch

Web search for pi that talks to independent engines -- mwmbl, Mojeek, and
marginalia -- rather than a shared SearXNG instance. It provides three tools,
`web_search`, `fetch_content`, and `get_search_results`, and is a drop-in
replacement for `pi-searxng`.

## Engines

Search fans out to the engines in priority order and stops at the first that
returns results. mwmbl is tried first, then Mojeek, then marginalia, then
SearXNG.

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

Keys are read only from the environment and are never committed, logged, or
returned in tool output.

See [SPEC.md](SPEC.md) for the system specification.

## License

MIT. Derived in part from [pi-searxng](https://github.com/jcha0713/pi-searxng)
(`index.ts`, `extract.ts`, `github.ts`), also MIT licensed. See [LICENSE](LICENSE).
