// Offline end-to-end test of "issue the client its own app key":
//   KeyManager.begin  -> the payloads the server asks the browser to sign
//   signWithPhrase    -> the exact browser code, signing with a throwaway recovery phrase
//   KeyManager.finish -> verifies, assembles KEY_ADD, "submits" it to a fake node
// Then @farcaster/core's own validator checks the KEY_ADD bytes we would have sent.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { english, generateMnemonic, mnemonicToAccount } from "viem/accounts";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "homestead-test-"));
process.env.HOMESTEAD_NETWORK = "mainnet";

const { Message, MessageType, validations } = await import("@farcaster/core");
const { KeyManager, CLIENT_SCOPES } = await import("../src/server/keys.js");
const { assertSafeToSign, signWithPhrase } = await import("../src/web/signing.js");

const phrase = generateMnemonic(english);
const custody = mnemonicToAccount(phrase).address.toLowerCase();
const FID = 123456;

function fakeHub() {
  const submitted: Uint8Array[] = [];
  let keyActive = false;
  const hub = {
    submitted,
    idRegistryEventByAddress: async (address: string) => (address === custody ? { fid: FID } : null),
    onChainEventsByFid: async () => ({ events: [{ blockNumber: 1, logIndex: 0, idRegisterEventBody: { to: custody } }] }),
    storageLimitsByFid: async () => ({ units: 1, limits: [{ name: "CASTS", limit: 100, used: 0 }] }),
    userDataByFid: async () => ({ messages: [] }),
    signersByFid: async () => ({ signers: [], currentUserNonce: 7, gaslessSignerCount: 0, gaslessSignerLimit: 1000 }),
    submitMessage: async (bytes: Uint8Array) => {
      submitted.push(bytes);
      keyActive = true;
      return {};
    },
    signer: async () => (keyActive ? { signer: {} } : null),
  };
  return hub;
}

test("KEY_ADD built from browser signatures passes @farcaster/core validation", async () => {
  const hub = fakeHub();
  const keys = new KeyManager(hub as never);

  const begin = await keys.begin(custody);
  assert.equal(begin.account.fid, FID);
  assert.equal(begin.requests.length, 2);
  const keyAdd = begin.requests.find((r) => r.primaryType === "KeyAdd")!;
  assert.equal(keyAdd.message.nonce, 8, "nonce must be currentUserNonce + 1");
  assert.deepEqual(keyAdd.message.scopes, CLIENT_SCOPES);

  const signatures = await signWithPhrase(phrase, 0, begin.requests as never);
  const stored = await keys.finish(begin.id, signatures[0]!, signatures[1]!);
  assert.equal(stored.fid, FID);
  assert.equal(hub.submitted.length, 1);

  const message = Message.decode(hub.submitted[0]!);
  assert.equal(message.data?.type, MessageType.KEY_ADD);
  assert.equal(message.data?.fid, FID);
  // The envelope is signed by the new app key itself (proof of possession).
  assert.equal(Buffer.from(message.signer).toString("hex"), stored.publicKey.slice(2));
  const valid = await validations.validateMessage(message);
  assert.ok(valid.isOk(), valid.isErr() ? valid.error.message : "");
});

test("signatures from the wrong phrase are rejected before anything is submitted", async () => {
  const hub = fakeHub();
  const keys = new KeyManager(hub as never);
  const begin = await keys.begin(custody);
  const otherPhrase = generateMnemonic(english);
  const signatures = await signWithPhrase(otherPhrase, 0, begin.requests as never);
  await assert.rejects(keys.finish(begin.id, signatures[0]!, signatures[1]!), /custody address/);
  assert.equal(hub.submitted.length, 0);
});

test("the browser refuses to sign anything but the two app-key payloads", () => {
  const transfer = {
    domain: { name: "Farcaster IdRegistry", version: "1", chainId: 10 },
    types: { Transfer: [{ name: "fid", type: "uint256" }] },
    primaryType: "KeyAdd",
    message: { fid: "1" },
  };
  assert.throws(() => assertSafeToSign(transfer as never), /Refusing to sign/);
});

test("an address that doesn't own an FID is a friendly error", async () => {
  const keys = new KeyManager(fakeHub() as never);
  await assert.rejects(keys.begin("0x000000000000000000000000000000000000dEaD"), /no Farcaster account/);
});
