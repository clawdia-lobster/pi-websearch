// SPDX-License-Identifier: MIT
// Bounded retrieval over fetched page content. fetch_content shows the first
// INLINE_CONTENT_CHARS inline and retains the full extracted markdown, so
// get_search_content can page through the rest (offset/limit) or locate a
// passage (findText) without re-fetching.
//
// Retention is in-memory only, mirroring the search cache in index.ts: pages
// are lost on session end, and both a per-entry size cap and a max-entry count
// guard against pathological sessions ballooning memory.

export interface ContentEntry {
  title: string;
  url: string;
  content: string;
}

/** Chars returned inline by fetch_content; the tail is retained for paging. */
export const INLINE_CONTENT_CHARS = 30000;

/** Cap on findText output so a huge page cannot flood context. */
const FINDER_OUTPUT_CHARS = 20000;

/** Per-entry retention cap; text beyond this is dropped. */
const MAX_RETAINED_CHARS = 500000;

/** Max retained pages; oldest (Map insertion order) is evicted first. */
const MAX_ENTRIES = 64;

/** Chars of surrounding text shown around each findText match. */
const MATCH_CONTEXT_CHARS = 120;

/** Cap on rendered matches so common words do not produce thousands of blocks. */
const MAX_MATCHES = 50;

/** Cap on the total match scan so a pathological needle cannot spin. */
const MAX_SCAN_MATCHES = 10000;

const contentCache = new Map<string, ContentEntry>();

function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function storeContent(
  title: string,
  url: string,
  content: string,
): string {
  const id = newId();
  contentCache.set(id, {
    title,
    url,
    content: content.slice(0, MAX_RETAINED_CHARS),
  });
  if (contentCache.size > MAX_ENTRIES) {
    const oldest = contentCache.keys().next().value;
    if (oldest !== undefined) contentCache.delete(oldest);
  }
  return id;
}

export function getContent(id: string): ContentEntry | undefined {
  return contentCache.get(id);
}

export type FindMode = "exact" | "case-insensitive";

/** Slice a retained page, clamped to valid bounds. Empty at/after end. */
export function sliceContent(
  content: string,
  offset = 0,
  limit = INLINE_CONTENT_CHARS,
): string {
  if (offset >= content.length) return "";
  const start = Math.max(0, offset);
  const end = Math.min(content.length, start + Math.max(0, limit));
  return content.slice(start, end);
}

/** Return bounded passages around matches, with match offsets, for a term. */
export function findInContent(
  content: string,
  needle: string,
  mode: FindMode = "case-insensitive",
): string {
  if (needle === "") return "Empty findText.";

  const haystack = mode === "case-insensitive" ? content.toLowerCase() : content;
  const key = mode === "case-insensitive" ? needle.toLowerCase() : needle;

  const matches: number[] = [];
  let idx = haystack.indexOf(key);
  while (idx !== -1) {
    matches.push(idx);
    if (matches.length >= MAX_SCAN_MATCHES) break;
    idx = haystack.indexOf(key, idx + key.length);
  }

  const total = matches.length;
  if (total === 0) return "No matches found.";

  const scanTruncated = total >= MAX_SCAN_MATCHES;
  const shown = Math.min(total, MAX_MATCHES);
  const countLabel = scanTruncated ? `at least ${total}` : String(total);
  const header =
    `Found ${countLabel} match${total === 1 ? "" : "es"} for "${needle}" (${mode})` +
    (total > shown ? `; showing first ${shown}` : "") + ":";

  const lines: string[] = [header];
  let used = 0;
  for (let i = 0; i < shown; i++) {
    const at = matches[i];
    const start = Math.max(0, at - MATCH_CONTEXT_CHARS);
    const end = Math.min(content.length, at + key.length + MATCH_CONTEXT_CHARS);
    let excerpt = content.slice(start, end);
    if (start > 0) excerpt = "..." + excerpt;
    if (end < content.length) excerpt = excerpt + "...";

    const line = `\n--- match ${i + 1} @ ${at} ---\n${excerpt}`;
    lines.push(line);
    used += line.length;

    if (used >= FINDER_OUTPUT_CHARS) {
      lines.push("\n[Output capped at " + FINDER_OUTPUT_CHARS + " chars]");
      break;
    }
  }

  return lines.join("\n");
}
