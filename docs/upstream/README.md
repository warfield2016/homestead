# Upstream documentation fixes

Found while checking every claim in the Homestead tutorial against the Snapchain source and a
live mainnet node (2026-10-18/19). Each item lists the evidence. Patches are minimal and match
each repo's existing style. **A human should read each patch and re-run the evidence commands
before opening a PR** — the bounty asks for no AI slop, and the maintainers deserve the same.

Status: drafted, not yet submitted.

## 1. farcasterxyz/snapchain — HTTP API docs for signers

Patch: [`snapchain-http-signers-docs.patch`](snapchain-http-signers-docs.patch) (applies to `main` at `fc87f26`).

- **`/v1/signersByFid` and `/v1/signer` are undocumented** in the HTTP reference, although
  [writing-messages](https://snapchain.farcaster.xyz/guides/writing-messages) tells readers to use
  `GET /v1/signersByFid` and calls `onChainSignersByFid` deprecated. Both routes exist in
  `src/network/http_server.rs`.
  The patch adds both, with a real gasless record from mainnet, and marks `onChainSignersByFid` deprecated.
- **`requesterFids` encoding.** The node parses query strings with `serde_qs`
  (`http_server.rs`, `serde_qs::from_str`). The doc comment on `SignersByFidHttpRequest` says to
  repeat the parameter; that is rejected:
  ```bash
  curl 'http://NODE:3381/v1/signersByFid?fid=2112&requesterFids=2112'
  # Invalid query parameters: invalid type: string "2112", expected a sequence
  curl 'http://NODE:3381/v1/signersByFid?fid=2112&requesterFids=2112&requesterFids=3'
  # Invalid query parameters: Multiple values for one key: "requesterFids"
  curl 'http://NODE:3381/v1/signersByFid?fid=2112&requesterFids%5B%5D=2112' | jq .requesterFidNonces
  # null   (percent-encoded brackets are silently ignored)
  curl 'http://NODE:3381/v1/signersByFid?fid=2112&requesterFids[]=2112' | jq .requesterFidNonces
  # {"2112": 0}
  ```
  The patch documents the `[]` form. (A follow-up code PR could fix the comment, or accept the
  repeated form.)
- **Signer timestamps are Unix seconds.** `addedAt`/`lastUsedAt`/`expiresAt` on signer records
  are Unix time (`expiresAt − lastUsedAt == ttl`), unlike message timestamps (Farcaster epoch).
  Easy to get wrong when the endpoint isn't documented.
- **JavaScript examples in `httpapi.md`:** the pagination loop sends `nextPageToken=` (the
  parameter is `pageToken`) and reads `response.nextPageToken` / `response.messages` on an axios
  response (should be `response.data.…`).

Not in the patch, worth an issue: `/v1/events?shard_index=0` returns `Shard not found` on 0.14.2,
so gasless `KEY_ADD`/`KEY_REMOVE` merges (routed to shard 0) can't be observed through the HTTP
event API.

## 2. farcasterxyz/docs — storage limits and embeds

Patch: [`farcaster-docs-storage-embeds.patch`](farcaster-docs-storage-embeds.patch) (applies to `main` at the 2026-04-07 head).

- **Storage** (`docs/learn/what-is-farcaster/messages.md`) says a unit costs $7 and holds 5,000
  casts / 2,500 reactions / 2,500 links / 50 profile / 50 verifications. Those are the legacy-unit
  limits (and legacy verifications are 25, not 50). Units rented since 2025-07-16 hold 100 casts,
  200 reactions, 200 links, 25 profile fields, 5 verifications (`src/storage/store/stores.rs`,
  `Limits::of_type`). The price on 2026-10-19 was 0.0000841 ETH (`StorageRegistry.unitPrice()`),
  `usdUnitPrice()` = 0.20 USD.
- **Embeds** (`docs/developers/guides/writing/casts.md`) says up to 2. Since engine V20
  (`IncreaseEmbedLimitForAllUsers`, mainnet 2026-08-13 17:00 UTC per `src/version/version.rs`)
  every account may use 4 (`src/core/validations/cast.rs`).

Not patched (bigger rewrite, better done by maintainers): `docs/developers/guides/basics/hello-world.md`
still registers the signer onchain, refers to "hubs" and `hoyt.farcaster.xyz`, and sleeps 30 s
for the key; the Snapchain copy of the same guide already uses gasless `KEY_ADD`. Suggest linking
the Snapchain guide from the top of the old page.

## How to submit

```bash
git clone https://github.com/farcasterxyz/snapchain && cd snapchain
git checkout -b docs/http-signers
git apply /path/to/homestead/docs/upstream/snapchain-http-signers-docs.patch
# re-run the curl commands above against your own node, then commit and open a PR
```
