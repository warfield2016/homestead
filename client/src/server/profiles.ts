import type { Hub } from "./hub.js";

// Profiles are USER_DATA_ADD messages: one per field (username, display name, pfp, bio...).
// The latest message for each field wins. We cache them briefly; they rarely change.

export interface Profile {
  fid: number;
  username?: string;
  displayName?: string;
  pfp?: string;
  bio?: string;
  url?: string;
}

const TTL_MS = 10 * 60 * 1000;
const FIELDS: Record<string, keyof Profile> = {
  USER_DATA_TYPE_USERNAME: "username",
  USER_DATA_TYPE_DISPLAY: "displayName",
  USER_DATA_TYPE_PFP: "pfp",
  USER_DATA_TYPE_BIO: "bio",
  USER_DATA_TYPE_URL: "url",
};

export class Profiles {
  private cache = new Map<number, { at: number; profile: Promise<Profile> }>();

  constructor(private readonly hub: Hub) {}

  get(fid: number): Promise<Profile> {
    const hit = this.cache.get(fid);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.profile;
    const profile = this.load(fid);
    this.cache.set(fid, { at: Date.now(), profile });
    return profile;
  }

  async many(fids: Iterable<number>): Promise<Record<number, Profile>> {
    const unique = [...new Set(fids)].filter((f) => f > 0);
    const entries = await Promise.all(unique.map(async (fid) => [fid, await this.get(fid)] as const));
    return Object.fromEntries(entries);
  }

  /** Resolve "@name" to an FID using the username proofs your node stores. */
  async fidByName(name: string): Promise<number | null> {
    const proof = await this.hub.userNameProofByName(name.replace(/^@/, "").toLowerCase()).catch(() => null);
    return proof?.fid ?? null;
  }

  private async load(fid: number): Promise<Profile> {
    const profile: Profile = { fid };
    try {
      const page = await this.hub.userDataByFid(fid);
      for (const message of page.messages) {
        const body = message.data.userDataBody;
        const field = body && FIELDS[body.type];
        if (field && body.value) (profile as unknown as Record<string, unknown>)[field] = body.value;
      }
    } catch {
      // A profile is decoration; a failed lookup should never break the feed.
    }
    return profile;
  }
}
