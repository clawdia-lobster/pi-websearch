// Self-check for the search() -> meter wiring, using stub engines so the
// fallback and selection rules (and the record they produce) are pinned
// without touching the network: npm test
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { search, searchWithEngines, type Engine } from "../src/search.ts";
import { parseUsage, type UsageRecord } from "../src/stats.ts";

const result = (url: string) => ({ title: url, url, snippet: "" });

function stub(
  name: string,
  behaviour: "answer" | "empty" | "throw",
  count = 2,
  selectOnly = false,
): Engine {
  return {
    name,
    available: true,
    selectOnly,
    async search() {
      if (behaviour === "throw") throw new Error(`${name} is down`);
      if (behaviour === "empty") return [];
      return Array.from({ length: count }, (_, i) => result(`https://${name}.test/${i}`));
    },
  };
}

/** Run `fn` with SEARCH_STATS_PATH pointed at a fresh file; return the records. */
async function metered(fn: () => Promise<unknown>): Promise<{
  records: UsageRecord[];
  skipped: number;
}> {
  const path = join(mkdtempSync(join(tmpdir(), "websearch-wiring-")), "meter.jsonl");
  const previous = process.env.SEARCH_STATS_PATH;
  process.env.SEARCH_STATS_PATH = path;
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env.SEARCH_STATS_PATH;
    else process.env.SEARCH_STATS_PATH = previous;
  }
  assert.ok(existsSync(path), "the call must write a meter record");
  return parseUsage(readFileSync(path, "utf8"));
}

test("a chain win records the winner, the attempts and the post-limit count", async () => {
  const { records } = await metered(() =>
    searchWithEngines([stub("first", "empty"), stub("second", "answer", 5)], "q", {
      limit: 3,
    }),
  );

  assert.equal(records.length, 1);
  const record = records[0];
  assert.equal(record.mode, "chain");
  assert.equal(record.ok, true);
  assert.equal(record.winner, "second");
  assert.equal(record.results, 3, "results counts what the caller received");
  assert.deepEqual(
    record.attempts.map((a) => [a.engine, a.outcome, a.results]),
    [
      ["first", "empty", 0],
      ["second", "answer", 5],
    ],
  );
  assert.ok(record.attempts.every((a) => typeof a.ms === "number" && a.ms >= 0));
});

test("an exhausted chain records every failure and reports no answer", async () => {
  const { records } = await metered(() =>
    searchWithEngines([stub("one", "throw"), stub("two", "throw")], "q"),
  );

  const record = records[0];
  assert.equal(record.ok, false);
  assert.equal(record.winner, null);
  assert.equal(record.results, 0);
  assert.deepEqual(
    record.attempts.map((a) => [a.engine, a.outcome, a.error]),
    [
      ["one", "fail", "one is down"],
      ["two", "fail", "two is down"],
    ],
  );
});

test("explicit selection records fan-out mode, a merged count and no winner", async () => {
  const { records } = await metered(() =>
    searchWithEngines(
      [stub("good", "answer"), stub("bad", "throw"), stub("niche", "answer")],
      "q",
      { engines: ["good", "bad"] },
    ),
  );

  const record = records[0];
  assert.equal(record.mode, "select");
  assert.equal(record.winner, null);
  assert.equal(record.ok, true);
  assert.equal(record.results, 2);
  assert.deepEqual(
    record.attempts.map((a) => [a.engine, a.outcome]),
    [
      ["good", "answer"],
      ["bad", "fail"],
    ],
  );
});

test("a selection-only engine runs when explicitly chosen, never as a fallback", async () => {
  const registry = [stub("main", "empty"), stub("niche", "answer", 1, true)];

  const chain = await metered(() => searchWithEngines(registry, "q"));
  assert.deepEqual(chain.records[0].attempts.map((a) => a.engine), ["main"]);

  const selected = await metered(() =>
    searchWithEngines(registry, "q", { engines: ["niche"] }),
  );
  assert.deepEqual(selected.records[0].attempts.map((a) => a.engine), ["niche"]);
  assert.equal(selected.records[0].ok, true);
});

test("a rejected call is not metered", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "websearch-wiring-")), "meter.jsonl");
  const previous = process.env.SEARCH_STATS_PATH;
  process.env.SEARCH_STATS_PATH = path;
  try {
    await assert.rejects(
      () => searchWithEngines([stub("good", "answer")], "q", { engines: ["nope"] }),
      /unknown engine/,
    );
    await assert.rejects(
      () => searchWithEngines([stub("good", "answer")], "q", { engines: [] }),
      /must not be empty/,
    );
  } finally {
    if (previous === undefined) delete process.env.SEARCH_STATS_PATH;
    else process.env.SEARCH_STATS_PATH = previous;
  }
  assert.equal(existsSync(path), false, "no engine ran, so nothing is metered");
});

test("limit 0 is clamped so an answer is not recorded as a win with no results", async () => {
  const { records } = await metered(() =>
    searchWithEngines([stub("only", "answer", 4)], "q", { limit: 0 }),
  );
  const record = records[0];
  assert.equal(record.ok, true);
  assert.equal(record.winner, "only");
  assert.equal(record.results, 1);
});

test("search() uses the built-in registry and rejects unknown names", () => {
  assert.ok(search);
  // The default registry is not queried here: this only pins that the public
  // entry point delegates (its engine names are validated against the real
  // registry, which contains no "stub").
  return assert.rejects(() => search("q", { engines: ["stub"] }), /unknown engine/);
});
