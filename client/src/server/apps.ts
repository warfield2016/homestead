import { decodeAbiParameters, type Hex } from "viem";
import type { Hub, JsonSigner } from "./hub.js";
import { readJson, writeJson } from "./store.js";

// "Which client posted this?"
//
// Farcaster messages don't carry a client name. They carry `signer`: the public key of the
// app key that signed them. Every app key was requested by some app, identified by that
// app's own FID (`requestFid`). So:
//
//     cast.signer  ->  signer record on your node  ->  requestFid  ->  that FID's profile
//
// For gasless keys the node returns `requestFid` directly. For older onchain keys it is
// inside the ABI-encoded SignedKeyRequestMetadata of the KeyRegistry `Add` event, so we
// decode it ourselves. The result never changes for a given key, so it is cached on disk.

const SIGNED_KEY_REQUEST_METADATA = [
  {
    type: "tuple",
    components: [
      { name: "requestFid", type: "uint256" },
      { name: "requestSigner", type: "address" },
      { name: "signature", type: "bytes" },
      { name: "deadline", type: "uint256" },
    ],
  },
] as const;

/** Decode the base64 `metadata` of an onchain signer event into the requesting app's FID. */
export function requestFidFromOnchainMetadata(metadataBase64: string): number | null {
  try {
    const hex = `0x${Buffer.from(metadataBase64, "base64").toString("hex")}` as Hex;
    const [decoded] = decodeAbiParameters(SIGNED_KEY_REQUEST_METADATA, hex);
    return Number(decoded.requestFid);
  } catch {
    return null;
  }
}

export function requestFidOf(signer: JsonSigner): number | null {
  if (signer.requestFid) return signer.requestFid;
  const metadata = signer.onChainEvent?.signerEventBody?.metadata;
  return metadata ? requestFidFromOnchainMetadata(metadata) : null;
}

const CACHE_FILE = "signer-apps.json";
const UNKNOWN = 0;

export class AppResolver {
  // key: `${fid}:${signerHex}` -> requestFid (0 = unknown)
  private cache = new Map<string, number>(Object.entries(readJson<Record<string, number>>(CACHE_FILE, {})));
  private inflight = new Map<string, Promise<number>>();
  private dirty = false;

  constructor(private readonly hub: Hub) {
    setInterval(() => this.flush(), 30_000).unref();
  }

  /** The FID of the app that published a message, or 0 if the node doesn't know the key. */
  async appFor(fid: number, signer: string): Promise<number> {
    const id = `${fid}:${signer.toLowerCase()}`;
    const cached = this.cache.get(id);
    if (cached !== undefined) return cached;
    let promise = this.inflight.get(id);
    if (!promise) {
      promise = this.lookup(fid, signer).then((requestFid) => {
        this.cache.set(id, requestFid);
        this.dirty = true;
        this.inflight.delete(id);
        return requestFid;
      });
      this.inflight.set(id, promise);
    }
    return promise;
  }

  /** Synchronous peek, for code paths that must not wait (e.g. filtering an already-resolved page). */
  peek(fid: number, signer: string): number | undefined {
    return this.cache.get(`${fid}:${signer.toLowerCase()}`);
  }

  private async lookup(fid: number, signer: string): Promise<number> {
    try {
      const response = await this.hub.signer(fid, signer);
      return (response && requestFidOf(response.signer)) || UNKNOWN;
    } catch {
      return UNKNOWN;
    }
  }

  flush(): void {
    if (!this.dirty) return;
    writeJson(CACHE_FILE, Object.fromEntries(this.cache), 0o644);
    this.dirty = false;
  }
}
