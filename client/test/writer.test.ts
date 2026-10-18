// Every write the client can make, built by the real Writer/KeyManager code and checked with
// @farcaster/core's own message validator (hash, Ed25519 signature, body rules). Nothing is
// sent anywhere: a fake node captures the bytes.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "homestead-writer-"));
process.env.DATA_DIR = dir;
const { CastType, Message, MessageType, NobleEd25519Signer, ReactionType, validations } = await import("@farcaster/core");
const { bytesToHex } = await import("viem");

const FID = 4242;
const privateKey = new Uint8Array(randomBytes(32));
const publicKey = (await new NobleEd25519Signer(privateKey).getSignerKey())._unsafeUnwrap();
writeFileSync(
  join(dir, "app-key.json"),
  JSON.stringify({ fid: FID, requestFid: FID, custody: "0x0", publicKey: bytesToHex(publicKey), privateKey: bytesToHex(privateKey), scopes: [], ttl: 1, addedAt: "", network: "mainnet" }),
);

const { KeyManager } = await import("../src/server/keys.js");
const { Writer } = await import("../src/server/writer.js");

const submitted: Uint8Array[] = [];
let signerLookups = 0;
const hub = {
  submitMessage: async (bytes: Uint8Array) => (submitted.push(bytes), {}),
  signersByFid: async (_fid: number, requesterFids: number[]) => {
    assert.deepEqual(requesterFids, [FID], "self-revoke must ask for the requester's app nonce");
    return { signers: [], currentUserNonce: 3, requesterFidNonces: { [FID]: 5 }, gaslessSignerCount: 1, gaslessSignerLimit: 1000 };
  },
  signer: async () => (signerLookups++ > 0 ? null : { signer: {} }),
};
const keys = new KeyManager(hub as never);
const names: Record<string, number> = { dwr: 3 };
const writer = new Writer(hub as never, keys, async (n) => names[n] ?? null);

async function lastValid() {
  const message = Message.decode(submitted.at(-1)!);
  const result = await validations.validateMessage(message);
  assert.ok(result.isOk(), result.isErr() ? result.error.message : "");
  assert.equal(message.data?.fid, FID);
  return message;
}

test("cast with a mention, a reply target and an embed", async () => {
  const parent = { fid: 3, hash: `0x${"ab".repeat(20)}` as const };
  const receipt = await writer.cast({ text: "gm @dwr 🌞", parent, embeds: ["https://example.com/x.png"] });
  const m = await lastValid();
  const body = m.data!.castAddBody!;
  assert.equal(body.text, "gm  🌞");
  assert.deepEqual(body.mentions, [3]);
  assert.deepEqual(body.mentionsPositions, [3]);
  assert.equal(body.parentCastId?.fid, 3);
  assert.equal(body.embeds[0]?.url, "https://example.com/x.png");
  assert.equal(receipt.hash, bytesToHex(m.hash));
  assert.ok(receipt.acceptedAt);
});

test("over 320 bytes becomes a LONG_CAST; over 1024 is refused", async () => {
  await writer.cast({ text: "x".repeat(500) });
  assert.equal((await lastValid()).data!.castAddBody!.type, CastType.LONG_CAST);
  await assert.rejects(writer.cast({ text: "x".repeat(1025) }), /Too long/);
});

test("non-http embeds are refused", async () => {
  await assert.rejects(writer.cast({ text: "hi", embeds: ["javascript:alert(1)"] }), /Not a valid embed/);
});

test("delete, like, unlike, recast, follow, unfollow", async () => {
  const target = { fid: 3, hash: `0x${"cd".repeat(20)}` as const };
  await writer.deleteCast(target.hash);
  assert.equal((await lastValid()).data!.type, MessageType.CAST_REMOVE);
  await writer.react("like", target);
  let m = await lastValid();
  assert.equal(m.data!.type, MessageType.REACTION_ADD);
  assert.equal(m.data!.reactionBody!.type, ReactionType.LIKE);
  await writer.react("like", target, true);
  assert.equal((await lastValid()).data!.type, MessageType.REACTION_REMOVE);
  await writer.react("recast", target);
  assert.equal((await lastValid()).data!.reactionBody!.type, ReactionType.RECAST);
  await writer.follow(3);
  m = await lastValid();
  assert.equal(m.data!.type, MessageType.LINK_ADD);
  assert.equal(m.data!.linkBody!.targetFid, 3);
  await writer.follow(3, true);
  assert.equal((await lastValid()).data!.type, MessageType.LINK_REMOVE);
});

test("receipts are marked included when the message shows up in a block", async () => {
  const receipt = await writer.cast({ text: "receipt test" });
  writer.markIncluded(receipt.hash.toUpperCase().replace("0X", "0x"), 1, 123);
  const tracked = writer.recent().find((r) => r.hash === receipt.hash)!;
  assert.deepEqual(tracked.block, { shard: 1, height: 123 });
});

test("self-revoke: KEY_REMOVE signed by the key itself, app nonce + 1", async () => {
  await keys.revokeSelf();
  const m = await lastValid();
  assert.equal(m.data!.type, MessageType.KEY_REMOVE);
  assert.equal(m.data!.keyRemoveBody!.nonce, 6);
  assert.equal(bytesToHex(m.signer), bytesToHex(publicKey));
  assert.equal(keys.current, null);
});
