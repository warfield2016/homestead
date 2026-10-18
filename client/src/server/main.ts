import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { AppResolver } from "./apps.js";
import { hasPassword, isLoggedIn, login, logout, setPassword } from "./auth.js";
import { config } from "./config.js";
import { Feed, shardForFid, toCastView, type CastView, type FeedPrefs } from "./feed.js";
import { Hub, HubError, type HexString, type JsonMessage } from "./hub.js";
import { KeyManager, UserError } from "./keys.js";
import { Profiles } from "./profiles.js";
import { readJson, writeJson } from "./store.js";
import { Writer } from "./writer.js";

// `node dist/server.mjs set-password` reads a passphrase from stdin and stores its hash.
if (process.argv[2] === "set-password") {
  let input = "";
  process.stdin.on("data", (chunk) => (input += chunk));
  process.stdin.on("end", () => {
    setPassword(input.trim());
    console.log("passphrase stored");
  });
} else {
  void start();
}

async function start(): Promise<void> {
  const hub = new Hub(config.hubUrl);
  const apps = new AppResolver(hub);
  const profiles = new Profiles(hub);
  const keys = new KeyManager(hub);
  const feed = new Feed(hub, apps, config.backfillPerAccount);
  const writer = new Writer(hub, keys, (name) => profiles.fidByName(name));
  feed.onMerged((message, shard, height) => writer.markIncluded(message.hash, shard, height));

  let prefs = readJson<FeedPrefs>("prefs.json", { appFilter: { mode: "exclude", apps: [] }, showReplies: false });

  // Start the event tail and load the account once the node answers. While a fresh node is
  // still restoring its snapshot the HTTP API isn't up yet, so keep retrying quietly.
  void (async () => {
    for (;;) {
      try {
        await feed.startTail();
        const fid = keys.current?.fid ?? Number(process.env.DEMO_FID ?? 0);
        if (fid) await feed.loadAccount(fid);
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 10_000));
      }
    }
  })();

  async function hydrate(casts: CastView[]) {
    const fids = new Set<number>();
    for (const cast of casts) {
      if (cast.app === undefined) cast.app = await apps.appFor(cast.fid, cast.signer);
      fids.add(cast.fid);
      if (cast.app) fids.add(cast.app);
      if (cast.parent) fids.add(cast.parent.fid);
      cast.mentions.forEach((f) => fids.add(f));
    }
    return {
      casts: casts.map((c) => ({ ...c, liked: feed.likes.has(c.hash), recasted: feed.recasts.has(c.hash) })),
      profiles: await profiles.many(fids),
    };
  }

  const messagesToCasts = (messages: JsonMessage[]) => messages.map(toCastView).filter((c): c is CastView => c !== null);

  async function nodeStatus() {
    try {
      const info = await hub.info();
      const shards = info.shardInfos
        .map((s) => ({ id: s.shardId, height: s.maxHeight, delay: s.blockDelay, messages: s.numMessages }))
        .sort((a, b) => a.id - b.id);
      return {
        reachable: true,
        numShards: info.numShards,
        version: info.version,
        peerId: info.peer_id,
        messages: info.dbStats.numMessages,
        fids: info.dbStats.numFidRegistrations,
        sizeBytes: info.dbStats.approxSize,
        shards,
        // The docs' definition of "in sync": every shard's newest block is seconds old.
        synced: shards.length > 0 && shards.every((s) => s.delay < 30),
      };
    } catch (e) {
      return { reachable: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  type Handler = (req: IncomingMessage, url: URL, body: Record<string, unknown>, res: ServerResponse) => Promise<unknown>;
  const routes: Record<string, Handler> = {};
  const publicRoutes = new Set(["GET /api/status", "POST /api/login"]);
  const writeRoutes = new Set<string>();
  const route = (key: string, handler: Handler, opts: { write?: boolean } = {}) => {
    routes[key] = handler;
    if (opts.write) writeRoutes.add(key);
  };

  route("GET /api/status", async (req) => {
    const node = await nodeStatus();
    const loggedIn = isLoggedIn(req);
    const shardOf = (fid: number) => (node.reachable && node.numShards ? shardForFid(fid, node.numShards) : undefined);
    let account = null;
    if (loggedIn && keys.current) {
      const { fid, publicKey, addedAt, scopes, ttl } = keys.current;
      account = { fid, shard: shardOf(fid), publicKey, addedAt, scopes, ttl, profile: await profiles.get(fid) };
    } else if (config.demo && feed.me) {
      account = { fid: feed.me, shard: shardOf(feed.me), demo: true, profile: await profiles.get(feed.me) };
    }
    return { demo: config.demo, network: config.networkName, loggedIn, passwordSet: hasPassword(), node, account };
  });

  route("POST /api/login", async (req, _url, body, res) => ({ ok: login(req, res, String(body.password ?? "")) }));
  route("POST /api/logout", async (req, _url, _body, res) => (logout(req, res), { ok: true }));

  // --- onboarding: issue this client its own app key ------------------------------------

  route("POST /api/onboard/begin", async (_req, _url, body) => keys.begin(String(body.address ?? "")), { write: true });
  route(
    "POST /api/onboard/finish",
    async (_req, _url, body) => {
      const sigs = body.signatures as string[] | undefined;
      if (!Array.isArray(sigs) || sigs.length !== 2) throw new UserError("Expected two signatures.");
      const key = await keys.finish(String(body.id), sigs[0]!, sigs[1]!);
      void feed.loadAccount(key.fid);
      return { fid: key.fid, publicKey: key.publicKey };
    },
    { write: true },
  );

  // --- reading ---------------------------------------------------------------------------

  route("GET /api/feed", async (_req, url) => {
    const tab = url.searchParams.get("tab") ?? "following";
    const before = Number(url.searchParams.get("before") ?? Infinity) || Infinity;
    if (tab === "mentions") {
      if (!feed.me) return { casts: [], profiles: {} };
      const page = await hub.castsByMention(feed.me, { reverse: true, pageSize: 25, pageToken: url.searchParams.get("cursor") ?? undefined });
      return { ...(await hydrate(messagesToCasts(page.messages))), cursor: page.nextPageToken || null };
    }
    const casts = await feed.page(tab === "live" ? "live" : "following", prefs, before);
    return { ...(await hydrate(casts)), following: feed.following.size };
  });

  route("GET /api/profile", async (_req, url) => {
    let fid = Number(url.searchParams.get("fid") ?? 0);
    const name = url.searchParams.get("name");
    if (!fid && name) fid = (await profiles.fidByName(name)) ?? 0;
    if (!fid) throw new UserError("No such account on your node.");
    const page = await hub.castsByFid(fid, { reverse: true, pageSize: 25, pageToken: url.searchParams.get("cursor") ?? undefined });
    const hydrated = await hydrate(messagesToCasts(page.messages));
    hydrated.profiles[fid] ??= await profiles.get(fid);
    return { fid, isFollowing: feed.following.has(fid), ...hydrated, cursor: page.nextPageToken || null };
  });

  route("GET /api/thread", async (_req, url) => {
    const fid = Number(url.searchParams.get("fid"));
    const hash = String(url.searchParams.get("hash"));
    const root = await hub.castById(fid, hash);
    if (!root) throw new UserError("Your node doesn't have that cast (deleted, pruned, or not synced yet).");
    const ancestors: JsonMessage[] = [];
    let parent = root.data.castAddBody?.parentCastId;
    while (parent && ancestors.length < 8) {
      const message = await hub.castById(parent.fid, parent.hash);
      if (!message) break;
      ancestors.unshift(message);
      parent = message.data.castAddBody?.parentCastId;
    }
    const replies = await hub.castsByParent(fid, hash, { pageSize: 100 });
    const [likes, recasts] = await Promise.all(
      (["Like", "Recast"] as const).map((t) => hub.reactionsByCast(fid, hash, t, { pageSize: 100 }).catch(() => ({ messages: [], nextPageToken: null }))),
    );
    const all = await hydrate(messagesToCasts([...ancestors, root, ...replies.messages]));
    return {
      ...all,
      focus: root.hash,
      counts: {
        likes: likes!.messages.length + (likes!.nextPageToken ? "+" : ""),
        recasts: recasts!.messages.length + (recasts!.nextPageToken ? "+" : ""),
        replies: replies.messages.length + (replies.nextPageToken ? "+" : ""),
      },
    };
  });

  route("GET /api/raw", async (_req, url) => {
    const message = await hub.castById(Number(url.searchParams.get("fid")), String(url.searchParams.get("hash")));
    if (!message) throw new UserError("Not found on your node.");
    const signer = await hub.signer(message.data.fid, message.signer);
    return { message, signer: signer?.signer ?? null };
  });

  route("GET /api/apps", async () => {
    const list = [...feed.appCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);
    const appProfiles = await profiles.many(list.map(([fid]) => fid));
    return { apps: list.map(([fid, count]) => ({ fid, count, profile: appProfiles[fid] ?? null })), prefs };
  });

  route("GET /api/prefs", async () => prefs);
  route(
    "PUT /api/prefs",
    async (_req, _url, body) => {
      const filter = body.appFilter as FeedPrefs["appFilter"] | undefined;
      prefs = {
        appFilter: {
          mode: filter?.mode === "include" ? "include" : "exclude",
          apps: Array.isArray(filter?.apps) ? filter!.apps.map(Number).filter((n) => Number.isInteger(n) && n >= 0) : [],
        },
        showReplies: Boolean(body.showReplies),
      };
      writeJson("prefs.json", prefs, 0o644);
      return prefs;
    },
    { write: true },
  );

  route("GET /api/node", async () => {
    const peers = await hub.get<{ contacts?: unknown[] }>("/v1/currentPeers").catch(() => ({ contacts: [] }));
    return { ...(await nodeStatus()), peers: peers.contacts?.length ?? 0, tail: feed.tail, hubUrl: config.hubUrl };
  });

  route("GET /api/keys", async () => {
    if (!keys.current) return { signers: [] };
    const page = await hub.signersByFid(keys.current.fid);
    const { requestFidOf } = await import("./apps.js");
    const signers = page.signers.map((s) => ({
      key: s.key,
      source: s.source === "SIGNER_SOURCE_OFFCHAIN" ? "gasless" : "onchain",
      app: requestFidOf(s),
      scopes: s.scopes ?? [],
      expiresAt: s.expiresAt ?? null,
      lastUsedAt: s.lastUsedAt ?? null,
      thisClient: s.key.toLowerCase() === keys.current!.publicKey.toLowerCase(),
    }));
    const appProfiles = await profiles.many(signers.map((s) => s.app ?? 0));
    return { signers, profiles: appProfiles, gaslessCount: page.gaslessSignerCount, gaslessLimit: page.gaslessSignerLimit, nonce: page.currentUserNonce };
  });

  route("GET /api/storage", async () => (keys.current ? hub.storageLimitsByFid(keys.current.fid) : null));

  route("GET /api/receipts", async () => ({ receipts: writer.recent() }));

  // --- writing ---------------------------------------------------------------------------

  route(
    "POST /api/cast",
    async (_req, _url, body) =>
      writer.cast({
        text: String(body.text ?? ""),
        parent: body.parent as { fid: number; hash: HexString } | undefined,
        embeds: Array.isArray(body.embeds) ? (body.embeds as string[]) : [],
      }),
    { write: true },
  );
  route("POST /api/cast/delete", async (_req, _url, body) => writer.deleteCast(String(body.hash) as HexString), { write: true });
  route(
    "POST /api/react",
    async (_req, _url, body) => {
      const kind = body.kind === "recast" ? "recast" : "like";
      const receipt = await writer.react(kind, { fid: Number(body.fid), hash: String(body.hash) as HexString }, Boolean(body.undo));
      const set = kind === "like" ? feed.likes : feed.recasts;
      body.undo ? set.delete(String(body.hash).toLowerCase()) : set.add(String(body.hash).toLowerCase());
      return receipt;
    },
    { write: true },
  );
  route(
    "POST /api/follow",
    async (_req, _url, body) => {
      const fid = Number(body.fid);
      const receipt = await writer.follow(fid, Boolean(body.undo));
      if (body.undo) feed.following.delete(fid);
      else {
        feed.following.add(fid);
        void feed.backfill([fid]);
      }
      return receipt;
    },
    { write: true },
  );
  route("POST /api/keys/revoke", async () => (await keys.revokeSelf(), { ok: true }), { write: true });
  route("POST /api/keys/forget", async () => (keys.forget(), { ok: true }), { write: true });

  // --- HTTP plumbing ---------------------------------------------------------------------

  const webRoot = fileURLToPath(new URL("./web/", import.meta.url));
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".webmanifest": "application/manifest+json",
  };

  function securityHeaders(res: ServerResponse): void {
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; img-src * data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
  }

  function serveStatic(url: URL, res: ServerResponse): void {
    let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
    let file = join(webRoot, path);
    if (!file.startsWith(webRoot) || !existsSync(file) || statSync(file).isDirectory()) file = join(webRoot, "index.html");
    res.writeHead(200, {
      "Content-Type": types[extname(file)] ?? "application/octet-stream",
      // index.html always revalidates; it references main.js/style.css with a content hash
      // (see build.mjs) and chunks are content-named, so everything else can be cached forever.
      "Cache-Control": file.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable",
    });
    createReadStream(file).pipe(res);
  }

  function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 64 * 1024) {
          reject(new UserError("Request too large."));
          req.destroy();
        } else chunks.push(chunk);
      });
      req.on("end", () => {
        if (chunks.length === 0) return resolve({});
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
        } catch {
          reject(new UserError("Invalid JSON."));
        }
      });
      req.on("error", reject);
    });
  }

  const json = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(value));
  };

  const server = createServer(async (req, res) => {
    securityHeaders(res);
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/api/")) return serveStatic(url, res);

    const key = `${req.method} ${url.pathname}`;
    const handler = routes[key];
    if (!handler) return json(res, 404, { error: "not found" });
    if (!publicRoutes.has(key) && !isLoggedIn(req)) return json(res, 401, { error: "Log in first." });
    if (req.method !== "GET" && req.headers["x-homestead"] !== "1") return json(res, 403, { error: "Missing CSRF header." });
    if (config.demo && writeRoutes.has(key)) return json(res, 403, { error: "Demo mode is read-only." });

    try {
      const body = req.method === "GET" ? {} : await readBody(req);
      json(res, 200, await handler(req, url, body, res));
    } catch (e) {
      if (e instanceof UserError) return json(res, 400, { error: e.message });
      if (e instanceof HubError) return json(res, 502, { error: `Your node said: ${HubError.detail(e.body)}` });
      console.error(e);
      json(res, 500, { error: "Something went wrong. Check the client logs." });
    }
  });

  server.listen(config.port, config.host, () => {
    console.log(`homestead client on http://${config.host}:${config.port} -> node ${config.hubUrl} (${config.networkName})`);
    if (!config.demo && !hasPassword()) console.warn("no passphrase set: run `node dist/server.mjs set-password` before exposing this");
  });
}
