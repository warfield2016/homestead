import { api, ApiError, type Cast, type CastPage, type Profile, type Receipt, type Status, type TypedDataRequest } from "./api.js";
import { bytes, h, mount, short, timeAgo, toast } from "./dom.js";
import { addressFromPhrase, phraseLooksValid, signWithPhrase, signWithWallet, walletAddress } from "./signing.js";

// Homestead's UI: one file of plain DOM code. Routes live in the URL hash so links work and
// the back button behaves.

const app = document.getElementById("app")!;
const profiles = new Map<number, Profile>();
let status: Status | null = null;

const KNOWN_APPS: Record<number, string> = {
  // A label for when the app's own profile hasn't loaded yet. The node is the source of truth.
  9152: "Farcaster",
};

function remember(map: Record<string, Profile> | undefined): void {
  for (const [fid, profile] of Object.entries(map ?? {})) profiles.set(Number(fid), profile);
}

function nameOf(fid: number): string {
  const p = profiles.get(fid);
  return p?.username ? `@${p.username}` : `fid:${fid}`;
}

function appName(fid: number | undefined, author?: number): string {
  if (!fid) return "unknown app";
  if (author !== undefined && fid === author) return "own key";
  if (status?.account && fid === status.account.fid) return "this account";
  const p = profiles.get(fid);
  return p?.displayName || p?.username || KNOWN_APPS[fid] || `app fid ${fid}`;
}

// --- shell -----------------------------------------------------------------------------------

const NAV = [
  { route: "following", label: "Following", icon: "◉" },
  { route: "live", label: "Live", icon: "≋" },
  { route: "mentions", label: "Mentions", icon: "@" },
  { route: "me", label: "Profile", icon: "☺" },
  { route: "keys", label: "Keys", icon: "⚿" },
  { route: "node", label: "Node", icon: "⬡" },
];

function nodePill(): HTMLElement {
  const node = status?.node;
  if (!node?.reachable) return h("span", { class: "pill bad", title: node?.error ?? "" }, "node unreachable");
  if (!node.synced) return h("span", { class: "pill warn" }, `syncing · v${node.version}`);
  return h("span", { class: "pill ok" }, `synced · v${node.version}`);
}

function shell(active: string, content: HTMLElement): HTMLElement {
  // Built twice: a DOM node can only live in one place (sidebar on desktop, tab bar on phones).
  const links = () =>
    NAV.map((n) =>
      h("a", { href: `#/${n.route}`, class: n.route === active ? "active" : "" }, h("span", { class: "icon", "aria-hidden": "true" }, n.icon), h("span", null, n.label)),
    );
  const canWrite = Boolean(status?.account && !status.account.demo && !status.demo);
  return h(
    "div",
    { class: "shell" },
    h(
      "aside",
      { class: "side" },
      h("a", { class: "brand", href: "#/following" }, h("img", { src: "/icon.svg", alt: "" }), "Homestead"),
      h("nav", { class: "side-nav" }, links()),
      canWrite && h("button", { class: "primary wide", onclick: () => compose() }, "New cast"),
      h("div", { class: "side-foot" }, nodePill(), status?.network === "testnet" && h("span", { class: "pill warn" }, "testnet")),
    ),
    h("main", { class: "main" }, content),
    h("nav", { class: "tabbar" }, links()),
    canWrite && h("button", { class: "fab", "aria-label": "New cast", onclick: () => compose() }, "+"),
  );
}

// --- cast rendering --------------------------------------------------------------------------

function avatar(fid: number, size = 40): HTMLElement {
  const p = profiles.get(fid);
  const letter = (p?.displayName || p?.username || "?").slice(0, 1).toUpperCase();
  const fallback = () => h("span", { class: "avatar fallback", style: `width:${size}px;height:${size}px` }, letter);
  if (!p?.pfp) return fallback();
  const img = h("img", { class: "avatar", src: p.pfp, alt: "", width: size, height: size, loading: "lazy", referrerPolicy: "no-referrer" });
  img.addEventListener("error", () => img.replaceWith(fallback()), { once: true });
  return img;
}

function castText(cast: Cast): HTMLElement {
  const p = h("p", { class: "text" });
  for (const seg of cast.segments) {
    if ("mention" in seg) p.append(h("a", { href: `#/u/${seg.mention}`, class: "mention" }, nameOf(seg.mention)));
    else p.append(...linkify(seg.text));
  }
  return p;
}

function linkify(text: string): Array<Node | string> {
  const out: Array<Node | string> = [];
  let last = 0;
  for (const m of text.matchAll(/https?:\/\/[^\s<>"]+[^\s<>".,;:!?)]/g)) {
    out.push(text.slice(last, m.index));
    out.push(h("a", { href: m[0], target: "_blank", rel: "noopener noreferrer nofollow" }, m[0].replace(/^https?:\/\//, "")));
    last = (m.index ?? 0) + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}

function embedsView(cast: Cast): HTMLElement | null {
  if (cast.embeds.length === 0) return null;
  return h(
    "div",
    { class: "embeds" },
    cast.embeds.map((e) => {
      if (e.castId) return h("a", { class: "embed quote", href: `#/c/${e.castId.fid}/${e.castId.hash}` }, `↪ quoted cast by ${nameOf(e.castId.fid)}`);
      if (!e.url) return null;
      const link = () => h("a", { class: "embed link", href: e.url, target: "_blank", rel: "noopener noreferrer nofollow" }, e.url!.replace(/^https?:\/\//, ""));
      if (/\.(png|jpe?g|gif|webp)(\?|$)|imagedelivery\.net/i.test(e.url)) {
        const img = h("img", { class: "embed-img", src: e.url, alt: "", loading: "lazy", referrerPolicy: "no-referrer" });
        const wrap = h("a", { href: e.url, target: "_blank", rel: "noopener noreferrer" }, img);
        img.addEventListener("error", () => wrap.replaceWith(link()), { once: true });
        return wrap;
      }
      return link();
    }),
  );
}

function castCard(cast: Cast, opts: { focus?: boolean } = {}): HTMLElement {
  const p = profiles.get(cast.fid);
  const canWrite = Boolean(status?.account && !status.account.demo && !status.demo);
  const mine = status?.account?.fid === cast.fid;
  const open = () => (location.hash = `#/c/${cast.fid}/${cast.hash}`);

  const like = h("button", { class: `act ${cast.liked ? "on" : ""}`, disabled: !canWrite, title: "Like" }, cast.liked ? "♥" : "♡");
  like.onclick = async (e) => {
    e.stopPropagation();
    await write("/api/react", { kind: "like", fid: cast.fid, hash: cast.hash, undo: cast.liked });
    cast.liked = !cast.liked;
    like.textContent = cast.liked ? "♥" : "♡";
    like.classList.toggle("on", cast.liked);
  };
  const recast = h("button", { class: `act ${cast.recasted ? "on" : ""}`, disabled: !canWrite, title: "Recast" }, "⟲");
  recast.onclick = async (e) => {
    e.stopPropagation();
    await write("/api/react", { kind: "recast", fid: cast.fid, hash: cast.hash, undo: cast.recasted });
    cast.recasted = !cast.recasted;
    recast.classList.toggle("on", cast.recasted);
  };
  const reply = h("button", { class: "act", disabled: !canWrite, title: "Reply" }, "↩");
  reply.onclick = (e) => {
    e.stopPropagation();
    compose({ fid: cast.fid, hash: cast.hash });
  };

  return h(
    "article",
    { class: `cast ${opts.focus ? "focus" : ""}`, "data-hash": cast.hash, onclick: (e: MouseEvent) => (e.target as HTMLElement).closest("a,button") || open() },
    h("a", { href: `#/u/${cast.fid}`, class: "cast-avatar" }, avatar(cast.fid)),
    h(
      "div",
      { class: "cast-body" },
      h(
        "header",
        null,
        h("a", { href: `#/u/${cast.fid}`, class: "who" }, h("strong", null, p?.displayName || nameOf(cast.fid)), " ", h("span", { class: "muted" }, nameOf(cast.fid))),
        h("span", { class: "muted" }, " · ", h("time", { datetime: new Date(cast.timestamp).toISOString(), title: new Date(cast.timestamp).toLocaleString() }, timeAgo(cast.timestamp))),
      ),
      cast.parent && h("div", { class: "muted small" }, "replying to ", h("a", { href: `#/c/${cast.parent.fid}/${cast.parent.hash}` }, nameOf(cast.parent.fid))),
      castText(cast),
      embedsView(cast),
      h(
        "footer",
        null,
        reply,
        recast,
        like,
        mine && canWrite && h("button", { class: "act", title: "Delete", onclick: (e: MouseEvent) => (e.stopPropagation(), deleteCast(cast)) }, "🗑"),
        h("a", { class: "via", href: `#/u/${cast.app ?? 0}`, title: `Signed by key ${cast.signer}` }, `via ${appName(cast.app, cast.fid)}`),
      ),
    ),
  );
}

async function deleteCast(cast: Cast): Promise<void> {
  if (!confirm("Delete this cast? Other clients will see it removed once a validator includes the delete.")) return;
  await write("/api/cast/delete", { hash: cast.hash });
}

// --- writes and receipts ---------------------------------------------------------------------

async function write(path: string, body: unknown): Promise<Receipt | null> {
  try {
    const receipt = await api.post<Receipt>(path, body);
    trackReceipt(receipt);
    return receipt;
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), "error");
    throw e;
  }
}

function trackReceipt(receipt: Receipt): void {
  const line = h("div", { class: "receipt" });
  const tray = document.getElementById("receipts") ?? document.body.appendChild(h("div", { id: "receipts" }));
  tray.prepend(line);
  const render = (r: Receipt) => {
    const accepted = r.acceptedAt ? `accepted by your node in ${r.acceptedAt - r.submittedAt} ms` : "submitting…";
    const included = r.includedAt
      ? `✓ in block ${r.block?.height.toLocaleString()} (shard ${r.block?.shard}) after ${((r.includedAt - r.submittedAt) / 1000).toFixed(1)} s`
      : "waiting for a validator…";
    mount(line, h("strong", null, r.kind), " ", h("span", { class: "muted" }, r.summary), h("br"), h("small", null, `${accepted} → ${included}`));
    line.classList.toggle("done", Boolean(r.includedAt));
  };
  render(receipt);
  const started = Date.now();
  const poll = window.setInterval(async () => {
    const { receipts } = await api.get<{ receipts: Receipt[] }>("/api/receipts").catch(() => ({ receipts: [] }));
    const r = receipts.find((x) => x.hash === receipt.hash);
    if (r) render(r);
    if (r?.includedAt || Date.now() - started > 90_000) {
      window.clearInterval(poll);
      if (!r?.includedAt) mount(line, h("strong", null, receipt.kind), " not seen in a block after 90 s. A read node relays by gossip; if it was lost, try again.");
      window.setTimeout(() => line.remove(), 8000);
    }
  }, 1000);
}

function compose(parent?: { fid: number; hash: string }): void {
  const dialog = h("dialog", { class: "compose" });
  const text = h("textarea", { placeholder: parent ? "Write your reply" : "What's happening?", maxLength: 1024, rows: 5 });
  const counter = h("span", { class: "muted small" });
  const embed = h("input", { type: "url", placeholder: "Link or image URL (optional)", inputMode: "url" });
  const send = h("button", { class: "primary" }, parent ? "Reply" : "Cast");
  const update = () => {
    const n = new TextEncoder().encode(text.value).length;
    counter.textContent = n > 320 ? `${n}/1024 bytes · long cast` : `${n}/320 bytes`;
    counter.classList.toggle("over", n > 1024);
  };
  text.addEventListener("input", update);
  update();
  send.onclick = async () => {
    send.disabled = true;
    try {
      await write("/api/cast", { text: text.value, parent, embeds: embed.value ? [embed.value] : [] });
      dialog.close();
    } catch {
      send.disabled = false;
    }
  };
  mount(
    dialog,
    h("h2", null, parent ? `Reply to ${nameOf(parent.fid)}` : "New cast"),
    text,
    embed,
    h("p", { class: "muted small" }, "Mention people with @username. Names are resolved on your node and stored as FIDs plus byte offsets."),
    h("div", { class: "row" }, counter, h("span", { class: "grow" }), h("button", { onclick: () => dialog.close() }, "Cancel"), send),
  );
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  text.focus();
}

// --- views -----------------------------------------------------------------------------------

async function feedView(tab: "following" | "live" | "mentions"): Promise<HTMLElement> {
  const list = h("div", { class: "list" });
  const more = h("button", { class: "more" }, "Load more");
  const head = h(
    "div",
    { class: "view-head" },
    h("h1", null, tab === "following" ? "Following" : tab === "live" ? "Live from your node" : "Mentions"),
    tab !== "mentions" && h("a", { href: "#/filters", class: "button small" }, "Filter apps"),
  );
  const intro =
    tab === "live"
      ? h("p", { class: "muted small intro" }, "Every cast your node merges, as it happens. This is the network as your node sees it, unranked and unfiltered (except by your app filters).")
      : null;
  let before: number | undefined;
  let cursor: string | null | undefined;

  const load = async () => {
    more.disabled = true;
    const params = new URLSearchParams({ tab });
    if (before) params.set("before", String(before));
    if (cursor) params.set("cursor", cursor);
    const page = await api.get<CastPage>(`/api/feed?${params}`);
    remember(page.profiles);
    if (page.casts.length === 0 && !before && !cursor) {
      list.append(
        h(
          "div",
          { class: "empty" },
          tab === "following"
            ? page.following
              ? "No recent casts from accounts you follow yet. New ones appear here live."
              : "You don't follow anyone yet. Try the Live tab and follow some people from there."
            : tab === "live"
              ? "Waiting for the next block… casts appear here as your node merges them."
              : "No mentions yet.",
        ),
      );
    }
    for (const cast of page.casts) list.append(castCard(cast));
    const last = page.casts.at(-1);
    before = last?.timestamp;
    cursor = page.cursor;
    more.disabled = false;
    more.hidden = tab === "mentions" ? !cursor : page.casts.length < 30;
  };
  more.onclick = () => void load();
  await load();
  if (tab === "live") {
    // New casts land continuously; refresh the top every few seconds while this view is open.
    const timer = window.setInterval(async () => {
      if (!document.body.contains(list)) return window.clearInterval(timer);
      const page = await api.get<CastPage>("/api/feed?tab=live").catch(() => null);
      if (!page) return;
      remember(page.profiles);
      const seen = new Set([...list.querySelectorAll<HTMLElement>("article")].map((a) => a.dataset.hash));
      const fresh = page.casts.filter((c) => !seen.has(c.hash)).reverse();
      for (const cast of fresh) list.prepend(castCard(cast));
      list.querySelector(".empty")?.remove();
    }, 4000);
  }
  return h("section", null, head, intro, list, more);
}

async function threadView(fid: number, hash: string): Promise<HTMLElement> {
  const data = await api.get<CastPage & { focus: string; counts: { likes: string; recasts: string; replies: string } }>(`/api/thread?fid=${fid}&hash=${hash}`);
  remember(data.profiles);
  const focusIndex = data.casts.findIndex((c) => c.hash === data.focus);
  const ancestors = data.casts.slice(0, focusIndex);
  const focus = data.casts[focusIndex]!;
  const replies = data.casts.slice(focusIndex + 1);
  return h(
    "section",
    null,
    h("div", { class: "view-head" }, h("button", { class: "small", onclick: () => history.back() }, "← Back"), h("h1", null, "Thread")),
    ancestors.map((c) => castCard(c)),
    castCard(focus, { focus: true }),
    h("div", { class: "counts muted small" }, `${data.counts.likes} likes · ${data.counts.recasts} recasts · ${data.counts.replies} replies`, " · ", h("a", { href: `#/raw/${fid}/${hash}` }, "inspect message")),
    h("h2", { class: "sub" }, "Replies"),
    replies.length ? replies.map((c) => castCard(c)) : h("p", { class: "empty" }, "No replies on your node."),
  );
}

async function profileView(fidOrMe: string): Promise<HTMLElement> {
  const fid = fidOrMe === "me" ? status?.account?.fid ?? 0 : Number(fidOrMe);
  if (!fid) return h("p", { class: "empty" }, "Connect an account first.");
  const data = await api.get<CastPage & { fid: number; isFollowing: boolean }>(`/api/profile?fid=${fid}`);
  remember(data.profiles);
  const p = profiles.get(fid);
  const canWrite = Boolean(status?.account && !status.account.demo && !status.demo);
  let following = data.isFollowing;
  const followBtn = h("button", { class: following ? "" : "primary" }, following ? "Following" : "Follow");
  followBtn.onclick = async () => {
    followBtn.disabled = true;
    try {
      await write("/api/follow", { fid, undo: following });
      following = !following;
      followBtn.textContent = following ? "Following" : "Follow";
      followBtn.className = following ? "" : "primary";
    } finally {
      followBtn.disabled = false;
    }
  };
  return h(
    "section",
    null,
    h(
      "div",
      { class: "profile" },
      avatar(fid, 72),
      h(
        "div",
        { class: "grow" },
        h("h1", null, p?.displayName || nameOf(fid)),
        h("p", { class: "muted" }, nameOf(fid), ` · FID ${fid}`),
        p?.bio && h("p", null, p.bio),
        p?.url && h("a", { href: p.url, target: "_blank", rel: "noopener noreferrer" }, p.url),
      ),
      canWrite && fid !== status?.account?.fid && followBtn,
    ),
    data.casts.map((c) => castCard(c)),
    data.casts.length === 0 && h("p", { class: "empty" }, "No casts on your node for this account."),
  );
}

async function rawView(fid: number, hash: string): Promise<HTMLElement> {
  const data = await api.get<{ message: Record<string, unknown> & { data: { timestamp: number } }; signer: Record<string, unknown> | null }>(`/api/raw?fid=${fid}&hash=${hash}`);
  const ts = data.message.data.timestamp;
  return h(
    "section",
    { class: "prose" },
    h("div", { class: "view-head" }, h("button", { class: "small", onclick: () => history.back() }, "← Back"), h("h1", null, "Inspect a message")),
    h("p", null, "This is the cast exactly as your node returned it from ", h("code", null, `/v1/castById?fid=${fid}&hash=${short(hash)}`), "."),
    h(
      "ul",
      null,
      h("li", null, h("b", null, "hash"), " — first 20 bytes of BLAKE3 over the protobuf-encoded ", h("code", null, "data"), ". It is the message's ID."),
      h("li", null, h("b", null, "signature"), " — Ed25519 signature of that hash, made with the app key in ", h("b", null, "signer"), "."),
      h("li", null, h("b", null, "timestamp"), ` — ${ts} seconds since 2021-01-01 UTC (the Farcaster epoch) = ${new Date(1609459200000 + ts * 1000).toISOString()}.`),
      h("li", null, h("b", null, "signer record"), " — below: who authorized this key and when. Its ", h("code", null, "requestFid"), " (or the onchain metadata) names the app."),
    ),
    h("pre", { class: "code" }, JSON.stringify(data.message, null, 2)),
    h("h2", { class: "sub" }, "Signer"),
    h("pre", { class: "code" }, JSON.stringify(data.signer, null, 2)),
  );
}

async function filtersView(): Promise<HTMLElement> {
  const data = await api.get<{ apps: Array<{ fid: number; count: number; profile: Profile | null }>; prefs: { appFilter: { mode: "exclude" | "include"; apps: number[] }; showReplies: boolean } }>("/api/apps");
  for (const a of data.apps) if (a.profile) profiles.set(a.fid, a.profile);
  const prefs = data.prefs;
  const selected = new Set(prefs.appFilter.apps);
  const mode = h(
    "select",
    { "aria-label": "Filter mode" },
    h("option", { value: "exclude", selected: prefs.appFilter.mode === "exclude" }, "Hide casts from the checked apps"),
    h("option", { value: "include", selected: prefs.appFilter.mode === "include" }, "Only show casts from the checked apps"),
  );
  const replies = h("input", { type: "checkbox", checked: prefs.showReplies });
  const save = async () => {
    await api.put("/api/prefs", { appFilter: { mode: mode.value, apps: [...selected] }, showReplies: replies.checked });
    toast("Saved");
  };
  mode.onchange = save;
  replies.onchange = save;
  const rows = data.apps.map((a) => {
    const box = h("input", { type: "checkbox", checked: selected.has(a.fid) });
    box.onchange = () => {
      box.checked ? selected.add(a.fid) : selected.delete(a.fid);
      void save();
    };
    return h(
      "label",
      { class: "app-row" },
      box,
      a.fid ? avatar(a.fid, 28) : h("span", { class: "avatar fallback", style: "width:28px;height:28px" }, "?"),
      h("span", { class: "grow" }, h("strong", null, appName(a.fid)), " ", h("span", { class: "muted small" }, a.fid ? `FID ${a.fid}` : "key not found on node")),
      h("span", { class: "muted small" }, `${a.count} seen`),
    );
  });
  return h(
    "section",
    { class: "prose" },
    h("div", { class: "view-head" }, h("h1", null, "Filter by app")),
    h(
      "p",
      null,
      "Every cast is signed by an app key, and every app key was requested by an app's FID. Your node knows which, so you can decide whose casts you see — for example, hide everything posted by bots' apps, or only show casts made from small independent clients.",
    ),
    h("label", { class: "row" }, mode),
    h("label", { class: "row" }, replies, " Show replies in feeds"),
    rows.length ? h("div", { class: "apps" }, rows) : h("p", { class: "empty" }, "Apps appear here as your feed loads. Open Live for a minute to see more."),
  );
}

async function keysView(): Promise<HTMLElement> {
  if (!status?.account || status.account.demo) return connectView();
  const data = await api.get<{
    signers: Array<{ key: string; source: string; app: number | null; scopes: string[]; expiresAt: number | null; lastUsedAt: number | null; thisClient: boolean }>;
    profiles: Record<string, Profile>;
    gaslessCount: number;
    gaslessLimit: number;
    nonce: number;
  }>("/api/keys");
  remember(data.profiles);
  const revoke = h("button", { class: "danger" }, "Revoke this client's key");
  revoke.onclick = async () => {
    if (!confirm("Revoke this client's app key? It will stop being able to post immediately. You can connect again later.")) return;
    revoke.disabled = true;
    try {
      await api.post("/api/keys/revoke");
      toast("Key revoked");
      await refreshStatus();
      location.hash = "#/connect";
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
      revoke.disabled = false;
    }
  };
  return h(
    "section",
    { class: "prose" },
    h("div", { class: "view-head" }, h("h1", null, "App keys for FID ", String(status.account.fid))),
    h(
      "p",
      null,
      "Every app you've ever connected holds one of these keys. Onchain keys were added by a transaction on OP Mainnet; gasless keys by a KEY_ADD message. Gasless keys carry scopes and expire if unused.",
    ),
    h("p", { class: "muted small" }, `Gasless keys: ${data.gaslessCount}/${data.gaslessLimit} · current custody nonce: ${data.nonce}`),
    h(
      "div",
      { class: "table" },
      data.signers.map((s) =>
        h(
          "div",
          { class: `key-row ${s.thisClient ? "this" : ""}` },
          h("div", null, h("strong", null, s.thisClient ? "This client" : appName(s.app ?? 0)), " ", h("span", { class: "pill" }, s.source)),
          h("code", { class: "small" }, short(s.key, 10)),
          s.scopes.length > 0 && h("div", { class: "muted small" }, "may sign: ", s.scopes.map((x) => x.replace("MESSAGE_TYPE_", "").toLowerCase()).join(", ")),
          // Signer records use Unix seconds (unlike message timestamps, which count from 2021).
          s.expiresAt && h("div", { class: "muted small" }, `expires ${new Date(s.expiresAt * 1000).toLocaleDateString()} unless used`),
        ),
      ),
    ),
    h("h2", { class: "sub" }, "Panic button"),
    h("p", null, "A gasless key can revoke itself, no recovery phrase needed. Use this if you think this server was compromised."),
    revoke,
  );
}

async function nodeView(): Promise<HTMLElement> {
  const n = await api.get<Status["node"] & { peers: number; tail: Record<string, { cursor: number; height: number; lastEventAt: number }>; hubUrl: string }>("/api/node");
  if (!n.reachable) return h("section", { class: "prose" }, h("h1", null, "Your node"), h("p", null, `Can't reach ${n.hubUrl ?? "the node"}: ${n.error}`), h("p", null, "If you just ran command 1, the node is still downloading its snapshot. Check progress with ./homestead status."));
  return h(
    "section",
    { class: "prose" },
    h("h1", null, "Your node"),
    h("p", null, `Snapchain ${n.version} · ${n.peers} peers · ${(n.messages ?? 0).toLocaleString()} messages · ${(n.fids ?? 0).toLocaleString()} accounts · ${bytes(n.sizeBytes ?? 0)} on disk`),
    h("p", { class: "muted small" }, "Peer ID ", h("code", null, n.peerId ?? "")),
    h(
      "div",
      { class: "shards" },
      (n.shards ?? []).map((s) =>
        h(
          "div",
          { class: "shard" },
          h("strong", null, s.id === 0 ? "Shard 0 (block shard)" : `Shard ${s.id}`),
          h("div", null, `height ${s.height.toLocaleString()}`),
          h("div", { class: s.delay < 30 ? "ok" : "warn" }, s.delay < 30 ? `${s.delay}s behind — in sync` : `${s.delay.toLocaleString()}s behind — catching up`),
          s.id !== 0 && h("div", { class: "muted small" }, `${s.messages.toLocaleString()} messages`),
        ),
      ),
    ),
    h(
      "p",
      { class: "muted small" },
      "Shard 0, the block shard, orders the other shards' chunks and holds cross-shard state such as gasless app keys and channels. Casts, reactions and follows live on shard 1 or 2, picked by hashing the FID",
      status?.account?.shard ? ` (FID ${status.account.fid} → shard ${status.account.shard})` : "",
      ". A read node applies blocks that validators already decided, so it is always a moment behind them.",
    ),
    h("h2", { class: "sub" }, "Event tail"),
    h(
      "ul",
      null,
      Object.entries(n.tail).map(([shard, t]) => h("li", null, `shard ${shard}: block ${t.height.toLocaleString()}, last event ${timeAgo(t.lastEventAt)} ago`)),
    ),
  );
}

// --- onboarding ------------------------------------------------------------------------------

function connectView(): HTMLElement {
  const box = h("section", { class: "prose connect" });
  const node = status?.node;
  if (!node?.reachable || !node.synced) {
    mount(
      box,
      h("h1", null, "Waiting for your node"),
      h("p", null, "Connecting an account needs a synced node: it looks up your FID, your storage and your keys there, nowhere else."),
      nodePill(),
      h("p", { class: "muted small" }, "This page checks again every 10 seconds."),
    );
    return box;
  }
  mount(
    box,
    h("h1", null, "Give this client its own key"),
    h(
      "p",
      null,
      "Your Farcaster account is owned by a custody address. Rather than handing this client that all-powerful key, you'll use it once to authorize a new app key that can only post, delete, react and follow, and that expires if unused.",
    ),
    h(
      "div",
      { class: "callout warn" },
      h("strong", null, "Use a test account. "),
      "Only type a recovery phrase into software whose code you have read or whose developers you trust. A recovery phrase controls the account completely. Homestead keeps it in this browser tab only, and sends nothing but two signatures to your server — but you shouldn't take that on faith: the code is in ",
      h("code", null, "client/src/web/signing.ts"),
      ".",
    ),
    h("div", { class: "choices" }, h("button", { class: "primary", onclick: () => phraseFlow(box) }, "Use a recovery phrase"), h("button", { onclick: () => walletFlow(box) }, "Sign with a browser wallet")),
    h("p", { class: "muted small" }, "The wallet option is the delegated way: your phrase stays in your wallet and you just approve two signature requests."),
  );
  return box;
}

function phraseFlow(box: HTMLElement): void {
  const phrase = h("textarea", { rows: 3, placeholder: "twelve or twenty-four words", autocomplete: "off", autocapitalize: "off", spellcheck: false, class: "phrase" });
  const index = h("input", { type: "number", min: 0, value: 0, class: "narrow", "aria-label": "Account index" });
  const go = h("button", { class: "primary" }, "Find my account");
  const out = h("div");
  go.onclick = async () => {
    if (!phraseLooksValid(phrase.value)) return toast("That doesn't look like a 12–24 word recovery phrase.", "error");
    go.disabled = true;
    try {
      const address = await addressFromPhrase(phrase.value, Number(index.value));
      await authorize(out, address, (requests) => signWithPhrase(phrase.value, Number(index.value), requests), () => {
        phrase.value = "";
      });
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      go.disabled = false;
    }
  };
  mount(
    box,
    h("h1", null, "Recovery phrase"),
    h("div", { class: "callout warn" }, "Test accounts only. The phrase is used in this tab to sign two messages, then cleared."),
    phrase,
    h("details", null, h("summary", null, "Advanced"), h("label", { class: "row" }, "Account index ", index), h("p", { class: "muted small" }, "Derivation path m/44'/60'/0'/0/index. Farcaster app wallets use index 0.")),
    go,
    out,
  );
  phrase.focus();
}

function walletFlow(box: HTMLElement): void {
  const out = h("div");
  const go = h("button", { class: "primary" }, "Connect wallet");
  go.onclick = async () => {
    go.disabled = true;
    try {
      const address = await walletAddress();
      await authorize(out, address, (requests) => signWithWallet(address, requests), () => undefined);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      go.disabled = false;
    }
  };
  mount(
    box,
    h("h1", null, "Browser wallet"),
    h("p", null, "Your wallet must hold the account's custody address. You'll be asked to sign two typed-data messages named SignedKeyRequest and KeyAdd on the \"Farcaster KeyAdd\" domain. No transaction, no gas."),
    go,
    out,
  );
}

async function authorize(out: HTMLElement, address: string, sign: (r: TypedDataRequest[]) => Promise<string[]>, clear: () => void): Promise<void> {
  mount(out, h("p", { class: "muted" }, `Custody address ${short(address)} — looking it up on your node…`));
  const begin = await api.post<{ id: string; account: { fid: number; username?: string; storageUnits: number; castLimit: number }; requests: TypedDataRequest[] }>("/api/onboard/begin", { address });
  const { account, requests } = begin;
  const keyAdd = requests.find((r) => r.primaryType === "KeyAdd")!;
  const confirmBtn = h("button", { class: "primary" }, "Authorize this client");
  mount(
    out,
    h(
      "div",
      { class: "callout" },
      h("p", null, h("strong", null, account.username ? `@${account.username}` : `FID ${account.fid}`), ` · FID ${account.fid} · ${account.storageUnits} storage unit(s), room for ${account.castLimit.toLocaleString()} casts`),
      h("p", { class: "small" }, "You are about to sign:"),
      h(
        "ol",
        { class: "small" },
        h("li", null, h("b", null, "SignedKeyRequest"), ` — "app FID ${account.fid} requests key ${short(String(keyAdd.message.key), 8)}". Your own FID acts as the app.`),
        h(
          "li",
          null,
          h("b", null, "KeyAdd"),
          ` — "FID ${account.fid} authorizes that key to sign casts, deletes, reactions and follows, for a sliding ${Math.round(Number(keyAdd.message.ttl) / 86400)} days, nonce ${keyAdd.message.nonce}".`,
        ),
      ),
      h("details", null, h("summary", null, "Show the exact payloads"), h("pre", { class: "code" }, JSON.stringify(requests, null, 2))),
      confirmBtn,
    ),
  );
  await new Promise<void>((resolve) => (confirmBtn.onclick = () => resolve()));
  confirmBtn.disabled = true;
  confirmBtn.textContent = "Signing…";
  const signatures = await sign(requests);
  clear();
  mount(out, h("p", { class: "muted" }, "Signed. Submitting KEY_ADD to your node and waiting for a validator to include it…"));
  const result = await api.post<{ fid: number; publicKey: string }>("/api/onboard/finish", { id: begin.id, signatures });
  await refreshStatus();
  mount(
    out,
    h("div", { class: "callout ok" }, h("p", null, h("strong", null, "Done. "), `This client now has its own key (${short(result.publicKey, 8)}) for FID ${result.fid}.`), h("a", { class: "button primary", href: "#/following" }, "Open your feed")),
  );
}

// --- login -----------------------------------------------------------------------------------

function loginView(): HTMLElement {
  const input = h("input", { type: "password", autocomplete: "current-password", placeholder: "passphrase from your terminal" });
  const form = h(
    "form",
    { class: "login" },
    h("img", { src: "/icon.svg", alt: "", width: 56, height: 56 }),
    h("h1", null, "Homestead"),
    h("p", { class: "muted" }, "Your client, your node. Enter the passphrase that ", h("code", null, "./homestead client"), " printed."),
    input,
    h("button", { class: "primary", type: "submit" }, "Log in"),
  );
  form.onsubmit = async (e) => {
    e.preventDefault();
    const { ok } = await api.post<{ ok: boolean }>("/api/login", { password: input.value });
    if (!ok) return toast("Wrong passphrase (or too many attempts — wait 10 minutes).", "error");
    await refreshStatus();
    void route();
  };
  return form;
}

// --- router ----------------------------------------------------------------------------------

async function refreshStatus(): Promise<void> {
  status = await api.get<Status>("/api/status");
  if (status.account?.profile) profiles.set(status.account.fid, status.account.profile);
}

async function route(): Promise<void> {
  if (!status) await refreshStatus();
  if (!status!.loggedIn) return mount(app, loginView());
  const [, name = "", a = "", b = ""] = location.hash.split("/");
  if (!status!.account && !["connect", "node", "live", "u", "c", "raw", "filters"].includes(name)) {
    location.hash = "#/connect";
    return;
  }
  const active = name || "following";
  mount(app, shell(active, h("p", { class: "muted loading" }, "Loading from your node…")));
  const main = app.querySelector("main")!;
  try {
    let view: HTMLElement;
    if (name === "live" || name === "mentions") view = await feedView(name);
    else if (name === "u") view = await profileView(a);
    else if (name === "me") view = await profileView("me");
    else if (name === "c") view = await threadView(Number(a), b);
    else if (name === "raw") view = await rawView(Number(a), b);
    else if (name === "keys") view = await keysView();
    else if (name === "node") view = await nodeView();
    else if (name === "filters") view = await filtersView();
    else if (name === "connect") view = status!.account && !status!.account.demo ? await keysView() : connectView();
    else view = await feedView("following");
    mount(main, view);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      status = null;
      return route();
    }
    mount(main, h("div", { class: "callout warn" }, e instanceof Error ? e.message : String(e)));
  }
}

window.addEventListener("hashchange", () => void route());
window.setInterval(async () => {
  const wasSynced = status?.node.synced;
  await refreshStatus().catch(() => undefined);
  document.querySelectorAll(".side-foot .pill:first-child").forEach((el) => el.replaceWith(nodePill()));
  if (!wasSynced && status?.node.synced && location.hash.startsWith("#/connect")) void route();
}, 10_000);
void route();
