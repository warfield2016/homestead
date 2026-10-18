import { createHash } from "node:crypto";
import type { AppResolver } from "./apps.js";
import { collectPages, type Hub, type HexString, type HubEvent, type JsonMessage } from "./hub.js";
import { segmentText, type Segment } from "./text.js";

// How a client builds a feed from a node, with no indexer and no third-party API:
//
//  1. Ask the node who you follow:           GET /v1/linksByFid?fid=<you>
//  2. Backfill a few recent casts from each: GET /v1/castsByFid?fid=<them>&reverse=1
//  3. Stay live by tailing the node's event stream, per shard, starting at the current
//     block height:                          GET /v1/events?shard_index=N&from_event_id=<h<<14>
//
// Event IDs are (blockHeight << 14) | sequence, so "start from now" is just the shard's
// maxHeight from /v1/info shifted left by 14 bits. Casts, reactions, links and profiles live
// on shards 1..N, split by FID (see shardForFid). Shard 0, the block shard, orders the other
// shards' chunks and holds cross-shard state: gasless keys, storage lends and channels.

const FARCASTER_EPOCH_MS = 1609459200000;
const SEQUENCE_BITS = 14;
const MAX_FOLLOWING_CASTS = 3000;
const MAX_LIVE_CASTS = 600;

export interface CastView {
  hash: HexString;
  fid: number;
  timestamp: number; // unix ms
  text: string;
  segments: Segment[];
  embeds: Array<{ url?: string; castId?: { fid: number; hash: HexString } }>;
  parent?: { fid: number; hash: HexString };
  parentUrl?: string;
  mentions: number[];
  signer: HexString;
  app?: number; // requestFid of the app that signed it, 0 if unknown
}

export interface AppFilter {
  mode: "exclude" | "include";
  apps: number[];
}

export interface FeedPrefs {
  appFilter: AppFilter;
  showReplies: boolean;
}

export function toUnixMs(farcasterSeconds: number): number {
  return FARCASTER_EPOCH_MS + farcasterSeconds * 1000;
}

/**
 * Which message shard holds an account's casts, reactions and links: the first four bytes of
 * SHA-256 over the FID as a big-endian u32, mod the number of message shards, plus one.
 * Mirrors ShardRouter::route_fid in snapchain/src/mempool/routing.rs.
 */
export function shardForFid(fid: number, numShards: number): number {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(fid);
  return (createHash("sha256").update(bytes).digest().readUInt32BE(0) % numShards) + 1;
}

export function eventIdForHeight(height: number): number {
  // 2^14 * height stays well inside Number.MAX_SAFE_INTEGER for any realistic height.
  return height * 2 ** SEQUENCE_BITS;
}

export function toCastView(message: JsonMessage): CastView | null {
  const body = message.data.castAddBody;
  if (message.data.type !== "MESSAGE_TYPE_CAST_ADD" || !body) return null;
  return {
    hash: message.hash,
    fid: message.data.fid,
    timestamp: toUnixMs(message.data.timestamp),
    text: body.text,
    segments: segmentText(body.text, body.mentions ?? [], body.mentionsPositions ?? []),
    embeds: (body.embeds ?? []).map((e) => ({ url: e.url, castId: e.castId })),
    parent: body.parentCastId ?? undefined,
    parentUrl: body.parentUrl ?? undefined,
    mentions: body.mentions ?? [],
    signer: message.signer,
  };
}

export function passesFilter(cast: CastView, prefs: FeedPrefs): boolean {
  if (!prefs.showReplies && cast.parent) return false;
  const { mode, apps } = prefs.appFilter;
  if (apps.length === 0) return true;
  const app = cast.app ?? 0;
  return mode === "include" ? apps.includes(app) : !apps.includes(app);
}

type Listener = (message: JsonMessage, shard: number, height: number) => void;

export class Feed {
  me = 0;
  following = new Set<number>();
  likes = new Set<string>();
  recasts = new Set<string>();
  /** How many casts we've seen from each app, for the filter UI. */
  appCounts = new Map<number, number>();
  tail: Record<number, { cursor: number; height: number; lastEventAt: number }> = {};

  private followingCasts = new Map<string, CastView>();
  private sorted: CastView[] = [];
  private dirty = false;
  private live: CastView[] = [];
  private listeners: Listener[] = [];
  private tailing = false;
  private backfillInFlight = new Set<number>();

  constructor(
    private readonly hub: Hub,
    private readonly apps: AppResolver,
    private readonly backfillPerAccount: number,
  ) {}

  onMerged(listener: Listener): void {
    this.listeners.push(listener);
  }

  /** Load the follow graph and recent casts for an account. Safe to call again. */
  async loadAccount(fid: number): Promise<void> {
    this.me = fid;
    const links = await collectPages<JsonMessage>(
      (pageToken) => this.hub.linksByFid(fid, { pageSize: 1000, pageToken }) as never,
      (page) => (page as { messages: JsonMessage[] }).messages,
    );
    this.following = new Set(links.map((m) => m.data.linkBody?.targetFid ?? 0).filter((f) => f > 0));
    await Promise.all([this.backfill([fid, ...this.following]), this.loadMyReactions(fid)]);
  }

  /** Fetch the latest few casts of each account, 8 requests at a time against your node. */
  async backfill(fids: number[]): Promise<void> {
    const queue = fids.filter((f) => !this.backfillInFlight.has(f));
    queue.forEach((f) => this.backfillInFlight.add(f));
    const worker = async () => {
      for (let fid = queue.shift(); fid !== undefined; fid = queue.shift()) {
        try {
          const page = await this.hub.castsByFid(fid, { pageSize: this.backfillPerAccount, reverse: true });
          for (const message of page.messages) this.addFollowingCast(message);
        } catch {
          // one unreachable account shouldn't stall the feed
        } finally {
          this.backfillInFlight.delete(fid);
        }
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
  }

  private async loadMyReactions(fid: number): Promise<void> {
    for (const type of ["Like", "Recast"] as const) {
      const set = type === "Like" ? this.likes : this.recasts;
      const messages = await collectPages<JsonMessage>(
        (pageToken) => this.hub.reactionsByFid(fid, type, { pageSize: 500, reverse: true, pageToken }) as never,
        (page) => (page as { messages: JsonMessage[] }).messages,
        1500,
      ).catch(() => []);
      for (const m of messages) {
        const target = m.data.reactionBody?.targetCastId?.hash;
        if (target) set.add(target.toLowerCase());
      }
    }
  }

  private addFollowingCast(message: JsonMessage): void {
    const view = toCastView(message);
    if (!view || this.followingCasts.has(view.hash)) return;
    this.followingCasts.set(view.hash, view);
    this.dirty = true;
    void this.attachApp(view);
    if (this.followingCasts.size > MAX_FOLLOWING_CASTS * 1.2) this.compact();
  }

  private async attachApp(view: CastView): Promise<void> {
    if (view.app !== undefined) return;
    view.app = await this.apps.appFor(view.fid, view.signer);
    this.appCounts.set(view.app, (this.appCounts.get(view.app) ?? 0) + 1);
  }

  private compact(): void {
    const keep = this.ordered().slice(0, MAX_FOLLOWING_CASTS);
    this.followingCasts = new Map(keep.map((c) => [c.hash, c]));
    this.sorted = keep;
  }

  private ordered(): CastView[] {
    if (this.dirty) {
      this.sorted = [...this.followingCasts.values()].sort((a, b) => b.timestamp - a.timestamp);
      this.dirty = false;
    }
    return this.sorted;
  }

  private removeCast(hash: string): void {
    const key = hash.toLowerCase() as HexString;
    if (this.followingCasts.delete(key)) this.dirty = true;
    this.live = this.live.filter((c) => c.hash !== key);
  }

  /** A page of the following feed (or the live firehose), newest first, after filters. */
  async page(tab: "following" | "live", prefs: FeedPrefs, before = Infinity, limit = 30): Promise<CastView[]> {
    const source = tab === "following" ? this.ordered() : this.live;
    const out: CastView[] = [];
    const horizon = Date.now() + 15 * 60 * 1000;
    for (const cast of source) {
      if (cast.timestamp >= before) continue;
      // Nodes reject messages dated >15 min ahead, but older rules let a few far-future casts
      // in (mainnet has one "from" 2061). Don't let them squat on the top of the feed.
      if (cast.timestamp > horizon) continue;
      if (cast.app === undefined) await this.attachApp(cast);
      if (passesFilter(cast, prefs)) out.push(cast);
      if (out.length >= limit) break;
    }
    return out;
  }

  // --- the event tail ---------------------------------------------------------------------

  async startTail(): Promise<void> {
    if (this.tailing) return;
    this.tailing = true;
    const info = await this.hub.info();
    // Message shards only. Shard 0 (gasless keys, storage lends) isn't served by /v1/events:
    // on Snapchain 0.14.x it answers "Shard not found".
    for (const shard of info.shardInfos) {
      if (shard.shardId === 0) continue;
      this.tail[shard.shardId] = { cursor: eventIdForHeight(shard.maxHeight), height: shard.maxHeight, lastEventAt: Date.now() };
      void this.tailShard(shard.shardId);
    }
  }

  private async tailShard(shard: number): Promise<void> {
    const state = this.tail[shard]!;
    for (;;) {
      let received = 0;
      try {
        const { events } = await this.hub.events(shard, state.cursor, 500);
        received = events.length;
        for (const event of events) {
          this.handleEvent(event, shard);
          state.cursor = event.id + 1;
          state.height = event.blockNumber || state.height;
        }
        if (received > 0) state.lastEventAt = Date.now();
      } catch {
        // node restarting or briefly unavailable; keep trying
      }
      if (received < 500) await new Promise((r) => setTimeout(r, 1000));
    }
  }

  private handleEvent(event: HubEvent, shard: number): void {
    if (event.type === "HUB_EVENT_TYPE_MERGE_MESSAGE" && event.mergeMessageBody) {
      const message = event.mergeMessageBody.message;
      for (const listener of this.listeners) listener(message, shard, event.blockNumber);
      this.applyMerge(message);
    } else if (event.type === "HUB_EVENT_TYPE_PRUNE_MESSAGE" || event.type === "HUB_EVENT_TYPE_REVOKE_MESSAGE") {
      const message = event.pruneMessageBody?.message ?? event.revokeMessageBody?.message;
      if (message?.data.type === "MESSAGE_TYPE_CAST_ADD") this.removeCast(message.hash);
    }
  }

  private applyMerge(message: JsonMessage): void {
    const { fid, type } = message.data;
    switch (type) {
      case "MESSAGE_TYPE_CAST_ADD": {
        const view = toCastView(message);
        if (!view) return;
        // The live tail sees every cast on the network; its app is resolved only if it's
        // actually displayed (see page()), so the signer cache stays proportional to use.
        this.live.unshift(view);
        if (this.live.length > MAX_LIVE_CASTS) this.live.length = MAX_LIVE_CASTS;
        if (fid === this.me || this.following.has(fid)) this.addFollowingCast(message);
        return;
      }
      case "MESSAGE_TYPE_CAST_REMOVE": {
        const target = message.data.castRemoveBody?.targetHash;
        if (target) this.removeCast(target);
        return;
      }
    }
    if (fid !== this.me) return;
    // Our own reactions and follows, possibly made from another client: keep state in sync.
    const reaction = message.data.reactionBody;
    const target = reaction?.targetCastId?.hash?.toLowerCase();
    const set = reaction?.type === "REACTION_TYPE_LIKE" ? this.likes : this.recasts;
    if (type === "MESSAGE_TYPE_REACTION_ADD" && target) set.add(target);
    if (type === "MESSAGE_TYPE_REACTION_REMOVE" && target) set.delete(target);
    const link = message.data.linkBody;
    if (link?.type === "follow" && type === "MESSAGE_TYPE_LINK_ADD") {
      this.following.add(link.targetFid);
      void this.backfill([link.targetFid]);
    }
    if (link?.type === "follow" && type === "MESSAGE_TYPE_LINK_REMOVE") {
      this.following.delete(link.targetFid);
      for (const [hash, cast] of this.followingCasts) if (cast.fid === link.targetFid) this.followingCasts.delete(hash);
      this.dirty = true;
    }
  }
}
