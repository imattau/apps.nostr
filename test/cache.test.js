import test from "node:test";
import assert from "node:assert/strict";

import { createEventCache } from "../src/cache.js";

test("event cache stores events and metadata in fallback mode", async () => {
  const cache = createEventCache({ dbName: `test-${Date.now()}` });

  await cache.clear();
  await cache.upsertEvents([
    { id: "one", kind: 31922, pubkey: "alice", created_at: 10, tags: [] },
    { id: "two", kind: 5, pubkey: "bob", created_at: 20, tags: [["e", "one"]] },
    { id: "three", kind: 31922, pubkey: "alice", created_at: 30, tags: [] },
  ]);
  await cache.saveMeta("catalogWatermark", 30);

  const listings = await cache.loadEvents({ kinds: [31922], authors: ["alice"], since: 15 });
  assert.deepEqual(
    listings.map((event) => event.id),
    ["three"],
  );
  assert.equal(await cache.loadMeta("catalogWatermark", 0), 30);
});
