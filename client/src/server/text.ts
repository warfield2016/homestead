// Cast text and @mentions.
//
// A mention is NOT stored in the cast text. "gm @dwr!" is stored as text "gm !" plus
// mentions=[3] and mentionsPositions=[3]: the FID, and the *byte* offset (UTF-8, not
// characters) where a client should re-insert "@username" when rendering. Emoji are several
// bytes each, which is the classic off-by-N bug in hand-rolled clients.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const MAX_MENTIONS = 10;

/**
 * Usernames on Farcaster: fnames (a-z0-9-, up to 16 chars) or ENS names ending in .eth.
 * The "@" must not follow a letter, digit, dot or underscore, so "me@example.com" isn't a
 * mention but "🤓@farcaster" is.
 */
const MENTION = /(^|[^\p{L}\p{N}_.@])@([a-z0-9][a-z0-9-]{0,19}(?:\.eth)?)\b/giu;

export interface ParsedText {
  text: string;
  mentions: number[];
  mentionsPositions: number[];
}

/**
 * Turn "hello @alice and @bob" into protocol fields. Names that don't resolve to an FID on
 * your node are left as plain text.
 */
export async function parseMentions(input: string, resolve: (name: string) => Promise<number | null>): Promise<ParsedText> {
  const mentions: number[] = [];
  const mentionsPositions: number[] = [];
  let out = "";
  let last = 0;

  for (const match of input.matchAll(MENTION)) {
    if (mentions.length >= MAX_MENTIONS) break;
    const [whole, lead = "", name = ""] = match;
    const start = (match.index ?? 0) + lead.length; // index of '@'
    const fid = await resolve(name.toLowerCase());
    if (fid === null) continue;
    out += input.slice(last, start);
    mentions.push(fid);
    mentionsPositions.push(encoder.encode(out).length);
    last = (match.index ?? 0) + whole.length;
  }
  out += input.slice(last);
  return { text: out, mentions, mentionsPositions };
}

export type Segment = { text: string } | { mention: number };

/** Split stored cast text back into plain text and mention markers, for rendering. */
export function segmentText(text: string, mentions: number[], positions: number[]): Segment[] {
  const bytes = encoder.encode(text);
  const order = positions.map((pos, i) => ({ pos, fid: mentions[i] ?? 0 })).sort((a, b) => a.pos - b.pos);
  const segments: Segment[] = [];
  let cursor = 0;
  for (const { pos, fid } of order) {
    const at = Math.min(Math.max(pos, cursor), bytes.length);
    if (at > cursor) segments.push({ text: decoder.decode(bytes.slice(cursor, at)) });
    segments.push({ mention: fid });
    cursor = at;
  }
  if (cursor < bytes.length) segments.push({ text: decoder.decode(bytes.slice(cursor)) });
  return segments;
}

export function byteLength(text: string): number {
  return encoder.encode(text).length;
}
