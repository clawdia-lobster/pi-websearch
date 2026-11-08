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
// into one file; appends are single small writes, which are atomic on a file
// opened for append, so parallel agents do not need a lock.
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
  path: string = statsPath(),
): boolean {
  const record: UsageRecord = {
    ts: new Date().toISOString(),
    agent: process.env.AGENT || "unknown",
    ...call,
  };
  try {
    appendFileSync(path, JSON.stringify(record) + "\n", "utf8");
    return true;
  } catch (err) {
    if (!warned) {
      warned = true;
      console.error(
        `pi-websearch: usage meter disabled (${path}): ${errorText(err)}`,
      );
    }
    return false;
  }
}

/**
 * Parse a meter file, skipping lines that are not a usage record so a torn or
 * hand-edited line cannot break the whole report.
 */
export function parseUsage(text: string): UsageRecord[] {
  const records: UsageRecord[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as UsageRecord;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        Array.isArray(parsed.attempts)
      ) {
        records.push(parsed);
      }
    } catch {
      // Skip: one bad line is not a reason to lose the report.
    }
  }
  return records;
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
