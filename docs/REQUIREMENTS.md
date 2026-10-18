# Homestead — requirements, traced to the bounty

Source: balajis.eth, "$2048 FOR FARCASTER CLIENTS" (farcaster.xyz/balajis.eth/0x50184b62),
plus his follow-up clarifications in the same thread. Deadline: seven days from the post
(the post went up ~2026-10-17, so replies close ~2026-10-24; check the exact cast timestamp).

Every requirement below has an ID. The site, the code and the test plan refer back to these IDs.

## 1. What the bounty literally asks for

| ID | Requirement (paraphrased from the post) | How Homestead meets it | How we prove it |
|----|----|----|----|
| R1 | Collect the scattered developer docs into one place and make it "incredibly easy" | One microsite: quickstart at the top, then a tutorial that follows the three commands and explains each one | The site itself; every claim links to the source line or doc it came from |
| R2 | Exactly three commands: (0) provision compute via script, (1) set up a Snapchain read node, (2) create a client that reads from that node | `./homestead provision`, `./homestead node`, `./homestead client` | Fresh-machine run log in `docs/test-runs/` |
| R3 | The read node runs on its own, with no API keys from anyone; the user only furnishes compute | Node is the official `farcasterxyz/snapchain` image with the official mainnet compose file. No Neynar/Alchemy/Infura keys anywhere. The only credential is the cloud provider token for command 0 (or none, with `--byo`) | `grep -ri apikey` is empty; the client works with outbound internet blocked except to the node |
| R4 | Explain how writes reach the network | Tutorial section "Where your cast goes": client → own read node (`submitMessage`) → gossip `mempool` topic → validator → block → back to your node as `MERGE_MESSAGE`. Client shows each stage live | Client "receipt" panel shows accepted-at and included-at times for each write |
| R5 | Import an existing seed phrase for an account that already has storage | Onboarding screen in the client accepts a 12/24-word phrase, derives the custody address in the browser, looks up the FID on your own node, checks storage before continuing | Unit test for derivation + custody→FID check; manual run with a test account |
| R6 | Use it to issue the client its own app key (now gasless — clarification #2) | Gasless `KEY_ADD`: two EIP-712 signatures (`SignedKeyRequest` + `KeyAdd`) made in the browser; app key generated and kept on the server; envelope signed by the new key (proof of possession) | Key appears in `/v1/signersByFid` with source `SIGNER_SOURCE_OFFCHAIN`, our scopes and TTL |
| R7 | Read the feed | Following feed built from your node: follow list → per-account backfill → live tail of node events by block height | Feed renders against a synced node; unit tests for merge/order |
| R8 | Post casts | Casts, replies, @mentions (byte-offset encoding), URL embeds, delete | Cast visible via `castById` on our node and in another client |
| R9 | Follow and react | Follow/unfollow (`LINK_ADD/REMOVE`), like/recast and undo (`REACTION_ADD/REMOVE`) | Same: read back from node |
| R10 | Include/exclude casts from any other client | Every cast is attributed to the app that requested its signing key (`signer` → signer record → `requestFid` → app profile). Feed has per-app include/exclude toggles | Unit test decoding onchain metadata (e.g. requestFid 9152) and gasless `requestFid`; UI test |
| R11 | Tutorial is mobile- and desktop-friendly | Static site, single column on phones, sticky TOC on desktop, no horizontal scroll, copy buttons on every command | Checked at 375px and 1280px in a real browser |
| R12 | Explain protocol concepts as it goes: FIDs, custody addresses, app keys, Snapchain messages, read nodes vs validators, storage rent — "anything someone running a client and read node would need to know" | Concept boxes placed at the moment each concept first matters, plus a glossary. Uses real output from the reader's own node, not paraphrase | Review checklist in `docs/TUTORIAL-CHECKLIST.md` |
| R13 | Seed-phrase safety (clarification #3): test accounts only, only paste phrases into software from devs you trust, prefer delegated signer authorization | (a) Big warning before the phrase box; (b) phrase never leaves the browser tab — only two signatures are sent; (c) "Sign with wallet" option so the phrase never touches Homestead at all; (d) scoped, expiring app key; (e) one-click self-revoke | Code path audit section in tutorial; network log in test run shows no phrase on the wire |
| R14 | Not AI slop | Every command was run; every output shown is real; every protocol claim cites source. Short sentences, no filler | Human review; voucher feedback |
| R15 | MIT-licensed open-source GitHub repo | `LICENSE` (MIT), no vendored proprietary code | Repo |
| R16 | At least one other human goes through it and publicly vouches on Farcaster | Make it easy: a "Tester guide" page with expected timings/costs, a feedback issue template, and a suggested (editable) vouch cast | Link to the voucher's cast |
| R17 | Submission = reply with three URLs: microsite, repo, voucher's cast | `docs/SUBMISSION.md` with the exact reply text | — |

## 2. Clarifications from the thread (they change the build)

| ID | Clarification | Consequence |
|----|----|----|
| C1 | Read nodes *do* accept writes and relay them to validators (node-types docs updated) | Client submits to its own read node. No separate validator endpoint needed. Tutorial explains: read node has no mempool, it validates, gossips on `mempool`, stores nothing; success = "accepted for relay", not "included" |
| C2 | App keys no longer need an Optimism transaction (gasless) | No OP RPC and no ETH needed for the key. Only accounts that already have storage are required |
| C3 | Treat seed phrases like `rm -rf` | R13 |
| C4 | Outdated docs → submit PRs upstream (but not slop) | `docs/upstream/` holds each fix with evidence; PRs only after a human has reviewed them |

## 3. Things the post implies but does not spell out

| ID | Implied need | Decision |
|----|----|----|
| I1 | Real hardware: 4 vCPU, 16 GB RAM, 2 TB disk (Snapchain docs). Mainnet snapshot on 2026-10-18 = 5,691 chunks × ~70 MB ≈ 400 GB compressed; live DB ≈ 550 GB | Command 0 sizes the disk at 2 TB and prints the live price before creating anything |
| I2 | Sync takes hours | Command 1 returns once the node is downloading; `./homestead status` shows per-shard progress; command 2 waits for sync with a progress bar and can be re-run safely |
| I3 | Testers will want to stop paying | `./homestead destroy` deletes server + volume; tutorial gives the hourly cost of a one-day test |
| I4 | A client reachable from a phone needs HTTPS and a login | Caddy + `<ip>.sslip.io` (automatic Let's Encrypt), random login passphrase shown once; `--private` mode binds to localhost for SSH-tunnel-only use |
| I5 | The node exposes 3381–3383 publicly by default (official guidance) | Follow it, but explain what that means (anyone can read from and submit to your node) and how to close 3381/3383 |
| I6 | A client is identified on the network by the FID that requested its key | Default: your own FID requests the key (self-signed). Tutorial explains how a branded app would use its own app FID |
| I7 | Testers need an account "that already has storage" | Tutorial explains where to get a test account (Farcaster app, or the onchain path) and how to check storage on your own node (`/v1/storageLimitsByFid`) |

## 4. Out of scope (stated on the site, so nobody is surprised)

- Creating new Farcaster accounts (needs OP ETH; the bounty says "an account that already has storage").
- Running a validator.
- Direct messages (not part of the protocol).
- Mini apps / frames rendering.

## 5. Differentiators vs other entries

1. **Teaching depth** — the tutorial walks through a real message byte-by-byte (hash, signature, timestamp) on the reader's own node.
2. **Phrase never leaves the browser**, plus a wallet-signing path. Most guides paste the phrase into a server process.
3. **Cheapest viable hardware** with live pricing, ARM support (Snapchain publishes arm64 images) and a "bring your own box" path.
4. **Write receipts** in the UI make "accepted ≠ included" visible.
5. **Upstream fixes** found while building (see `docs/upstream/`).
