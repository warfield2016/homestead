import assert from "node:assert/strict";
import { test } from "node:test";
import { requestFidFromOnchainMetadata, requestFidOf } from "../src/server/apps.js";
import { Hub } from "../src/server/hub.js";
import { eventIdForHeight, passesFilter, shardForFid, toUnixMs, type CastView } from "../src/server/feed.js";

test("requestFid is decoded from an onchain signer's metadata", () => {
  // Real metadata of one of @dwr's (FID 3) onchain app keys, as returned by
  // /v1/signersByFid on mainnet. The requesting app is FID 9152 (the Farcaster app).
  const metadata =
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAjwAAAAAAAAAAAAAAAAALveQ3XmTo1/YR8BT7drpQNBVWWAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAZO55jgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABBmUVWQv9Ny0b1L47L0MPftfyiF8T0lECNeNpo2QK0Kv0HB3HHy1nUZ0J19bcxVHVt7jamCIeKonCMgLQe8kfOKBwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  assert.equal(requestFidFromOnchainMetadata(metadata), 9152);
});

test("gasless signers carry requestFid directly", () => {
  assert.equal(requestFidOf({ source: "SIGNER_SOURCE_OFFCHAIN", key: "0x01", keyType: 1, fid: 5, requestFid: 42 }), 42);
  assert.equal(requestFidOf({ source: "SIGNER_SOURCE_ONCHAIN", key: "0x01", keyType: 1, fid: 5 }), null);
});

test("FIDs map to message shards like snapchain's ShardRouter", () => {
  // Cross-checked against /v1/fids?shard_id=1 and ?shard_id=2 on a mainnet node:
  // shard 1 starts [1,3,5,7,11,12,15], shard 2 starts [2,4,6,8,9,10,13,14].
  for (const fid of [1, 3, 5, 7, 11, 12, 15]) assert.equal(shardForFid(fid, 2), 1, `fid ${fid}`);
  for (const fid of [2, 4, 6, 8, 9, 10, 13, 14]) assert.equal(shardForFid(fid, 2), 2, `fid ${fid}`);
});

test("event ids are height << 14", () => {
  // From the snapchain docs' /v1/events example: id 151622205440 is in block 9254285.
  assert.equal(eventIdForHeight(9254285), 151622205440);
  assert.ok(eventIdForHeight(60_000_000) < Number.MAX_SAFE_INTEGER);
});

test("Farcaster timestamps count from 2021-01-01", () => {
  assert.equal(new Date(toUnixMs(0)).toISOString(), "2021-01-01T00:00:00.000Z");
});

test("app filters include or exclude by requesting app", () => {
  const cast = { app: 9152, parent: undefined } as unknown as CastView;
  const reply = { app: 9152, parent: { fid: 1, hash: "0x" } } as unknown as CastView;
  assert.equal(passesFilter(cast, { showReplies: false, appFilter: { mode: "exclude", apps: [] } }), true);
  assert.equal(passesFilter(cast, { showReplies: false, appFilter: { mode: "exclude", apps: [9152] } }), false);
  assert.equal(passesFilter(cast, { showReplies: false, appFilter: { mode: "include", apps: [9152] } }), true);
  assert.equal(passesFilter(cast, { showReplies: false, appFilter: { mode: "include", apps: [1] } }), false);
  assert.equal(passesFilter(reply, { showReplies: false, appFilter: { mode: "exclude", apps: [] } }), false);
  assert.equal(passesFilter(reply, { showReplies: true, appFilter: { mode: "exclude", apps: [] } }), true);
});

test("array query params use literal brackets, as the node's serde_qs parser requires", () => {
  const hub = new Hub("http://127.0.0.1:3381");
  assert.equal(
    hub.url("/v1/signersByFid", { fid: 2112, requesterFids: [2112, 3], pageSize: undefined }),
    "http://127.0.0.1:3381/v1/signersByFid?fid=2112&requesterFids[]=2112&requesterFids[]=3",
  );
});
