// Usage meter: one JSON object per search() call, appended to a shared file.
//
// The meter lives inside the extension because the alternative -- reconstructing
// per-engine volume from session transcripts -- cannot see which engine
// answered: a fallback answer records the winning engine only in this tool's
// `details.engines`, and nothing aggregates it across sessions or agents.
//
// Private by design: no query text is stored, only the agent name, engine
// names, counts, timings and a truncated error message. One line per call
// (rather than one per engine) keeps the file small and makes calls, wins and
// fan-out selections directly countable.
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";

export type AttemptOutcome = "answer" | "empty" | "fail";

/** One engine consulted during a call. */
export interface UsageAttempt {
  engine: string;
  outcome: AttemptOutcome;
  /** Results this engine returned (0 unless outcome is "answer"). */
  results: number;
  /** Wall time of the engine request. */
  ms: number;
  /** Failure detail, truncated; present only when outcome is "fail". */
  error?: string;
}

/** One completed search() call. */
export interface UsageRecord {
  /** ISO 8601 UTC timestamp. */
  ts: string;
  /** Agent that made the call (AGENT), or "unknown" outside the fleet setup. */
  agent: string;
  /** "chain" = automatic fallback; "select" = explicit engines list. */
  mode: "chain" | "select";
  /** Whether the call returned at least one result to the caller. */
  ok: boolean;
  /** Engine that answered (chain mode only); null for select and empty calls. */
  winner: string | null;
  /** Results returned to the caller, after the limit was applied. */
  results: number;
  attempts: UsageAttempt[];
}

/** A call as the search layer knows it: the meter adds timestamp and agent. */
export type UsageCall = Omit<UsageRecord, "ts" | "agent">;

// Generic default, like USEFUL_LIST_PATH: ./search-stats.jsonl in the agent's
// cwd unless SEARCH_STATS_PATH points elsewhere. Production sets a shared
// absolute path (see /pi/scripts/agent-setup.sh) so the whole fleet aggregates
// into one file. Each append is a single small write, so on a local filesystem
// parallel agents need no lock; the shared path is an NFS mount, where a torn
// or lost line is possible -- the reader counts and reports such lines rather
// than silently presenting a smaller tally as the whole story.
const DEFAULT_PATH = "search-stats.jsonl";
const MAX_ERROR_CHARS = 200;

/** Meter file: SEARCH_STATS_PATH, else ./search-stats.jsonl in the cwd. */
export function statsPath(): string {
  return resolve(process.env.SEARCH_STATS_PATH ?? DEFAULT_PATH);
}

export function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.length > MAX_ERROR_CHARS
    ? `${message.slice(0, MAX_ERROR_CHARS)}...`
    : message;
}

let warned = false;

/**
 * Append one record. Best-effort in the same sense as the useful-hit list: a
 * meter that cannot write must not break the search it measures. The failure
 * is reported once per process on stderr instead of being swallowed, so a
 * broken meter is not mistaken for an idle one. Returns whether it was written.
 */
export function recordUsage(
  call: UsageCall,
  path?: string,
): boolean {
  try {
    const record: UsageRecord = {
      ts: new Date().toISOString(),
      agent: process.env.AGENT || "unknown",
      ...call,
    };
    appendFileSync(path ?? statsPath(), JSON.stringify(record) + "\n", "utf8");
    return true;
  } catch (err) {
    if (!warned) {
      warned = true;
      console.error(
        `pi-websearch: usage meter disabled (${path ?? statsPath()}): ${errorText(err)}`,
      );
    }
    return false;
  }
}

/** Records read from a meter file, and how many lines were not records. */
export interface ParsedUsage {
  records: UsageRecord[];
  /** Lines that were not a usage record (torn write, hand edit, other data). */
  skipped: number;
}

/**
 * Parse a meter file. A line that is not a usage record is skipped rather than
 * aborting the read, but it is counted: a report that silently drops lines
 * would present a lossy meter as a complete one.
 */
export function parseUsage(text: string): ParsedUsage {
  const records: UsageRecord[] = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: UsageRecord | null = null;
    try {
      parsed = JSON.parse(trimmed) as UsageRecord;
    } catch {
      parsed = null;
    }
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      isAttemptList(parsed.attempts)
    ) {
      records.push(parsed);
    } else {
      skipped++;
    }
  }
  return { records, skipped };
}

function isAttemptList(value: unknown): value is UsageAttempt[] {
  return (
    Array.isArray(value) &&
    value.every(
      (a) =>
        typeof a === "object" &&
        a !== null &&
        typeof (a as UsageAttempt).engine === "string",
    )
  );
}

export interface EngineTally {
  engine: string;
  /** Times this engine was consulted. */
  attempts: number;
  /** Times it returned at least one result. */
  answers: number;
  /** Times it returned nothing. */
  empties: number;
  /** Times the request failed (network, HTTP, parse, timeout). */
  fails: number;
  /** Times it was the engine that answered a fallback chain. */
  wins: number;
}

export interface AgentTally {
  agent: string;
  calls: number;
  /** Calls that returned at least one result. */
  ok: number;
  /** Results returned across all calls. */
  results: number;
}

export interface UsageSummary {
  calls: number;
  ok: number;
  results: number;
  chainCalls: number;
  selectCalls: number;
  /** First and last record timestamps, or null for no records. */
  first: string | null;
  last: string | null;
  engines: EngineTally[];
  agents: AgentTally[];
}

/** Aggregate records into per-engine and per-agent tallies. */
export function summarise(records: UsageRecord[]): UsageSummary {
  const engines = new Map<string, EngineTally>();
  const agents = new Map<string, AgentTally>();
  const summary: UsageSummary = {
    calls: 0,
    ok: 0,
    results: 0,
    chainCalls: 0,
    selectCalls: 0,
    first: null,
    last: null,
    engines: [],
    agents: [],
  };

  for (const record of records) {
    summary.calls++;
    if (record.ok) summary.ok++;
    summary.results += record.results || 0;
    if (record.mode === "select") summary.selectCalls++;
    else summary.chainCalls++;
    if (record.ts) {
      if (summary.first === null || record.ts < summary.first) {
        summary.first = record.ts;
      }
      if (summary.last === null || record.ts > summary.last) {
        summary.last = record.ts;
      }
    }

    const agentName = record.agent || "unknown";
    const agent = agents.get(agentName) ?? {
      agent: agentName,
      calls: 0,
      ok: 0,
      results: 0,
    };
    agent.calls++;
    if (record.ok) agent.ok++;
    agent.results += record.results || 0;
    agents.set(agentName, agent);

    for (const attempt of record.attempts) {
      const tally = engines.get(attempt.engine) ?? {
        engine: attempt.engine,
        attempts: 0,
        answers: 0,
        empties: 0,
        fails: 0,
        wins: 0,
      };
      tally.attempts++;
      if (attempt.outcome === "answer") tally.answers++;
      else if (attempt.outcome === "fail") tally.fails++;
      else tally.empties++;
      if (record.winner === attempt.engine) tally.wins++;
      engines.set(attempt.engine, tally);
    }
  }

  summary.engines = [...engines.values()].sort(
    (a, b) =>
      b.answers - a.answers ||
      b.attempts - a.attempts ||
      a.engine.localeCompare(b.engine),
  );
  summary.agents = [...agents.values()].sort(
    (a, b) => b.calls - a.calls || a.agent.localeCompare(b.agent),
  );
  return summary;
}
