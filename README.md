# pi-websearch

Web search for pi that talks to independent engines -- mwmbl, Mojeek, and
marginalia -- rather than a shared SearXNG instance. It provides three tools,
`web_search`, `fetch_content`, and `get_search_results`, and is a drop-in
replacement for `pi-searxng`.

## Engines

Search fans out to the engines in priority order and stops at the first that
returns results. mwmbl is tried first, then Mojeek, then marginalia.

- **mwmbl** works without a key.
- **Mojeek** needs `MOJEEK_API_KEY`; it is skipped when that variable is unset.
- **marginalia** uses `MARGINALIA_API_KEY`, falling back to the shared `public`
  key when unset.

## Configuration

| Variable | Engine | Required? |
| --- | --- | --- |
| `MOJEEK_API_KEY` | Mojeek | Yes, to use Mojeek |
| `MARGINALIA_API_KEY` | marginalia | No, defaults to `public` |

Keys are read only from the environment and are never committed, logged, or
returned in tool output.

See [SPEC.md](SPEC.md) for the system specification.
