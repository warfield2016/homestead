import assert from "node:assert/strict";
import { test } from "node:test";
import { byteLength, parseMentions, segmentText } from "../src/server/text.js";

const names: Record<string, number> = { dwr: 3, v: 2, farcaster: 1 };
const resolve = async (name: string) => names[name] ?? null;

test("mentions are removed from text and stored as byte offsets", async () => {
  const parsed = await parseMentions("@dwr and @v are big fans of @farcaster", resolve);
  // Same example as docs.farcaster.xyz/developers/guides/writing/casts
  assert.equal(parsed.text, " and  are big fans of ");
  assert.deepEqual(parsed.mentions, [3, 2, 1]);
  assert.deepEqual(parsed.mentionsPositions, [0, 5, 22]);
});

test("positions count UTF-8 bytes, not characters", async () => {
  // Also the docs' example: an emoji is 4 bytes, so the mention sits at byte 4.
  const parsed = await parseMentions("🤓@farcaster can mention immediately after emoji", resolve);
  assert.equal(parsed.text, "🤓 can mention immediately after emoji");
  assert.deepEqual(parsed.mentionsPositions, [4]);
});

test("unknown names and email addresses stay as plain text", async () => {
  const parsed = await parseMentions("mail me@example.com or ping @nobody", resolve);
  assert.equal(parsed.text, "mail me@example.com or ping @nobody");
  assert.deepEqual(parsed.mentions, []);
});

test("segmentText reverses parseMentions", async () => {
  const input = "gm @dwr! 🌞 and @v";
  const parsed = await parseMentions(input, resolve);
  const segments = segmentText(parsed.text, parsed.mentions, parsed.mentionsPositions);
  const fidToName = Object.fromEntries(Object.entries(names).map(([k, v]) => [v, k]));
  const rendered = segments.map((s) => ("mention" in s ? `@${fidToName[s.mention]}` : s.text)).join("");
  assert.equal(rendered, input);
});

test("byteLength", () => {
  assert.equal(byteLength("abc"), 3);
  assert.equal(byteLength("é"), 2);
  assert.equal(byteLength("🤓"), 4);
});
