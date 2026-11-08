#!/usr/bin/env node
// Aggregate the pi-websearch usage meter: per-engine answers, empties, failures
// and chain wins, plus per-agent call volume.
//
//   node scripts/usage.mjs [path]
//
// `path` defaults to SEARCH_STATS_PATH, then ./search-stats.jsonl -- the same
// resolution the extension uses (src/stats.ts).
//
// This file is repo-only (package.json `files` ships `src` alone); run it from
// a git checkout, which is how pi loads the extension.
import { readFileSync } from "node:fs";
import { parseUsage, summarise, statsPath } from "../src/stats.ts";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log("usage: node scripts/usage.mjs [meter-file]");
  process.exit(0);
}

const path = args[0] ?? statsPath();

let text;
try {
  text = readFileSync(path, "utf8");
} catch (err) {
  console.error(`no usage meter at ${path}: ${err.message}`);
  process.exit(1);
}

const { records, skipped } = parseUsage(text);
if (records.length === 0) {
  console.error(
    `no usage records in ${path}` + (skipped > 0 ? ` (${skipped} unreadable line(s))` : ""),
  );
  process.exit(1);
}

const s = summarise(records);
const pct = (n, d) => (d === 0 ? "-" : ((100 * n) / d).toFixed(1));
const short = (ts) => (ts ?? "-").replace(/\.\d+Z$/, "Z");

console.log(`pi-websearch usage: ${path}`);
console.log(
  `calls ${s.calls}  answered ${s.ok} (${pct(s.ok, s.calls)}%)  ` +
    `results ${s.results}  chain ${s.chainCalls}  select ${s.selectCalls}`,
);
console.log(`range ${short(s.first)} .. ${short(s.last)}`);
console.log();

const header = ["engine", "attempts", "answers", "empties", "fails", "wins", "fail%"];
const rows = s.engines.map((e) => [
  e.engine,
  String(e.attempts),
  String(e.answers),
  String(e.empties),
  String(e.fails),
  String(e.wins),
  pct(e.fails, e.attempts),
]);
printTable(header, rows);

console.log();
const agentHeader = ["agent", "calls", "answered", "results"];
const agentRows = s.agents.map((a) => [
  a.agent,
  String(a.calls),
  String(a.ok),
  String(a.results),
]);
printTable(agentHeader, agentRows);

// A lossy meter must not read as a complete one: say what was unreadable, and
// exit non-zero so a caller piping this into a report cannot ignore it.
if (skipped > 0) {
  console.error(
    `${skipped} unreadable line(s) skipped in ${path}: the totals above are incomplete`,
  );
  process.exitCode = 2;
}

function printTable(head, body) {
  const widths = head.map((h, i) =>
    Math.max(h.length, ...body.map((row) => row[i].length)),
  );
  const line = (row) =>
    row
      .map((cell, i) =>
        i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i]),
      )
      .join("  ")
      .trimEnd();
  console.log(line(head));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of body) console.log(line(row));
}
