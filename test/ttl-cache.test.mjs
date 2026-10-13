// Offline: the result caches expire entries and never exceed their size limit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TTLCache } from "../dist/utils/ttl-cache.js";

function clock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

test("returns values until they expire", () => {
  const c = clock();
  const cache = new TTLCache(10, c.now);
  cache.set("a", 1, 100);
  assert.equal(cache.get("a"), 1);
  c.advance(100);
  assert.equal(cache.get("a"), 1);
  c.advance(1);
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.size, 0);
});

test("never holds more than maxEntries; oldest writes go first", () => {
  const cache = new TTLCache(3, clock().now);
  for (const k of ["a", "b", "c", "d", "e"]) cache.set(k, k, 1_000);
  assert.equal(cache.size, 3);
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("b"), undefined);
  assert.deepEqual(["c", "d", "e"].map((k) => cache.get(k)), ["c", "d", "e"]);
});

test("rewriting a key makes it the newest", () => {
  const cache = new TTLCache(2, clock().now);
  cache.set("a", 1, 1_000);
  cache.set("b", 2, 1_000);
  cache.set("a", 3, 1_000);
  cache.set("c", 4, 1_000);
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("a"), 3);
  assert.equal(cache.get("c"), 4);
});

test("expired entries are dropped before live ones when full", () => {
  const c = clock();
  const cache = new TTLCache(2, c.now);
  cache.set("old-live", 1, 10_000);
  cache.set("short", 2, 10);
  c.advance(50);
  cache.set("new", 3, 10_000);
  assert.equal(cache.size, 2);
  assert.equal(cache.get("old-live"), 1);
  assert.equal(cache.get("new"), 3);
});

test("many distinct keys stay bounded", () => {
  const cache = new TTLCache(200, clock().now);
  for (let i = 0; i < 10_000; i++) cache.set(`q${i}`, i, 60_000);
  assert.equal(cache.size, 200);
  assert.equal(cache.get("q9999"), 9999);
});
