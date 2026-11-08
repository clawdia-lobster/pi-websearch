// Self-check for the usage meter's record format and aggregation: npm test
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  errorText,
  parseUsage,
  recordUsage,
  summarise,
  type UsageRecord,
} from "../src/stats.ts";

const chainCall = {
  mode: "chain" as const,
  ok: true,
  winner: "mojeek",
  results: 10,
  attempts: [
    { engine: "mwmbl", outcome: "empty" as const, results: 0, ms: 120 },
    { engine: "mojeek", outcome: "answer" as const, results: 12, ms: 340 },
  ],
};

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), "websearch-stats-")), "meter.jsonl");
}

test("recordUsage appends one parseable line per call", () => {
  const path = tempFile();
  const previous = process.env.AGENT;
  process.env.AGENT = "nereus";
  try {
    assert.equal(recordUsage(chainCall, path), true);
    assert.equal(recordUsage(chainCall, path), true);
  } finally {
    if (previous === undefined) delete process.env.AGENT;
    else process.env.AGENT = previous;
  }

  const lines = readFileSync(path, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  const record = JSON.parse(lines[0]) as UsageRecord;
  assert.match(record.ts, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  assert.equal(record.agent, "nereus");
  assert.equal(record.mode, "chain");
  assert.equal(record.winner, "mojeek");
  assert.equal(record.attempts.length, 2);
  assert.equal(record.attempts[1].engine, "mojeek");
  assert.equal(record.attempts[1].outcome, "answer");
});

test("a broken meter path reports failure instead of throwing", () => {
  const missing = join(tmpdir(), "websearch-stats-absent-dir", "meter.jsonl");
  assert.equal(recordUsage(chainCall, missing), false);
});

test("parseUsage skips and counts lines that are not records", () => {
  const text = [
    JSON.stringify({ ...chainCall, ts: "2026-11-08T10:00:00.000Z", agent: "nereus" }),
    "",
    "not json",
    JSON.stringify({ ts: "2026-11-08T12:00:00.000Z" }),
    JSON.stringify({ attempts: [null] }),
    JSON.stringify({ attempts: [{}] }),
    JSON.stringify({
      ts: "2026-11-08T11:00:00.000Z",
      agent: "iris",
      mode: "select",
      ok: false,
      winner: null,
      results: 0,
      attempts: [{ engine: "ddg", outcome: "fail", results: 0, ms: 15, error: "ddg returned 500" }],
    }),
  ].join("\n");

  const { records, skipped } = parseUsage(text);
  assert.equal(records.length, 2);
  assert.equal(skipped, 4);
  assert.equal(records[1].agent, "iris");
  assert.equal(records[1].attempts[0].outcome, "fail");
});

test("summarise tallies engines, wins and agents", () => {
  const records: UsageRecord[] = [
    { ...chainCall, ts: "2026-11-08T10:00:00.000Z", agent: "nereus" },
    {
      ts: "2026-11-08T11:00:00.000Z",
      agent: "iris",
      mode: "select",
      ok: true,
      winner: null,
      results: 3,
      attempts: [
        { engine: "ddg", outcome: "answer", results: 3, ms: 90 },
        { engine: "marginalia", outcome: "fail", results: 0, ms: 20, error: "timeout" },
      ],
    },
    {
      ts: "2026-11-08T12:00:00.000Z",
      agent: "iris",
      mode: "chain",
      ok: false,
      winner: null,
      results: 0,
      attempts: [
        { engine: "mwmbl", outcome: "fail", results: 0, ms: 10, error: "mwmbl returned 503" },
        { engine: "ddg", outcome: "empty", results: 0, ms: 30 },
      ],
    },
  ];

  const s = summarise(records);
  assert.equal(s.calls, 3);
  assert.equal(s.ok, 2);
  assert.equal(s.results, 13);
  assert.equal(s.chainCalls, 2);
  assert.equal(s.selectCalls, 1);
  assert.equal(s.first, "2026-11-08T10:00:00.000Z");
  assert.equal(s.last, "2026-11-08T12:00:00.000Z");

  const byEngine = Object.fromEntries(s.engines.map((e) => [e.engine, e]));
  assert.deepEqual(byEngine.mwmbl, {
    engine: "mwmbl",
    attempts: 2,
    answers: 0,
    empties: 1,
    fails: 1,
    wins: 0,
  });
  assert.deepEqual(byEngine.mojeek, {
    engine: "mojeek",
    attempts: 1,
    answers: 1,
    empties: 0,
    fails: 0,
    wins: 1,
  });
  assert.equal(byEngine.ddg.attempts, 2);
  assert.equal(byEngine.ddg.answers, 1);
  assert.equal(byEngine.ddg.empties, 1);
  assert.equal(byEngine.marginalia.fails, 1);

  const byAgent = Object.fromEntries(s.agents.map((a) => [a.agent, a]));
  assert.deepEqual(byAgent.nereus, { agent: "nereus", calls: 1, ok: 1, results: 10 });
  assert.deepEqual(byAgent.iris, { agent: "iris", calls: 2, ok: 1, results: 3 });
});

test("errorText bounds the stored failure detail", () => {
  assert.equal(errorText(new Error("short")), "short");
  assert.equal(errorText("plain"), "plain");
  const long = errorText(new Error("x".repeat(500)));
  assert.equal(long.length, 203);
  assert.ok(long.endsWith("..."));
});

test("the meter file survives a torn final line", () => {
  const path = tempFile();
  recordUsage(chainCall, path);
  writeFileSync(path, readFileSync(path, "utf8") + '{"ts":"2026-11-08T13:0', "utf8");

  const { records, skipped } = parseUsage(readFileSync(path, "utf8"));
  assert.equal(records.length, 1);
  assert.equal(skipped, 1);
});
