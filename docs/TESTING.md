# What has been tested, and how

Honest status as of 2026-10-19. "Verified" means run and observed, not reasoned about.

## Verified

### Client against live mainnet data (read-only demo mode)

The client was run locally with `HOMESTEAD_DEMO=true` against a public mainnet Snapchain node
(0.14.2), in desktop and 375 px mobile viewports:

- Following feed for an account with 111 follows: backfill, ordering, mention rendering, embeds.
- Client attribution on real casts: `via Warpcast`, `via Firefly App`, `via Neynar`, and
  `own key` for self-requested keys. Both paths work: gasless (`requestFid` from `/v1/signer`)
  and onchain (ABI-decoded `SignedKeyRequestMetadata`, e.g. FID 3's key → requestFid 9152).
- Live tab: casts arriving from `/v1/events` tails on shards 1 and 2, starting at `maxHeight << 14`.
- Thread view (ancestors, replies, reaction counts), raw message inspector, node status page.
- Found and handled from real data: a mainnet cast dated 2061 (kept off the top of feeds), signer
  timestamps in Unix seconds, `requesterFids[]` query encoding, `/v1/events` rejecting shard 0.

### Unit tests (`cd client && npm test`, 16 tests)

- **Offline `KEY_ADD` round trip:** `KeyManager.begin` → the browser's own `signWithPhrase`
  (a fresh random mnemonic) → `KeyManager.finish` → the submitted bytes decode to a `KEY_ADD`
  whose envelope is signed by the new key and which passes `@farcaster/core`'s
  `validations.validateMessage`. Also: wrong-phrase signatures are rejected before anything is
  submitted; the browser refuses to sign non-KeyAdd payloads.
- Mentions: byte offsets incl. the docs' emoji example; round trip text ↔ segments.
- FID → shard routing matches the node's own `/v1/fids?shard_id=` lists.
- Event id math matches the docs' example (`151622205440` ↔ block `9254285`).
- Onchain metadata decode (real mainnet bytes → 9152). App filter include/exclude logic.
- `requesterFids[]` URL encoding.

### Production build and auth

Clean `npm ci` → build → `npm prune --omit=dev` → start (what the Dockerfile does). Wrong
passphrase rejected, right one accepted, protected routes return 401 without a session, writes
without the CSRF header return 403.

### Command 0 against a mock Hetzner API

`scripts/test/mock-hetzner.mjs` mimics the documented response shapes. Verified: skips
deprecated and too-small types, picks the cheapest fit in stock, price arithmetic, creation order
(ssh key → firewall → volume → server), firewall rules, saved state, `destroy` order, bad-token
error. ShellCheck: no warnings. CLI runs under macOS `/bin/bash` 3.2.

## Not yet verified (needs a real server)

- `scripts/remote/node-setup.sh` on a fresh Hetzner/DigitalOcean Ubuntu 24.04 box (volume mount,
  `snapchain.sh upgrade` unattended, Grafana override).
- Snapshot restore + catch-up timings on the chosen hardware.
- `client-setup.sh`: image build on the server, Caddy + sslip.io certificate.
- The write path end to end on mainnet: `KEY_ADD` accepted by a node, casts/reactions/follows
  included, receipts turning green, self-revoke.
- DigitalOcean provider against the real API.

Each full run goes in [`test-runs/`](test-runs/) with date, provider, server type, Snapchain
version, timings and anything that broke.
