import {
  CastType,
  Message,
  ReactionType,
  makeCastAdd,
  makeCastRemove,
  makeLinkAdd,
  makeLinkRemove,
  makeReactionAdd,
  makeReactionRemove,
  type HubAsyncResult,
} from "@farcaster/core";
import { bytesToHex, hexToBytes } from "viem";
import { config } from "./config.js";
import type { Hub, HexString, JsonMessage } from "./hub.js";
import type { KeyManager } from "./keys.js";
import { UserError } from "./keys.js";
import { byteLength, parseMentions } from "./text.js";

// Every write is the same four steps:
//
//   1. build the message body (cast text, reaction target, follow target)
//   2. sign it with the app key   -> hash = blake3(data)[:20], signature = ed25519(hash)
//   3. POST the protobuf bytes to /v1/submitMessage on YOUR node
//   4. wait until a validator includes it in a block, which we notice when your node
//      merges it (see Feed.onMerged) or when it can be read back
//
// Step 3 succeeding only means "your node validated it and gossiped it". A read node has no
// mempool; if gossip is lost the message never lands, so we track a receipt for each write.

export type ReceiptKind = "cast" | "delete" | "like" | "unlike" | "recast" | "unrecast" | "follow" | "unfollow";

export interface Receipt {
  hash: HexString;
  kind: ReceiptKind;
  summary: string;
  submittedAt: number;
  acceptedAt?: number;
  includedAt?: number;
  block?: { shard: number; height: number };
  error?: string;
}

export interface CastInput {
  text: string;
  parent?: { fid: number; hash: HexString };
  parentUrl?: string;
  embeds?: string[];
}

export class Writer {
  readonly receipts = new Map<string, Receipt>();

  constructor(
    private readonly hub: Hub,
    private readonly keys: KeyManager,
    private readonly resolveName: (name: string) => Promise<number | null>,
  ) {}

  private get fid(): number {
    const key = this.keys.current;
    if (!key) throw new UserError("Connect your account first.");
    return key.fid;
  }

  private get options() {
    return { fid: this.fid, network: config.network };
  }

  async cast(input: CastInput): Promise<Receipt> {
    const embeds = (input.embeds ?? []).map((url) => url.trim()).filter(Boolean);
    for (const url of embeds) {
      if (!/^https?:\/\//i.test(url) || byteLength(url) > 256) throw new UserError(`Not a valid embed URL: ${url}`);
    }
    const parsed = await parseMentions(input.text, this.resolveName);
    const bytes = byteLength(parsed.text);
    if (bytes > 1024) throw new UserError(`Too long: ${bytes} bytes (max 1024).`);
    const body = {
      ...parsed,
      // Up to 320 bytes is a normal cast; 321-1024 bytes must be marked LONG_CAST.
      type: bytes > 320 ? CastType.LONG_CAST : CastType.CAST,
      embeds: embeds.map((url) => ({ url })),
      embedsDeprecated: [],
      parentCastId: input.parent ? { fid: input.parent.fid, hash: hexToBytes(input.parent.hash) } : undefined,
      parentUrl: input.parentUrl,
    };
    const summary = input.text.length > 60 ? `${input.text.slice(0, 57)}…` : input.text;
    return this.submit("cast", summary || "(embed)", makeCastAdd(body, this.options, this.keys.signer()));
  }

  deleteCast(hash: HexString): Promise<Receipt> {
    return this.submit("delete", `delete ${hash.slice(0, 10)}`, makeCastRemove({ targetHash: hexToBytes(hash) }, this.options, this.keys.signer()));
  }

  react(kind: "like" | "recast", target: { fid: number; hash: HexString }, undo = false): Promise<Receipt> {
    const body = {
      type: kind === "like" ? ReactionType.LIKE : ReactionType.RECAST,
      targetCastId: { fid: target.fid, hash: hexToBytes(target.hash) },
    };
    const make = undo ? makeReactionRemove : makeReactionAdd;
    const receiptKind: ReceiptKind = undo ? (kind === "like" ? "unlike" : "unrecast") : kind;
    return this.submit(receiptKind, `${receiptKind} ${target.hash.slice(0, 10)}`, make(body, this.options, this.keys.signer()));
  }

  follow(targetFid: number, undo = false): Promise<Receipt> {
    const body = { type: "follow", targetFid };
    const make = undo ? makeLinkRemove : makeLinkAdd;
    return this.submit(undo ? "unfollow" : "follow", `${undo ? "unfollow" : "follow"} fid ${targetFid}`, make(body, this.options, this.keys.signer()));
  }

  /** Called by the feed's event tail when our node merges a message we submitted. */
  markIncluded(hash: string, shard: number, height: number): void {
    const receipt = this.receipts.get(hash.toLowerCase());
    if (receipt && !receipt.includedAt) {
      receipt.includedAt = Date.now();
      receipt.block = { shard, height };
    }
  }

  recent(): Receipt[] {
    return [...this.receipts.values()].sort((a, b) => b.submittedAt - a.submittedAt).slice(0, 50);
  }

  private async submit(kind: ReceiptKind, summary: string, built: HubAsyncResult<Message>): Promise<Receipt> {
    const result = await built;
    if (result.isErr()) throw new UserError(result.error.message);
    const message = result.value;
    const hash = bytesToHex(message.hash) as HexString;
    const receipt: Receipt = { hash, kind, summary, submittedAt: Date.now() };
    this.receipts.set(hash.toLowerCase(), receipt);
    try {
      const accepted: JsonMessage = await this.hub.submitMessage(Message.encode(message).finish());
      receipt.acceptedAt = Date.now();
      void accepted;
    } catch (e) {
      receipt.error = e instanceof Error ? e.message : String(e);
      throw new UserError(`Your node rejected this ${kind}: ${receipt.error}`);
    }
    this.trimReceipts();
    return receipt;
  }

  private trimReceipts(): void {
    if (this.receipts.size <= 200) return;
    const oldest = [...this.receipts.values()].sort((a, b) => a.submittedAt - b.submittedAt).slice(0, this.receipts.size - 200);
    for (const r of oldest) this.receipts.delete(r.hash.toLowerCase());
  }
}
