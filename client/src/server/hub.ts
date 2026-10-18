// A small typed client for a Snapchain node's HTTP API (port 3381).
//
// Everything Homestead knows about the network comes through this file, and every call is
// a plain GET you can reproduce with curl against your own node. Writes are a single
// POST of protobuf bytes to /v1/submitMessage.
//
// Reference: https://snapchain.farcaster.xyz/reference/httpapi/httpapi

export type HexString = `0x${string}`;

export interface JsonMessage {
  data: {
    type: string; // e.g. "MESSAGE_TYPE_CAST_ADD"
    fid: number;
    timestamp: number; // seconds since the Farcaster epoch (2021-01-01T00:00:00Z)
    network: string;
    castAddBody?: JsonCastAddBody;
    castRemoveBody?: { targetHash: HexString };
    reactionBody?: { type: string; targetCastId?: JsonCastId; targetUrl?: string };
    linkBody?: { type: string; targetFid: number; displayTimestamp?: number };
    userDataBody?: { type: string; value: string };
    keyAddBody?: Record<string, unknown>;
    keyRemoveBody?: Record<string, unknown>;
  };
  hash: HexString;
  hashScheme: string;
  signature: string; // base64
  signatureScheme: string;
  signer: HexString; // Ed25519 public key that signed this message (the app key)
}

export interface JsonCastId {
  fid: number;
  hash: HexString;
}

export interface JsonCastAddBody {
  text: string;
  embeds: Array<{ url?: string; castId?: JsonCastId }>;
  embedsDeprecated: string[];
  mentions: number[];
  mentionsPositions: number[];
  parentCastId?: JsonCastId | null;
  parentUrl?: string | null;
  type?: string; // "CAST" | "LONG_CAST" | ...
}

export interface MessagesPage {
  messages: JsonMessage[];
  nextPageToken?: string | null;
}

export interface ShardInfo {
  shardId: number;
  maxHeight: number;
  numMessages: number;
  numFidRegistrations: number;
  approxSize: number;
  blockDelay: number;
  mempoolSize: number;
}

export interface NodeInfo {
  dbStats: { numMessages: number; numFidRegistrations: number; approxSize: number };
  numShards: number;
  shardInfos: ShardInfo[];
  version: string;
  peer_id: string;
  nextEngineVersionTimestamp?: number;
}

export interface JsonOnChainEvent {
  type: string;
  chainId: number;
  blockNumber: number;
  blockHash: HexString;
  blockTimestamp: number;
  transactionHash: HexString;
  logIndex: number;
  fid: number;
  txIndex: number;
  version: number;
  idRegisterEventBody?: { to: HexString; eventType: string; from: HexString; recoveryAddress: HexString };
  signerEventBody?: { key: HexString; keyType: number; eventType: string; metadata: string; metadataType: number };
  storageRentEventBody?: { payer: HexString; units: number; expiry: number };
}

export interface JsonSigner {
  source: "SIGNER_SOURCE_ONCHAIN" | "SIGNER_SOURCE_OFFCHAIN" | "SIGNER_SOURCE_NONE";
  key: HexString;
  keyType: number;
  fid: number;
  addedAt?: number;
  lastUsedAt?: number;
  ttl?: number;
  expiresAt?: number;
  scopes?: string[] | null;
  requestFid?: number | null;
  nonce?: number;
  onChainEvent?: JsonOnChainEvent;
}

export interface SignersPage {
  signers: JsonSigner[];
  nextPageToken?: string | null;
  gaslessSignerCount: number;
  gaslessSignerLimit: number;
  currentUserNonce: number;
  requesterFidNonces?: Record<string, number>;
}

export interface StorageLimits {
  limits: Array<{ storeType: string; name: string; limit: number; used: number }>;
  units: number;
  unitDetails: Array<{ unitType: string; unitSize: number }>;
  tier_subscriptions?: Array<{ tier_type: string; expires_at: number }>;
}

export interface HubEvent {
  type: string; // "HUB_EVENT_TYPE_MERGE_MESSAGE", "HUB_EVENT_TYPE_BLOCK_CONFIRMED", ...
  id: number;
  blockNumber: number;
  shardIndex: number;
  mergeMessageBody?: { message: JsonMessage; deletedMessages: JsonMessage[] };
  pruneMessageBody?: { message: JsonMessage };
  revokeMessageBody?: { message: JsonMessage };
  blockConfirmedBody?: { blockNumber: number; shardIndex: number; timestamp: number; totalEvents: number };
}

export class HubError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: string,
  ) {
    super(`node returned ${status} for ${path}: ${HubError.detail(body)}`);
  }

  // Snapchain errors come back as JSON with a human-readable `details` (or `error_detail`).
  static detail(body: string): string {
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      return String(parsed.details ?? parsed.error_detail ?? parsed.errCode ?? parsed.error ?? body);
    } catch {
      return body.slice(0, 300);
    }
  }

  get isNotFound(): boolean {
    return this.status === 404 || /not_found|not found/i.test(this.body);
  }
}

type Params = Record<string, string | number | boolean | undefined | Array<string | number>>;

export interface PageOptions {
  pageSize?: number;
  reverse?: boolean;
  pageToken?: string;
}

export class Hub {
  constructor(
    readonly baseUrl: string,
    private readonly timeoutMs = 15_000,
  ) {}

  url(path: string, params: Params = {}): string {
    const url = new URL(path, this.baseUrl);
    const arrays: string[] = [];
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        // The node parses queries with serde_qs, which wants `key[]=a&key[]=b` with literal
        // brackets. A repeated `key=a&key=b` is rejected, and percent-encoded brackets
        // (what URLSearchParams would produce) are silently ignored.
        for (const v of value) arrays.push(`${encodeURIComponent(key)}[]=${encodeURIComponent(String(v))}`);
      } else {
        url.searchParams.set(key, String(value));
      }
    }
    const query = [url.searchParams.toString(), ...arrays].filter(Boolean).join("&");
    return `${url.origin}${url.pathname}${query ? `?${query}` : ""}`;
  }

  async get<T>(path: string, params: Params = {}): Promise<T> {
    const response = await fetch(this.url(path, params), { signal: AbortSignal.timeout(this.timeoutMs) });
    const text = await response.text();
    if (!response.ok) throw new HubError(response.status, path, text);
    return JSON.parse(text) as T;
  }

  /** Returns null instead of throwing when the node says the thing does not exist. */
  async maybe<T>(path: string, params: Params = {}): Promise<T | null> {
    try {
      return await this.get<T>(path, params);
    } catch (e) {
      if (e instanceof HubError && (e.isNotFound || e.status === 400)) return null;
      throw e;
    }
  }

  private page(options: PageOptions = {}): Params {
    return {
      pageSize: options.pageSize,
      reverse: options.reverse ? true : undefined,
      pageToken: options.pageToken || undefined,
    };
  }

  // --- node ---------------------------------------------------------------------------

  info(): Promise<NodeInfo> {
    return this.get("/v1/info");
  }

  // --- casts ---------------------------------------------------------------------------

  castsByFid(fid: number, options?: PageOptions): Promise<MessagesPage> {
    return this.get("/v1/castsByFid", { fid, ...this.page(options) });
  }

  castById(fid: number, hash: string): Promise<JsonMessage | null> {
    return this.maybe("/v1/castById", { fid, hash });
  }

  castsByParent(fid: number, hash: string, options?: PageOptions): Promise<MessagesPage> {
    return this.get("/v1/castsByParent", { fid, hash, ...this.page(options) });
  }

  castsByMention(fid: number, options?: PageOptions): Promise<MessagesPage> {
    return this.get("/v1/castsByMention", { fid, ...this.page(options) });
  }

  // --- links (follows) -----------------------------------------------------------------

  linksByFid(fid: number, options?: PageOptions): Promise<MessagesPage> {
    return this.get("/v1/linksByFid", { fid, link_type: "follow", ...this.page(options) });
  }

  linkById(fid: number, targetFid: number): Promise<JsonMessage | null> {
    return this.maybe("/v1/linkById", { fid, target_fid: targetFid, link_type: "follow" });
  }

  // --- reactions -----------------------------------------------------------------------

  reactionsByFid(fid: number, reactionType: "Like" | "Recast", options?: PageOptions): Promise<MessagesPage> {
    return this.get("/v1/reactionsByFid", { fid, reaction_type: reactionType, ...this.page(options) });
  }

  reactionsByCast(targetFid: number, targetHash: string, reactionType: "Like" | "Recast", options?: PageOptions): Promise<MessagesPage> {
    return this.get("/v1/reactionsByCast", {
      target_fid: targetFid,
      target_hash: targetHash,
      reaction_type: reactionType,
      ...this.page(options),
    });
  }

  reactionById(fid: number, reactionType: "Like" | "Recast", targetFid: number, targetHash: string): Promise<JsonMessage | null> {
    return this.maybe("/v1/reactionById", { fid, reaction_type: reactionType, target_fid: targetFid, target_hash: targetHash });
  }

  // --- profiles and names --------------------------------------------------------------

  userDataByFid(fid: number): Promise<MessagesPage> {
    return this.get("/v1/userDataByFid", { fid });
  }

  userNameProofByName(name: string): Promise<{ name: string; fid: number; owner: HexString; type: string } | null> {
    return this.maybe("/v1/userNameProofByName", { name });
  }

  // --- onchain state (mirrored from OP Mainnet by the node) -----------------------------

  /** The ID registry event for a custody address: this is how a wallet address maps to an FID. */
  idRegistryEventByAddress(address: string): Promise<JsonOnChainEvent | null> {
    return this.maybe("/v1/onChainIdRegistryEventByAddress", { address });
  }

  onChainEventsByFid(fid: number, eventType: string): Promise<{ events: JsonOnChainEvent[]; nextPageToken?: string }> {
    return this.get("/v1/onChainEventsByFid", { fid, event_type: eventType });
  }

  storageLimitsByFid(fid: number): Promise<StorageLimits> {
    return this.get("/v1/storageLimitsByFid", { fid });
  }

  // --- signers (app keys) ---------------------------------------------------------------
  // /v1/signersByFid and /v1/signer return onchain *and* gasless keys in one list.
  // They exist in snapchain's HTTP server but (as of 2026-10) are missing from the HTTP docs.

  signersByFid(fid: number, requesterFids: number[] = [], options?: PageOptions): Promise<SignersPage> {
    return this.get("/v1/signersByFid", { fid, requesterFids, ...this.page(options) });
  }

  signer(fid: number, key: string): Promise<{ signer: JsonSigner } | null> {
    return this.maybe("/v1/signer", { fid, signer: key });
  }

  // --- events (the node's change feed, per shard) ---------------------------------------

  events(shardIndex: number, fromEventId: number, pageSize = 1000): Promise<{ events: HubEvent[]; nextPageToken?: string | null }> {
    return this.get("/v1/events", { from_event_id: fromEventId, shard_index: shardIndex, pageSize });
  }

  // --- writes --------------------------------------------------------------------------

  /**
   * Submit protobuf-encoded message bytes. On a read node, a 200 means "validated and gossiped
   * to validators", not "included in a block". Confirm inclusion separately.
   */
  async submitMessage(bytes: Uint8Array): Promise<JsonMessage> {
    const response = await fetch(this.url("/v1/submitMessage"), {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: bytes as unknown as BodyInit,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) throw new HubError(response.status, "/v1/submitMessage", text);
    return JSON.parse(text) as JsonMessage;
  }

  /** Same validation as submit, without relaying. Useful for testing message construction. */
  async validateMessage(bytes: Uint8Array): Promise<{ valid: boolean; message?: JsonMessage }> {
    const response = await fetch(this.url("/v1/validateMessage"), {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: bytes as unknown as BodyInit,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) throw new HubError(response.status, "/v1/validateMessage", text);
    return JSON.parse(text) as { valid: boolean; message?: JsonMessage };
  }
}

/** Walk every page of a paginated endpoint. `limit` caps the total number of items. */
export async function collectPages<T>(
  fetchPage: (pageToken?: string) => Promise<{ nextPageToken?: string | null } & Record<string, unknown>>,
  pick: (page: Record<string, unknown>) => T[],
  limit = Infinity,
): Promise<T[]> {
  const out: T[] = [];
  let token: string | undefined;
  do {
    const page = await fetchPage(token);
    out.push(...pick(page));
    token = page.nextPageToken || undefined;
  } while (token && out.length < limit);
  return out.slice(0, limit);
}
