import { randomBytes, randomUUID } from "node:crypto";
import {
  GASLESS_KEY_ADD_EIP_712_TYPES,
  GASLESS_SIGNED_KEY_REQUEST_EIP_712_TYPES,
  KEY_TYPE_ED25519,
  KeyAddBody,
  METADATA_TYPE_SIGNED_KEY_REQUEST,
  Message,
  MessageType,
  NobleEd25519Signer,
  encodeGaslessSignedKeyRequestMetadata,
  getFarcasterTime,
  makeKeyAdd,
  makeKeyRemove,
  makeKeyRemoveBodySelfRevoke,
  validations,
  verifyGaslessKeyRequest,
  verifyKeyAdd,
} from "@farcaster/core";
import { bytesToHex, hexToBytes, isAddress } from "viem";
import { config } from "./config.js";
import type { Hub, HexString } from "./hub.js";
import { readJson, writeJson } from "./store.js";

// App keys ("signers") — the key this client signs your casts with.
//
// Your account (FID) is owned by a custody address: an Ethereum key derived from your
// recovery phrase. The custody key is powerful (it can transfer the account), so apps never
// hold it. Instead the custody key authorizes a separate Ed25519 *app key*, and the app signs
// everything with that.
//
// Since engine V16 an app key can be added without an onchain transaction ("gasless"): you
// submit a KEY_ADD message to any node, carrying two EIP-712 signatures from the custody key:
//
//   1. SignedKeyRequest — "app <requestFid> is asking for key <K>". Binds an app identity to
//      the key so one app can't pretend to be another. Homestead uses your own FID as the app.
//   2. KeyAdd — "I, owner of <fid>, authorize key <K> to sign <scopes> for a sliding <ttl>,
//      using nonce <n>, valid until <deadline>".
//
// The KEY_ADD message envelope itself is signed by K (proof that the submitter holds it).
// See https://snapchain.farcaster.xyz/guides/writing-messages

/**
 * Least privilege: these are the only message types this client's key may sign. It cannot
 * change your profile, add verifications, or mint/revoke other keys (KEY_ADD/KEY_REMOVE are
 * never admissible scopes).
 */
export const CLIENT_SCOPES: MessageType[] = [
  MessageType.CAST_ADD,
  MessageType.CAST_REMOVE,
  MessageType.REACTION_ADD,
  MessageType.REACTION_REMOVE,
  MessageType.LINK_ADD,
  MessageType.LINK_REMOVE,
];

export interface StoredKey {
  fid: number;
  requestFid: number;
  custody: HexString;
  publicKey: HexString;
  privateKey: HexString;
  scopes: number[];
  ttl: number;
  addedAt: string;
  network: string;
}

/** What the browser has to sign. Plain JSON: bigints are sent as decimal strings. */
export interface TypedDataRequest {
  domain: { name: string; version: string; chainId: number };
  types: Record<string, ReadonlyArray<{ name: string; type: string }>>;
  primaryType: "SignedKeyRequest" | "KeyAdd";
  message: Record<string, string | number | number[]>;
}

interface PendingKeyAdd {
  id: string;
  fid: number;
  custody: HexString;
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  nonce: number;
  deadline: number;
  createdAt: number;
}

export interface AccountCheck {
  fid: number;
  custody: HexString;
  username?: string;
  storageUnits: number;
  castLimit: number;
}

const KEY_FILE = "app-key.json";
const PENDING_TTL_MS = 15 * 60 * 1000;

export class KeyManager {
  private key: StoredKey | null = readJson<StoredKey | null>(KEY_FILE, null);
  private pending = new Map<string, PendingKeyAdd>();

  constructor(private readonly hub: Hub) {}

  get current(): StoredKey | null {
    return this.key;
  }

  signer(): NobleEd25519Signer {
    if (!this.key) throw new Error("this client has no app key yet");
    return new NobleEd25519Signer(hexToBytes(this.key.privateKey));
  }

  /**
   * Step 1 of onboarding. The browser derived a custody address from your phrase (or your
   * wallet told it). We look that address up on *your node*, check the account can post,
   * create a fresh key pair, and return the two payloads for the browser to sign.
   */
  async begin(custodyAddress: string): Promise<{ id: string; account: AccountCheck; requests: TypedDataRequest[] }> {
    if (!isAddress(custodyAddress)) throw new UserError("That is not an Ethereum address.");
    const custody = custodyAddress.toLowerCase() as HexString;
    const account = await this.checkAccount(custody);

    const signers = await this.hub.signersByFid(account.fid);
    const nonce = signers.currentUserNonce + 1;
    const deadline = farcasterNow() + 60 * 60; // one hour, in Farcaster seconds

    const privateKey = new Uint8Array(randomBytes(32)); // any 32 random bytes is a valid Ed25519 secret
    const publicKey = (await new NobleEd25519Signer(privateKey).getSignerKey())._unsafeUnwrap();

    const id = randomUUID();
    this.prunePending();
    this.pending.set(id, { id, fid: account.fid, custody, privateKey, publicKey, nonce, deadline, createdAt: Date.now() });

    const key = bytesToHex(publicKey);
    return {
      id,
      account,
      requests: [
        {
          domain: { ...GASLESS_SIGNED_KEY_REQUEST_EIP_712_TYPES.domain },
          types: GASLESS_SIGNED_KEY_REQUEST_EIP_712_TYPES.types,
          primaryType: "SignedKeyRequest",
          message: { requestFid: String(account.fid), key, deadline: String(deadline) },
        },
        {
          domain: { ...GASLESS_KEY_ADD_EIP_712_TYPES.domain },
          types: GASLESS_KEY_ADD_EIP_712_TYPES.types,
          primaryType: "KeyAdd",
          message: {
            fid: String(account.fid),
            key,
            keyType: KEY_TYPE_ED25519,
            scopes: CLIENT_SCOPES,
            ttl: config.keyTtlSeconds,
            nonce,
            deadline: String(deadline),
          },
        },
      ],
    };
  }

  /**
   * Step 2. The browser sends back the two signatures. We verify both recover to the custody
   * address *before* touching the network, assemble the KEY_ADD, submit it to our node, and
   * wait until the node reports the key as active.
   */
  async finish(id: string, signedKeyRequestSig: string, keyAddSig: string): Promise<StoredKey> {
    const p = this.pending.get(id);
    if (!p || Date.now() - p.createdAt > PENDING_TTL_MS) throw new UserError("This sign-in expired. Start again.");

    const custodyBytes = hexToBytes(p.custody);
    const skrSignature = hexToBytes(signedKeyRequestSig as HexString);
    const keyAddSignature = hexToBytes(keyAddSig as HexString);

    const skrOk = await verifyGaslessKeyRequest(
      { requestFid: BigInt(p.fid), key: p.publicKey, deadline: BigInt(p.deadline) },
      skrSignature,
      custodyBytes,
    );
    const keyAddOk = await verifyKeyAdd(
      {
        fid: BigInt(p.fid),
        key: p.publicKey,
        keyType: KEY_TYPE_ED25519,
        scopes: CLIENT_SCOPES,
        ttl: config.keyTtlSeconds,
        nonce: p.nonce,
        deadline: BigInt(p.deadline),
      },
      keyAddSignature,
      custodyBytes,
    );
    if (!skrOk.unwrapOr(false) || !keyAddOk.unwrapOr(false)) {
      throw new UserError("The signatures don't match this account's custody address. Was the right phrase or wallet used?");
    }

    // The metadata blob is the ABI-encoded SignedKeyRequestMetadata struct — the same layout
    // the onchain KeyGateway uses, but signed on snapchain's own EIP-712 domain.
    const metadata = encodeGaslessSignedKeyRequestMetadata({
      requestFid: BigInt(p.fid),
      requestSigner: p.custody,
      signature: skrSignature,
      deadline: BigInt(p.deadline),
    })._unsafeUnwrap();

    const body = validations
      .validateKeyAddBody(
        KeyAddBody.create({
          key: p.publicKey,
          keyType: KEY_TYPE_ED25519,
          custodySignature: keyAddSignature,
          deadline: p.deadline,
          nonce: p.nonce,
          metadata,
          metadataType: METADATA_TYPE_SIGNED_KEY_REQUEST,
          registrationTxHash: new Uint8Array(),
          scopes: CLIENT_SCOPES,
          ttl: config.keyTtlSeconds,
        }),
        farcasterNow(),
      )
      ._unsafeUnwrap();

    // Proof of possession: the envelope is signed by the new key itself.
    const appSigner = new NobleEd25519Signer(p.privateKey);
    const message = (await makeKeyAdd(body, { fid: p.fid, network: config.network }, appSigner))._unsafeUnwrap();
    await this.hub.submitMessage(Message.encode(message).finish());

    const publicKey = bytesToHex(p.publicKey);
    await waitFor(async () => (await this.hub.signer(p.fid, publicKey)) !== null, 90_000);

    this.pending.delete(id);
    const stored: StoredKey = {
      fid: p.fid,
      requestFid: p.fid,
      custody: p.custody,
      publicKey,
      privateKey: bytesToHex(p.privateKey),
      scopes: CLIENT_SCOPES,
      ttl: config.keyTtlSeconds,
      addedAt: new Date().toISOString(),
      network: config.networkName,
    };
    writeJson(KEY_FILE, stored);
    this.key = stored;
    return stored;
  }

  /**
   * The panic button. A gasless key can revoke itself: no custody signature needed, the
   * envelope signature by the key is the authorization. Uses the per-app nonce namespace.
   */
  async revokeSelf(): Promise<void> {
    const key = this.key;
    if (!key) throw new UserError("No key to revoke.");
    const signers = await this.hub.signersByFid(key.fid, [key.requestFid]);
    const appNonce = signers.requesterFidNonces?.[String(key.requestFid)] ?? 0;
    const body = makeKeyRemoveBodySelfRevoke({
      key: hexToBytes(key.publicKey),
      nonce: appNonce + 1,
      deadline: farcasterNow() + 60 * 60,
    })._unsafeUnwrap();
    const message = (await makeKeyRemove(body, { fid: key.fid, network: config.network }, this.signer()))._unsafeUnwrap();
    await this.hub.submitMessage(Message.encode(message).finish());
    await waitFor(async () => (await this.hub.signer(key.fid, key.publicKey)) === null, 90_000).catch(() => undefined);
    writeJson(KEY_FILE, null);
    this.key = null;
  }

  /** Forget the key locally without revoking it (e.g. after revoking from another app). */
  forget(): void {
    writeJson(KEY_FILE, null);
    this.key = null;
  }

  /** Look up which FID a custody address owns, using only our own node. */
  async checkAccount(custody: HexString): Promise<AccountCheck> {
    const event = await this.hub.idRegistryEventByAddress(custody);
    if (!event) {
      throw new UserError(
        "Your node has no Farcaster account for this address. Check the phrase (and the account index), " +
          "or wait until your node has finished syncing.",
      );
    }
    const fid = event.fid;

    // The address must still be the *current* custody address: accounts can be transferred.
    const history = await this.hub.onChainEventsByFid(fid, "EVENT_TYPE_ID_REGISTER");
    const latest = [...history.events].sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex).at(-1);
    if (latest?.idRegisterEventBody?.to.toLowerCase() !== custody) {
      throw new UserError(`This address used to own FID ${fid} but no longer does.`);
    }

    const storage = await this.hub.storageLimitsByFid(fid);
    const castLimit = storage.limits.find((l) => l.name === "CASTS")?.limit ?? 0;
    if (storage.units === 0 || castLimit === 0) {
      throw new UserError(`FID ${fid} has no storage, so the network won't accept its casts. Rent a storage unit first.`);
    }

    const userData = await this.hub.userDataByFid(fid).catch(() => ({ messages: [] }));
    const username = userData.messages.find((m) => m.data.userDataBody?.type === "USER_DATA_TYPE_USERNAME")?.data.userDataBody?.value;
    return { fid, custody, username, storageUnits: storage.units, castLimit };
  }

  private prunePending(): void {
    const now = Date.now();
    for (const [id, p] of this.pending) if (now - p.createdAt > PENDING_TTL_MS) this.pending.delete(id);
  }
}

/** An error whose message is safe and useful to show in the UI. */
export class UserError extends Error {}

export function farcasterNow(): number {
  return getFarcasterTime()._unsafeUnwrap();
}

export async function waitFor(check: () => Promise<boolean>, timeoutMs: number, intervalMs = 1000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out after ${timeoutMs / 1000}s`);
}
