# Your own Farcaster, in three commands

<p class="lede">Rent a server, run a Snapchain read node on it, and use a client that reads from and posts through that node. No API keys from anyone. Every protocol concept is explained at the moment you need it.</p>

<div class="quick">

## Quickstart

You need a terminal with `bash`, `curl`, `ssh` and `jq` (a stock Mac has all four), a [Hetzner Cloud](https://www.hetzner.com/cloud) or [DigitalOcean](https://www.digitalocean.com) account, and a **test** Farcaster account that already has storage.

```bash
git clone {{REPO}} && cd homestead
```

```bash
./homestead provision   # 0. rent a server
./homestead node        # 1. start a read node
./homestead client      # 2. start your client
```

0. **provision** finds the cheapest server with 4+ vCPU, 16 GB RAM and a 2 TB disk, shows the live price, and creates it only after you type `PROVISION`.
1. **node** installs Farcaster's Snapchain as a read node. It restores a snapshot, then catches up: a few hours, unattended.
2. **client** builds the client on your server and prints `https://<your-ip>.sslip.io` and a login passphrase.

Open the URL on your laptop or phone, log in, and connect your test account. The client gets its own app key (no gas, no transaction), and then you can read your feed, cast, follow, like, recast, and choose which apps' casts you see.

When you're done: `./homestead destroy`. A one-day test on Hetzner costs roughly €4–7, depending on which server types are in stock.

</div>

This page follows those commands in order. Each step says what runs, what it costs, how long it takes, and which parts of the protocol it touches. If you only want to get it running, the boxes are optional. If you want to understand Farcaster well enough to build your own client, read them.

> [!NOTE] What you'll have at the end
> - A full copy of Farcaster (about 914 million messages from 3.3 million accounts) on a machine you control, kept current by your node.
> - A client at your own HTTPS address that works on desktop and mobile. It reads only from your node and sends your writes only to your node.
> - An app key for that client that can post, delete, react and follow, nothing else, and that expires if you stop using it.

## Before you start

### What you need

| | |
|---|---|
| A laptop or desktop | macOS or Linux. Windows works inside WSL. Nothing to install on a Mac. |
| A cloud account | Hetzner Cloud (cheapest) or DigitalOcean. Or any Linux machine you already have with 4 cores, 16 GB RAM and 2 TB free disk ([bring your own](#bring-your-own-machine)). |
| A Farcaster **test** account with storage | Any account you'd be fine losing. See [Getting a test account](#getting-a-test-account). |
| Time | About 15 minutes of your attention, plus a few hours of waiting while the node syncs. |
| Money | Hetzner, at its October 2026 prices: about €130–200/month depending on stock, billed hourly, so €4–7 for a one-day test. Most of it is the 2 TB volume. The script prints the live price and waits for your yes. |

> [!WARNING] Use a test account
> In step 2 you will either type a recovery phrase into the client or sign with a wallet. A recovery phrase controls an account completely: whoever has it can take the account, its username and anything its wallet holds. Treat it like `rm -rf /`: powerful, occasionally necessary, never casual. Use a throwaway account, and read [Recovery phrases, honestly](#recovery-phrases-honestly) before you paste one anywhere — including here.

### Getting a test account

Homestead imports an *existing* account; it doesn't create one, because creating an account needs an onchain transaction and a little ETH on OP Mainnet. Two easy ways to get one:

- **Farcaster app.** Make a second account in the [Farcaster app](https://farcaster.xyz). It comes with storage. Its recovery phrase is in the app's settings.
- **Yourself, onchain.** Register an FID with the IdGateway contract on OP Mainnet; registration includes one storage unit. On 2026-10-19 that cost 0.0000841 ETH, about $0.20 (read it yourself: `IdGateway.price()`). The [official walkthrough](https://snapchain.farcaster.xyz/guides/writing-messages) has the code.

### Farcaster in one picture

> [!CONCEPT] Two systems, one account
> Farcaster splits into two parts.
>
> **Accounts live onchain, on OP Mainnet** (an Ethereum L2). A few contracts record who owns what:
> - **IdRegistry** gives each account a number, its **FID** (Farcaster ID), and records which Ethereum address owns it: the **custody address**.
> - **KeyRegistry** records **app keys** that the custody address has authorized (the older, onchain way).
> - **StorageRegistry** records how much **storage** each FID has rented.
>
> **Everything people say and do lives on Snapchain**: casts, likes, recasts, follows, profiles. These are **messages**, each one signed by an app key. Snapchain is a purpose-built network that orders those messages into blocks and keeps a copy on every node.
>
> Snapchain nodes watch the OP Mainnet contracts and fold those **onchain events** into the same blocks, so your node knows every FID, custody address, app key and storage unit without you running an Ethereum node or paying for an RPC.

---

## 0. Provision a server

```bash
./homestead provision            # Hetzner Cloud (default)
./homestead provision digitalocean
./homestead provision byo root@203.0.113.7
```

### What a node needs, and why

These are [Snapchain's published requirements](https://snapchain.farcaster.xyz/getting-started): 4 CPU cores, 16 GB of RAM, 2 TB of free disk, and ports 3381–3383 reachable.

The disk is the interesting one. On 2026-10-18 the mainnet snapshot was 5,691 chunks of about 70 MB, roughly 400 GB compressed, and the unpacked database was about 550 GB. You need more than the sum because of how the restore works. From [`snapshot.rs`](https://github.com/farcasterxyz/snapchain/blob/main/src/storage/db/snapshot.rs), for each shard the node:

1. downloads every compressed chunk to `.rocks.snapshot/`,
2. un-gzips them all into one `.tar` file, also in `.rocks.snapshot/`,
3. unpacks the tar into the database directory,

and it deletes `.rocks.snapshot/` only after the last shard. At the peak you hold the compressed chunks, the uncompressed tars and the database at once: about 1.5 TB. Then the database keeps growing.

> [!WHY] Why a separate 2 TB volume
> No Hetzner cloud plan has 2 TB of local disk, so Homestead attaches a 2 TB block volume and mounts it where Snapchain keeps its data (`/root/snapchain`). If you ever outgrow it, you can grow the volume without touching the server.

### What the command does

On Hetzner, `./homestead provision`:

1. asks for an API token (hidden input, never written to disk). Create one under *Security → API tokens* in a **new, empty project**, so the token can't touch anything else;
2. lists server types that are in stock in your location right now, keeps those with ≥4 vCPU and ≥16 GB RAM, and picks the cheapest. Snapchain publishes `arm64` and `amd64` images, so ARM servers qualify. At Hetzner's published October 2026 prices the cheapest fits are CX43 (€15.99/month) and CAX31 (€20.99), but those lines have been stock-limited since September; when they're gone, the next fit is CCX23 (€85.99). The 2 TB volume adds about €114;
3. reads live prices from the API and prints the monthly total and the cost of one day, then waits for you to type `PROVISION`;
4. creates, in order: an SSH key just for Homestead (in `.homestead/ssh/`, not your `~/.ssh`), a firewall, a 2 TB volume, and an Ubuntu 24.04 server with both attached;
5. waits until it can SSH in, then checks CPU and RAM.

Everything it created is remembered in `.homestead/state` (no secrets in it), which is how commands 1, 2 and `destroy` find the server.

The firewall opens exactly these ports:

| Port | What it's for | Who connects |
|---|---|---|
| 22/tcp | SSH | you |
| 80/tcp, 443/tcp | the client over HTTPS (80 is for the certificate challenge) | you, from any device |
| 3382/udp | Snapchain gossip (libp2p over QUIC) | other nodes. Required. |
| 3381/tcp | Snapchain HTTP API | anyone. Recommended by the Snapchain docs. |
| 3383/tcp | Snapchain gRPC API | anyone. Recommended by the Snapchain docs. |

> [!NOTE] Your node's API is public
> With 3381 and 3383 open, anyone can read from your node and submit messages to it. That's how the network is meant to work: reads are public data, and every write must carry a valid signature. If you'd rather not serve strangers, remove those two rules from the firewall; your own client talks to the node over localhost and doesn't need them.

To try it without creating anything, run `HOMESTEAD_DRY_RUN=1 ./homestead provision`: it shows the plan and prints the API calls it would make.

### Bring your own machine

Any Linux box with Docker support, 4+ cores, 16 GB RAM and 2 TB free works: a home server, a Netcup or OVH dedicated machine, an EC2 instance.

```bash
./homestead provision byo root@your.server        # uses your normal SSH setup
./homestead provision byo ubuntu@your.server ~/.ssh/key.pem
```

Open 3382/udp (required) and 80/443/tcp (for the client) on your router or cloud firewall yourself.

---

## 1. Run a Snapchain read node

```bash
./homestead node
```

It asks you two things, the same two Farcaster's installer asks: to acknowledge that you won't get rewards for running a node, and, optionally, your FID, which is used only to pick the weekday your node auto-upgrades so that not every node upgrades at once.

### What Snapchain is

> [!CONCEPT] Snapchain: blocks of messages
> Snapchain is the network that stores Farcaster messages. Think of it as a blockchain whose transactions are casts, likes and follows.
>
> - **Shards.** Accounts are split across *message shards* (two today). Your FID's shard is the first four bytes of `sha256(fid)`, mod 2, plus 1. Casts, reactions, follows and profiles go to the author's shard. **Shard 0** is the *block shard*: it orders the other shards' chunks into one sequence and holds state every shard needs, like gasless app keys.
> - **Blocks.** Each shard produces about one block per second (measured: 21 blocks in 21 seconds). Event IDs in the node's API encode the block: `id = height × 2^14 + sequence`.
> - **Validators** propose and vote on blocks with [Malachite](https://github.com/informalsystems/malachite) BFT consensus. A block is final once more than two-thirds of the validator set's weight has voted for it. Validators are a fixed, permissioned set.
> - **Read nodes** run the same binary with `read_node = true`. They never vote. They download decided blocks from peers and apply them, so they end up with exactly the same state, a moment later. Anyone can run one.
>
> Your node is a read node. That's the whole trick: a full, verifiable copy of Farcaster, no permission needed.

### What the command does

On the server, as root, `./homestead node`:

1. mounts the 2 TB volume at `/root/snapchain` (formatting it only if it has no filesystem);
2. installs Docker using Docker's official convenience script;
3. writes `/root/snapchain/.env` with your two answers, so the official installer doesn't stop to ask;
4. writes a `docker-compose.override.yml` that binds Grafana (default password `admin`) and statsd to `127.0.0.1`. The official compose file publishes them on every interface. Overrides are the [documented way](https://snapchain.farcaster.xyz/guides/managing-a-node#customizing-the-node) to change it;
5. downloads and runs Farcaster's own [`snapchain.sh upgrade`](https://snapchain.farcaster.xyz/guides/managing-a-node), which fetches the mainnet compose file and validator list, sets up Grafana, installs a weekly auto-upgrade cron job, and starts the node.

Homestead doesn't fork or patch Snapchain. When Farcaster ships a new version, your node's weekly cron job picks it up.

### Watching it sync

```bash
./homestead status --watch
```

Sync has two phases.

**1. Snapshot restore (most of the wait).** The node downloads shard 1, then 2, then 0, and unpacks each. The HTTP API isn't up yet, so `status` reads progress from the node's logs. Output looks like this (the numbers are an example):

```console
node: container running (up since 2026-10-19T09:12:04)
snapshot: downloading shard 1: chunk 1204 of 2672 Shard ETA: 0h41m
          (shards restore one after another: 1, 2, then 0; each is unpacked right after it downloads)
disk: 141G used, 1.7T free
```

**2. Catch-up.** Once restored, the node replays every block decided since the snapshot was taken, fetching them from peers. Now the API answers, and `blockDelay` (seconds between each shard's newest block and now) counts down. For example:

```console
shard 0: height 48337984  catching up: 5120s behind
shard 1: height 49013206  in sync (1s behind)
shard 2: height 48848731  in sync (0s behind)
```

When every shard is in single digits, you're synced. On a Hetzner server, expect a few hours in total, mostly download.

### Your first queries

The node's HTTP API is plain JSON over GET. On the server (`./homestead ssh`):

```bash
curl -s localhost:3381/v1/info | jq '.dbStats'
```

```json
{
  "numMessages": 914249478,
  "numFidRegistrations": 3355205,
  "approxSize": 548710481099
}
```

```bash
curl -s 'localhost:3381/v1/castsByFid?fid=1&pageSize=1&reverse=true' | jq '.messages[0]'
```

That's a raw message, the thing everything else is built from:

```json
{
  "data": {
    "type": "MESSAGE_TYPE_CAST_ADD",
    "fid": 1,
    "timestamp": 182710221,
    "network": "FARCASTER_NETWORK_MAINNET",
    "castAddBody": {
      "text": " ",
      "mentions": [14206, 19960],
      "mentionsPositions": [0, 1],
      "parentCastId": { "fid": 852612, "hash": "0x9d37ece822109756e40b8624abdb0c88e9e8a5d5" },
      "embeds": [],
      "type": "CAST"
    }
  },
  "hash": "0xa7cfccb85b71ecd53945dec4c53161a8a4aed77b",
  "hashScheme": "HASH_SCHEME_BLAKE3",
  "signature": "3muv+tUjyXsmLWMy8Js55K3Iu9dWVtXl3qqBgcn0eJefvYgzj6rA2ih9Ebp+oaH6vrslaowGNDQnV2Pi/peABQ==",
  "signatureScheme": "SIGNATURE_SCHEME_ED25519",
  "signer": "0xb85cf7feef230f30925b101223fd3e3dc4e1120bacd677f5ad3523288f8f7102"
}
```

> [!CONCEPT] Anatomy of a message
> - **`data`** is what was said: a type, the author's FID, a timestamp and a body. Encoded as protobuf, it's what gets hashed and signed.
> - **`hash`** is the first 20 bytes of BLAKE3 over the encoded `data`. It's the message's ID; replies and likes point at `(fid, hash)`.
> - **`signature`** is an Ed25519 signature over the hash, made with an **app key**.
> - **`signer`** is that app key's public key. A node accepts the message only if this key is currently authorized for this FID.
> - **`timestamp`** counts seconds from the Farcaster epoch, 2021-01-01 00:00 UTC. 182710221 is 2026-10-15. Timestamps are the author's claim: nodes reject anything more than 15 minutes in the future, but older rules let a few odd ones in, and mainnet has a cast "from" 2061.
> - **Mentions aren't in the text.** This cast reads `@user1 @user2`: the text is a single space, and the client re-inserts each `@username` at its byte offset in `mentionsPositions`. Byte offsets, in UTF-8: an emoji is four of them.

---

## 2. Create the client

```bash
./homestead client
```

```console
Your client:   https://203-0-113-7.sslip.io
Passphrase:    k7pqm-2xw9v-hc4rt-b8nzf   (shown once — save it in your password manager)
```

You can run this while the node is still syncing. The client starts, and its pages tell you what they're waiting for.

### What the command does

1. Copies `client/` and `deploy/` from this repo to `/opt/homestead` on the server.
2. Builds the client's Docker image **on the server, from that source**, and starts it with Docker Compose, next to (not inside) Farcaster's compose project, so `snapchain.sh upgrade` can never overwrite it.
3. Starts [Caddy](https://caddyserver.com) in front of it for HTTPS. You don't need a domain: `203-0-113-7.sslip.io` is a [sslip.io](https://sslip.io) name that resolves to `203.0.113.7`, and Caddy gets a Let's Encrypt certificate for it automatically. Bring your own name with `--domain`.
4. Generates a login passphrase (about 95 bits), sends it to the server over SSH's stdin so it never appears in a process list, and stores only its scrypt hash.

`--private` skips Caddy and binds the client to `127.0.0.1` on the server. Reach it with `./homestead tunnel` at `http://localhost:8080`.

> [!WHY] Why the client is a server, not just a web page
> The client holds a private key that can post as you. Keeping it on your server means your phone and laptop never store it, and every device you log in from shares one key. It also means the client can talk to your node over localhost, keep a live connection to the node's event stream, and cache what it learns. The browser part is a thin UI.

### Connect your account

Log in, and the client asks you to connect an account. This is where Farcaster's key model matters.

> [!CONCEPT] FIDs, custody addresses and app keys
> - Your **FID** is your account number. Usernames (fnames like `@alice`, or ENS names like `alice.eth`) point to FIDs; FIDs don't change.
> - Your FID is owned by a **custody address**, an Ethereum account. Your recovery phrase (BIP-39) derives that account's private key along the standard Ethereum path `m/44'/60'/0'/0/0`. The custody key can transfer the FID, change its recovery address and authorize keys. It's the master key.
> - Apps never get the custody key. Instead it authorizes an **app key** (protocol name: *signer*), an Ed25519 key pair the app generates and keeps. Every cast, like and follow is signed with an app key.
> - Each app key records which app asked for it, by that app's FID (`requestFid`). That's how anyone can tell that a cast was made "via" a given app, and it's the basis for filtering, below.

**Step 1: find your account.** You either paste a recovery phrase or connect a browser wallet. In both cases your browser works out the custody address and sends only the address to your server. The server asks *your node*:

```bash
curl -s 'localhost:3381/v1/onChainIdRegistryEventByAddress?address=0x6b0bda3f2ffed5efc83fa8c024acff1dd45793f1' | jq '{fid, to: .idRegisterEventBody.to}'
```

and then double-checks that the address is still the *current* custody address (accounts can be transferred) and that the account has storage. It shows you the FID, username and storage it found.

**Step 2: sign two messages.** The server generates a fresh Ed25519 key pair and asks the browser to sign two [EIP-712](https://eips.ethereum.org/EIPS/eip-712) payloads with the custody key. The page shows them before you sign. They look like this:

```json
[
  {
    "domain": { "name": "Farcaster KeyAdd", "version": "1", "chainId": 1 },
    "primaryType": "SignedKeyRequest",
    "message": { "requestFid": "1234567", "key": "0x7f3c…a21e", "deadline": "182796043" }
  },
  {
    "domain": { "name": "Farcaster KeyAdd", "version": "1", "chainId": 1 },
    "primaryType": "KeyAdd",
    "message": {
      "fid": "1234567", "key": "0x7f3c…a21e", "keyType": 1,
      "scopes": [1, 2, 3, 4, 5, 6], "ttl": 2592000,
      "nonce": 1, "deadline": "182796043"
    }
  }
]
```

- **SignedKeyRequest** says *app FID `requestFid` is requesting key `key`*. Homestead uses your own FID as the app; a branded client would register its own app FID and sign this with that FID's custody key instead.
- **KeyAdd** says *FID `fid` authorizes `key` to sign these message types, for this long*. `scopes` 1–6 are cast add/remove, reaction add/remove and link (follow) add/remove. `ttl` is 30 days. `nonce` is one more than the counter your node reports, so the authorization can't be replayed.

**Step 3: the server builds and submits a `KEY_ADD`.** It verifies both signatures recover to your custody address, packs them into a `KEY_ADD` message, **signs the message envelope with the new app key itself** (proof that whoever submits it holds that key), and submits it to your node. Then it waits until your node reports the key:

```bash
curl -s 'localhost:3381/v1/signersByFid?fid=1234567' | jq '.signers[] | {source, key, requestFid, scopes, addedAt, expiresAt}'
```

```json
{
  "source": "SIGNER_SOURCE_OFFCHAIN",
  "key": "0x7f3c…a21e",
  "requestFid": 1234567,
  "scopes": ["MESSAGE_TYPE_CAST_ADD", "MESSAGE_TYPE_CAST_REMOVE", "MESSAGE_TYPE_REACTION_ADD", "MESSAGE_TYPE_REACTION_REMOVE", "MESSAGE_TYPE_LINK_ADD", "MESSAGE_TYPE_LINK_REMOVE"],
  "addedAt": 1792350494,
  "expiresAt": 1794942494
}
```

One trap when reading these records: `addedAt`, `lastUsedAt` and `expiresAt` are **Unix** seconds, while message timestamps count from the Farcaster epoch. `expiresAt − lastUsedAt` is the TTL.


No transaction, no gas, about a second.

> [!CONCEPT] Gasless app keys (engine V16, live on mainnet since 2026-05-07)
> App keys used to be added by a transaction to the KeyRegistry contract on OP Mainnet. That still works, and those **onchain** keys still sign messages, but it costs gas and waits for a block. **Gasless** keys are added with a `KEY_ADD` message instead, and differ in three ways:
>
> - **Scopes.** A gasless key lists the message types it may sign. Homestead's key can't change your profile or add verified addresses, and no key can ever add or remove other keys.
> - **Sliding TTL.** The key expires after `ttl` seconds (max 90 days) of not being used. Every message it signs resets the clock. An abandoned key retires itself.
> - **Nonces.** Each FID has a counter; every `KEY_ADD` must use a higher number than the last.
>
> An FID can hold up to 1,000 gasless keys. `KEY_ADD` and `KEY_REMOVE` are routed to shard 0, because every shard needs to know which keys are valid.
>
> One trap if you write this yourself: the gasless `SignedKeyRequest` is signed on the `"Farcaster KeyAdd"` domain (`chainId` 1, no `verifyingContract`). The older onchain flow signs `"Farcaster SignedKeyRequestValidator"` on chain 10. Signatures for one are rejected by the other. Use `getGaslessSignedKeyRequestMetadata`, not `getSignedKeyRequestMetadata`.

### Recovery phrases, honestly

Balaji's [clarification](https://farcaster.xyz/balajis.eth/0x50184b62) put it well: a developer tutorial should treat a recovery phrase the way a Unix tutorial treats `rm -rf`. So, plainly:

- **Use a test account.** Not your main account, not an account whose username you care about, not one whose wallet holds anything.
- **Only paste a phrase into software whose code you've read or whose developers you trust.** That applies to Homestead too. Don't take this page's word for it.
- **Prefer delegated signing.** The client's *Sign with a browser wallet* option sends the same two signature requests to a wallet you already trust (a hardware wallet behind it is better still). The phrase never touches Homestead at all. Use it whenever your custody address lives in such a wallet.

What Homestead does with a phrase, so you can check it:

1. The phrase is typed into a page served by **your** server. Its handling lives in one file, [`client/src/web/signing.ts`]({{REPO}}/blob/main/client/src/web/signing.ts), about 110 lines.
2. The browser derives the custody account in memory, signs the two payloads above, and clears the text box. **The phrase is never sent anywhere**: open your browser's network tab and you'll see only an address going out, then two signatures.
3. Before signing, that file checks the payload is one of exactly those two types on the `"Farcaster KeyAdd"` domain, and refuses anything else. A compromised server can't trick the page into signing, say, a transfer of your account.
4. The server stores only the new app key, never the phrase or the custody key.

And if something goes wrong, the app key is the only thing exposed: it can post as you until you revoke it, but it can't take your account. The client's **Keys** page has a *revoke* button that works without your phrase (below).

### Reading: how the feed works

There's no feed API on Farcaster. A client builds one from raw messages. Homestead does it in three moves, all against your node:

1. **Who do you follow?** `GET /v1/linksByFid?fid=<you>&link_type=follow`, every page.
2. **Backfill.** For each account you follow, `GET /v1/castsByFid?fid=<them>&reverse=true&pageSize=10`, eight requests at a time. Against a node on localhost this takes seconds even for thousands of follows.
3. **Stay live.** For each shard, read the node's event stream starting at the current block: `GET /v1/events?shard_index=1&from_event_id=<height × 2^14>`. Every `MERGE_MESSAGE` event is a message your node just accepted from a block. Casts from people you follow go into the feed; deletes come out; your own follows and likes, even from other apps, update the client's state.

The **Live** tab shows step 3 raw: every cast your node merges, as it arrives. It's the network as your node sees it, unranked, and it's the best way to find people to follow from a fresh test account.

### Writing: where your cast goes

When you press *Cast*:

1. The server builds a `CAST_ADD` with your text, mentions (resolved to FIDs on your node) and embeds, signs it with the app key, and `POST`s the protobuf bytes to `/v1/submitMessage` on your node.
2. Your node checks it as a validator would: valid signature, active key with the right scope, storage available. If it passes, the node **gossips it on the `mempool` topic** to validators. A read node has no mempool of its own and stores nothing yet.
3. A validator puts it in a block. Validators agree. Your node receives that block and merges the message, which appears on the event stream.

The client shows this as a receipt in the corner, for example *accepted by your node in 40 ms → in block 49,013,227 (shard 1) after 1.6 s*: the first number is your node's validation, the second is the time until your node saw the message in a decided block.

> [!WARNING] Accepted isn't included
> A `200` from `submitMessage` means *validated and relayed*, not *in a block*. If gossip is lost, the message never lands and you have to submit it again. That's why Homestead watches for the message on the event stream instead of trusting the response. Read-node submissions that need an Ethereum L1 check (ENS names, smart-contract wallet verifications) are the most likely to be dropped under load.

Don't use `/v1/validateMessage` to predict whether a write will land: it checks encoding, hash and signature only. On 2026-10-19 it answered `"valid": true` for a cast signed by a key that wasn't authorized for that FID.

Follows (`LINK_ADD`), likes and recasts (`REACTION_ADD`), and their removals work the same way. Deleting a cast sends a `CAST_REMOVE`; the original becomes a tombstone that still counts against your storage until it's pushed out.

### Storage rent

> [!CONCEPT] Storage is the spam control
> Every FID must rent storage, in **units**, from the StorageRegistry contract. A unit rented today costs about **$0.20** (0.0000841 ETH on 2026-10-19; the price is pegged in USD) and lasts **one year**. Each unit holds a fixed number of messages per type. When a type is full, your oldest message of that type is pruned to make room. When storage expires, there's a grace period, then your messages can be dropped.
>
> Units are worth different amounts depending on when they were rented, because the protocol has been re-denominated twice. Limits from [`stores.rs`](https://github.com/farcasterxyz/snapchain/blob/main/src/storage/store/stores.rs):
>
> | Unit type | Rented | Casts | Reactions | Follows | Profile fields |
> |---|---|---|---|---|---|
> | Legacy | before Aug 2024 | 5,000 | 2,500 | 2,500 | 50 |
> | 2024 | Aug 2024 – Jul 2025 | 2,000 | 1,000 | 1,000 | 50 |
> | 2025 | since Jul 2025 | 100 | 200 | 200 | 25 |
>
> Older units were also extended: protocol upgrades stretched legacy units to four years. Your node knows exactly what any account has:

```bash
curl -s 'localhost:3381/v1/storageLimitsByFid?fid=1' | jq '{units, unitDetails, casts: (.limits[] | select(.name == "CASTS"))}'
```

```json
{
  "units": 22,
  "unitDetails": [
    { "unitType": "UnitTypeLegacy", "unitSize": 19 },
    { "unitType": "UnitType2024", "unitSize": 3 },
    { "unitType": "UnitType2025", "unitSize": 0 }
  ],
  "casts": { "name": "CASTS", "limit": 101000, "used": 3797 }
}
```

19 legacy units × 5,000 + 3 units from 2024 × 2,000 = 101,000 casts. A brand-new account's single 2025 unit holds 100 casts, so on a test account, expect old casts to be pruned quickly.

### Choosing which apps' casts you see

Every cast in Homestead says which app posted it: *via Warpcast*, *via Firefly App*, *via Neynar*, or *own key* when someone runs their own client, as you now do.

There's no "client" field in a message. Homestead works it out from the app key, as described in [the concept box above](#connect-your-account):

```
cast.signer  →  GET /v1/signer?fid=<author>&signer=<key>  →  requestFid  →  that FID's profile
```

For gasless keys the node returns `requestFid` directly. For older onchain keys it's inside the ABI-encoded `SignedKeyRequestMetadata` that was submitted with the KeyRegistry transaction, so Homestead decodes it. For example, the metadata on one of @dwr's keys decodes to `requestFid: 9152`, the Farcaster app. A key's app never changes, so each lookup is cached forever.

On the **Filter apps** page you can *hide* casts from apps you check, or *only show* casts from them. Hide automated posters, or read only what people wrote in small independent clients. Your node gives you the data; the policy is yours.

### Revoking the key

Three ways, from gentlest:

1. **Stop using it.** A gasless key expires after its TTL (30 days here) without use.
2. **The panic button.** *Keys → Revoke this client's key* sends a `KEY_REMOVE` signed by the key itself. Gasless keys can revoke themselves without the custody key, using a separate nonce counter per requesting app, so a compromised app can kill its own keys fast.
3. **From the custody address.** A `KEY_REMOVE` signed by the custody key removes a gasless key; a KeyRegistry `remove` transaction removes an onchain one (that's what "connected apps" screens in Farcaster wallets do).

The Keys page also lists every key on your account, onchain and gasless, with the app that requested it. It's worth looking at once: most people have more connected apps than they remember.

---

## Day to day

| Command | What it does |
|---|---|
| `./homestead status` | sync state of each shard |
| `./homestead logs node` · `logs client` | follow logs |
| `./homestead ssh` | shell on the server |
| `./homestead tunnel` | `localhost:8080` → client, `localhost:3000` → Grafana (login `admin`/`admin`; change it) |
| `./homestead client` | redeploy after `git pull`; keeps your passphrase and key (`--new-passphrase` rotates it) |
| `./homestead destroy` | delete server, volume, firewall and key. Billing stops. |

**Upgrades.** The node upgrades itself weekly (`snapchain.sh autoupgrade`, from cron). Protocol upgrades are scheduled by engine version and timestamp, so a node that stops upgrading eventually stops following the chain. Check `./homestead status` after long breaks.

**Backups.** The node database can always be rebuilt from a snapshot. The only state worth backing up is the client's Docker volume (`homestead_client-data`): the app key and passphrase hash. Losing it just means connecting again.

**Cost.** Hetzner bills by the hour up to a monthly cap. The biggest line is the 2 TB volume (about €114/month at October 2026 prices). Delete everything with `./homestead destroy` when you're done testing.

### Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `provision`: no server type available | That location is out of stock. Try `HOMESTEAD_LOCATION=nbg1` (or `hel1`, `ash`, `hil`). |
| `status` shows the same chunk for a long time | Download stalled. `./homestead logs node`; restarting the container resumes it. |
| Out of disk during restore | Under ~1.5 TB free. Grow the volume or start over with a bigger one (`HOMESTEAD_DISK_GB`). |
| HTTPS never comes up | Ports 80/443 blocked, or Let's Encrypt rate-limited. `./homestead logs client`. Use `--private` meanwhile. |
| *No Farcaster account for this address* | Wrong phrase or account index, or the node isn't synced yet. The Farcaster app uses index 0. |
| *Signatures don't match this account's custody address* | The wallet signed with a different address than the one looked up. Switch accounts in the wallet and retry. |
| A cast never reaches a block | Lost in gossip. Submit again; the receipt shows when it lands. |
| *Wrong passphrase* repeatedly | After 10 tries the login pauses for 10 minutes. `./homestead client --new-passphrase` sets a new one. |

---

## Reference

### Glossary

| Term | Meaning |
|---|---|
| **FID** | Farcaster ID: an account's permanent number, issued by IdRegistry on OP Mainnet. |
| **Custody address** | The Ethereum address that owns an FID. Its key is the master key. |
| **Recovery phrase** | The 12 or 24 BIP-39 words the custody key is derived from. |
| **Recovery address** | An address allowed to move an FID to a new custody address if the old one is lost. |
| **App key / signer** | An Ed25519 key authorized to sign messages for an FID. Onchain (KeyRegistry) or gasless (`KEY_ADD`). |
| **requestFid** | The FID of the app that asked for an app key. |
| **Message** | A signed unit of activity: `CAST_ADD`, `REACTION_ADD`, `LINK_ADD`, `USER_DATA_ADD`, … |
| **Storage unit** | Rented capacity per FID, per message type. One year, about $0.20. |
| **fname** | An offchain username like `@alice`, issued by Farcaster's name server. Nodes store a signed proof of it, so any client can resolve it. |
| **Snapchain** | The network that orders and stores messages in blocks. |
| **Shard** | A partition of Snapchain. Shard 0 orders the rest; message shards hold accounts' data. |
| **Validator** | A node in the permissioned set that proposes and votes on blocks. |
| **Read node** | A node that follows the chain without voting. Validates and relays writes. |
| **blockDelay** | How many seconds a shard's newest block on your node is behind now. |
| **Farcaster epoch** | 2021-01-01T00:00:00Z. Message timestamps count seconds from it. |

### Node endpoints Homestead uses

Every read is a GET you can run yourself against `localhost:3381`:

| Endpoint | Used for |
|---|---|
| `/v1/info` | sync status, shard heights |
| `/v1/onChainIdRegistryEventByAddress?address=` | custody address → FID |
| `/v1/onChainEventsByFid?fid=&event_type=EVENT_TYPE_ID_REGISTER` | is that address still the custody address? |
| `/v1/storageLimitsByFid?fid=` | storage units and limits |
| `/v1/signersByFid?fid=` | all app keys, onchain and gasless, plus the nonce for the next `KEY_ADD` |
| `/v1/signer?fid=&signer=` | one key, with its `requestFid` |
| `/v1/linksByFid?fid=&link_type=follow` | who you follow |
| `/v1/castsByFid`, `/v1/castById`, `/v1/castsByParent`, `/v1/castsByMention` | casts, threads, mentions |
| `/v1/reactionsByFid`, `/v1/reactionsByCast` | likes and recasts |
| `/v1/userDataByFid?fid=` | profiles |
| `/v1/userNameProofByName?name=` | `@name` → FID, for mentions |
| `/v1/events?shard_index=&from_event_id=` | the live stream |
| `POST /v1/submitMessage` | every write, as protobuf bytes |

### Things we found out of date

Building this meant checking every claim against the Snapchain source. These are the places the docs had drifted, with the fixes we prepared ([details and status]({{REPO}}/blob/main/docs/upstream/README.md)):

- The Snapchain HTTP API reference doesn't document `/v1/signersByFid` or `/v1/signer`, the endpoints the gasless-signer guide tells you to use.
- Its JavaScript pagination example passes `nextPageToken` (the parameter is `pageToken`) and reads `response.messages` instead of `response.data.messages`.
- `signersByFid` takes `requesterFids` as `requesterFids[]=123` (the node parses queries with `serde_qs`). The repeated form `requesterFids=1&requesterFids=2` that the source comments suggest is rejected, and percent-encoded brackets are silently ignored, which returns no nonces at all.
- `/v1/events` doesn't serve shard 0 (`Shard not found`), so gasless `KEY_ADD`s can't be watched there; poll `/v1/signer` instead.
- docs.farcaster.xyz still lists only the legacy storage limits (5,000 casts per unit) and a $7 unit price; 2025 units hold 100 casts and cost about $0.20.
- docs.farcaster.xyz says a cast can have 2 embeds; since engine V20 (2026-08-13) every account can use 4.
- docs.farcaster.xyz's hello-world still registers the app key with an onchain transaction and points at a "hub"; the Snapchain version of the guide uses gasless keys.

### Sources

- [Snapchain docs](https://snapchain.farcaster.xyz): getting started, managing a node, node types, writing messages, HTTP API
- [Snapchain source](https://github.com/farcasterxyz/snapchain), especially `src/storage/db/snapshot.rs`, `src/mempool/routing.rs`, `src/storage/store/stores.rs`, `src/network/http_server.rs`
- [`@farcaster/core`](https://github.com/farcasterxyz/hub-monorepo/tree/main/packages/core) 0.20.0: message builders, `gaslessKeys.ts`
- [Farcaster docs](https://docs.farcaster.xyz): architecture, accounts, messages
- The bounty thread: [balajis.eth/0x50184b62](https://farcaster.xyz/balajis.eth/0x50184b62)

### What has been tested

- The client against a live mainnet node (feed, live tail, threads, client attribution, node status) and its unit tests, including an offline end-to-end check that a `KEY_ADD` built from browser signatures passes `@farcaster/core` validation. See [`docs/TESTING.md`]({{REPO}}/blob/main/docs/TESTING.md).
- Command 0 against a mock of the Hetzner API (resource order, firewall rules, price arithmetic, `destroy`).
- Full fresh-machine runs of all three commands are logged in [`docs/test-runs/`]({{REPO}}/tree/main/docs/test-runs), with the date and Snapchain version of each.

Built against Snapchain 0.14.2–0.14.3 (engine V20), `@farcaster/core` 0.20.0 and Ubuntu 24.04. Last checked 2026-10-19.
