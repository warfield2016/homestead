# Homestead

Your own Farcaster read node and client, in three commands. No API keys from anyone.

```bash
git clone https://github.com/warfield2016/homestead && cd homestead
./homestead provision   # 0. rent a server (4+ vCPU, 16 GB RAM, 2 TB disk); shows the live price first
./homestead node        # 1. Snapchain read node, via Farcaster's own snapchain.sh
./homestead client      # 2. build and start the client; prints its HTTPS URL and a passphrase
```

**Tutorial:** https://warfield2016.github.io/homestead/ ([中文](https://warfield2016.github.io/homestead/zh.html)). It walks through each command and explains FIDs, custody addresses, app keys, Snapchain messages, read nodes vs validators and storage rent as they come up.

## What's here

| Path | What it is |
|---|---|
| [`homestead`](homestead) | The CLI. Bash + curl + ssh + jq; runs on a stock Mac (bash 3.2) or Linux. |
| [`scripts/providers/`](scripts/providers) | Command 0 for Hetzner Cloud and DigitalOcean. Picks the cheapest in-stock server that fits, prices it live, asks before spending. |
| [`scripts/remote/`](scripts/remote) | What runs on the server: node setup (wraps the official `snapchain.sh`), status, client setup. |
| [`client/`](client) | The client: a small Node server that holds the app key and talks only to your node, plus a vanilla-TypeScript web UI. |
| [`deploy/`](deploy) | Docker Compose for the client and Caddy (automatic HTTPS on `<ip>.sslip.io`). |
| [`site/`](site) | The tutorial microsite (Markdown → static HTML). |
| [`docs/`](docs) | Requirements, testing notes, test-run logs, upstream doc fixes, tester guide. |

## The client, briefly

- **Reads** only from your node's HTTP API: follow graph → per-account backfill → live tail of the node's event stream by block height. A *Live* tab shows every cast your node merges.
- **Writes** go to your node's `/v1/submitMessage`, which validates and relays them to validators. Each write gets a receipt that turns green when your node sees it in a block.
- **App key:** gasless `KEY_ADD` (no transaction). The recovery phrase, if you use one, stays in the browser tab; only two EIP-712 signatures reach the server. A browser-wallet option avoids the phrase entirely. The key is scoped to casts, reactions and follows, expires after 30 days unused, and can revoke itself from the Keys page.
- **Client filtering:** every cast shows which app signed it (`signer` → signer record → `requestFid`), and you can hide or exclusively show any app's casts.

## Develop

```bash
cd client && npm install
npm test                 # unit tests, incl. an offline KEY_ADD round trip validated by @farcaster/core
npm run build
HUB_URL=http://127.0.0.1:3381 node dist/server.mjs   # point at any node you run
```

Read-only UI against any node, no key: `HOMESTEAD_DEMO=true DEMO_FID=<fid> HUB_URL=… node dist/server.mjs`.

Site: `cd site && npm install && npm run build`, output in `site/dist/`.

## Security model

See the tutorial's [Recovery phrases, honestly](https://warfield2016.github.io/homestead/#recovery-phrases-honestly) section. Short version: use a test account; the phrase never leaves your browser; the server holds only a scoped, expiring, self-revocable app key; the client is behind a passphrase and HTTPS; Grafana and statsd are bound to localhost.

## License

MIT. Not affiliated with Farcaster, Merkle Manufactory or Neynar. Snapchain is Farcaster's software; Homestead installs it unmodified.
