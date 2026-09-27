// SPDX-License-Identifier: MIT
import { parseHTML } from "linkedom";
import type { Engine, SearchResult } from "../search.js";

// Keyless DuckDuckGo via the Lite HTML endpoint. No key, no account, no
// dependency on the shared SearXNG instance -- but it is an American
// advertising engine read through its public HTML rather than an API, so it
// sits immediately before the SearXNG fallback: reached only when every
// independent engine has returned nothing, or when explicitly selected with
// `engines: ["ddg"]`.
//
// Two behaviours shape the implementation:
//
//   * DuckDuckGo answers a burst with HTTP 202 and a human-verification page
//     ("Unfortunately, bots use DuckDuckGo too"). Requests are therefore
//     serialised and spaced (DDG_SEARCH_INTERVAL_MS, default 2000 ms), and a
//     challenge is raised as an error rather than reported as zero results, so
//     the chain falls through and the caller is told why.
//   * Result links are redirect wrappers (`/l/?uddg=<target>`); the target is
//     unwrapped. Every URL that is not a wrapper is preserved verbatim.

const ENDPOINT = "https://lite.duckduckgo.com/lite/";
const USER_AGENT =
  "pi-websearch/1.0 (+https://github.com/clawdia-lobster/pi-websearch)";

/** Results parsed per request; the caller's `limit` slices them. */
const MAX_RESULTS = 25;

const DEFAULT_INTERVAL_MS = 2000;
const MIN_INTERVAL_MS = 500;

function intervalMs(): number {
  const raw = Number.parseInt(process.env.DDG_SEARCH_INTERVAL_MS ?? "", 10);
  return Number.isFinite(raw) ? Math.max(MIN_INTERVAL_MS, raw) : DEFAULT_INTERVAL_MS;
}

let lastRequestAt = 0;
let queue: Promise<void> = Promise.resolve();

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(new Error("Search cancelled."));

  return new Promise((resolve, reject) => {
    function onAbort(): void {
      clearTimeout(timer);
      reject(new Error("Search cancelled."));
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// One DuckDuckGo request at a time, at least `intervalMs()` apart, however many
// searches run concurrently: the throttle is per-process, not per-search.
function waitForSlot(signal?: AbortSignal): Promise<void> {
  const run = queue.catch(() => undefined).then(async () => {
    const wait = Math.max(0, lastRequestAt + intervalMs() - Date.now());
    await sleep(wait, signal);
    lastRequestAt = Date.now();
  });
  queue = run.catch(() => undefined);
  return run;
}

/** Unwrap a `/l/?uddg=<target>` redirect; leave anything else untouched. */
export function resolveResultUrl(href: string): string {
  try {
    const parsed = new URL(href, ENDPOINT);
    const target = parsed.searchParams.get("uddg");
    if (target) return target;
  } catch {
    // Not a URL at all: fall through and hand it back as it came.
  }
  return href;
}

/** DuckDuckGo's bot challenge (served with HTTP 202). */
function isChallenge(html: string): boolean {
  return /anomaly|Unfortunately, bots use DuckDuckGo/i.test(html);
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Parse the Lite results table: each result is an `a.result-link` whose
 * following rows carry the snippet (`td.result-snippet`) and the displayed
 * domain (`span.link-text`). A couple of rows are scanned so a missing snippet
 * cannot swallow the next result's.
 */
export function parseResults(html: string, limit: number): SearchResult[] {
  const { document } = parseHTML(html);
  if (!document?.documentElement) return [];

  const out: SearchResult[] = [];
  for (const anchor of Array.from(document.querySelectorAll("a.result-link"))) {
    if (out.length >= limit) break;

    const href = anchor.getAttribute("href");
    if (!href) continue;

    const url = resolveResultUrl(href);
    const title = collapse(anchor.textContent ?? "") || url;

    let snippet = "";
    let row: Element | null = anchor.closest("tr");
    for (let i = 0; row && i < 3 && !snippet; i++) {
      row = row.nextElementSibling;
      const cell = row?.querySelector("td.result-snippet");
      if (cell) snippet = collapse(cell.textContent ?? "");
    }

    out.push({ title, url, snippet });
  }
  return out;
}

export const searchDdg: Engine = {
  name: "ddg",
  available: true, // keyless, unauthenticated
  async search(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
    await waitForSlot(signal);

    const url = new URL(ENDPOINT);
    url.searchParams.set("q", query);

    const res = await fetch(url, {
      signal,
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": USER_AGENT,
      },
    });
    const body = await res.text();

    if (res.status !== 200 || isChallenge(body)) {
      throw new Error(
        `bot challenge (HTTP ${res.status}); retry later or query another engine`,
      );
    }

    return parseResults(body, MAX_RESULTS);
  },
};
