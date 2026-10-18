// Renders content/<lang>.md into dist/<page>.html: one page per language, quickstart first,
// table of contents generated from the headings. No framework, no client-side rendering:
// the page is plain HTML that works without JavaScript (JS only adds copy buttons and the
// mobile menu).
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Marked } from "marked";

const SITE = {
  repo: process.env.HOMESTEAD_REPO ?? "https://github.com/warfield2016/homestead",
  url: process.env.HOMESTEAD_URL ?? "https://warfield2016.github.io/homestead/",
};

const PAGES = [
  { lang: "en", file: "index.html", source: "content/en.md", title: "Homestead — your own Farcaster node and client in three commands", other: { href: "zh.html", label: "中文" } },
  { lang: "zh-CN", file: "zh.html", source: "content/zh.md", title: "Homestead — 三条命令，拥有你自己的 Farcaster 节点与客户端", other: { href: "index.html", label: "English" } },
];

// Content hashes on asset URLs, so a redeploy is never hidden behind a cached stylesheet.
const version = (file) => createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 10);
const ASSET = { css: `site.css?v=${version("public/site.css")}`, js: `site.js?v=${version("public/site.js")}` };

const escape = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function slugify(text, used) {
  let slug = text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z]+;/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "");
  const base = slug || "section";
  let n = 2;
  while (used.has(slug)) slug = `${base}-${n++}`;
  used.add(slug);
  return slug;
}

const CALLOUTS = {
  NOTE: { cls: "note", label: { en: "Note", "zh-CN": "注意" } },
  TIP: { cls: "tip", label: { en: "Tip", "zh-CN": "提示" } },
  WARNING: { cls: "warning", label: { en: "Careful", "zh-CN": "小心" } },
  CONCEPT: { cls: "concept", label: { en: "Concept", "zh-CN": "概念" } },
  WHY: { cls: "why", label: { en: "Why", "zh-CN": "为什么" } },
};

function render(page) {
  const used = new Set();
  const toc = [];
  const marked = new Marked({ gfm: true });

  marked.use({
    renderer: {
      heading({ tokens, depth }) {
        const html = this.parser.parseInline(tokens);
        if (depth === 1) return `<h1>${html}</h1>\n`;
        const id = slugify(html, used);
        if (depth <= 3) toc.push({ depth, id, html: html.replace(/<[^>]+>/g, "") });
        return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true">#</a>${html}</h${depth}>\n`;
      },
      code({ text, lang }) {
        const language = (lang || "").split(/\s/)[0];
        const copyable = ["bash", "sh", "shell", "console"].includes(language);
        const label = language ? `<span class="lang">${escape(language)}</span>` : "";
        return `<div class="code${copyable ? " copyable" : ""}">${label}<pre><code>${escape(text)}</code></pre></div>\n`;
      },
      blockquote({ tokens }) {
        const first = tokens[0];
        const match = first?.type === "paragraph" && /^\[!([A-Z]+)\]\s*(.*)/.exec(first.text);
        if (match && CALLOUTS[match[1]]) {
          const kind = CALLOUTS[match[1]];
          const title = match[2] ? this.parser.parseInline(marked.Lexer.lexInline(match[2])) : kind.label[page.lang] ?? kind.label.en;
          const rest = first.text.split("\n").slice(1).join("\n");
          const body = (rest ? marked.parse(rest) : "") + this.parser.parse(tokens.slice(1));
          return `<aside class="callout ${kind.cls}"><p class="callout-title">${title}</p>${body}</aside>\n`;
        }
        return `<blockquote>${this.parser.parse(tokens)}</blockquote>\n`;
      },
      table(token) {
        // Wide tables scroll inside their own box instead of widening the page on phones.
        const header = token.header.map((cell) => `<th>${this.parser.parseInline(cell.tokens)}</th>`).join("");
        const rows = token.rows.map((row) => `<tr>${row.map((cell) => `<td>${this.parser.parseInline(cell.tokens)}</td>`).join("")}</tr>`).join("\n");
        return `<div class="table-wrap"><table><thead><tr>${header}</tr></thead><tbody>${rows}</tbody></table></div>\n`;
      },
      link({ href, title, tokens }) {
        const text = this.parser.parseInline(tokens);
        const external = /^https?:/.test(href);
        return `<a href="${escape(href)}"${title ? ` title="${escape(title)}"` : ""}${external ? ' rel="noopener"' : ""}>${text}</a>`;
      },
    },
  });

  const markdown = readFileSync(page.source, "utf8").replaceAll("{{REPO}}", SITE.repo).replaceAll("{{URL}}", SITE.url);
  const body = marked.parse(markdown);
  const tocHtml = toc
    .filter((t) => t.depth >= 2)
    .map((t) => `<li class="d${t.depth}"><a href="#${t.id}">${t.html}</a></li>`)
    .join("\n");

  return `<!doctype html>
<html lang="${page.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escape(page.title)}</title>
<meta name="description" content="Provision a server, run a Snapchain read node, and use your own Farcaster client — three commands, no API keys, every protocol concept explained as you go.">
<meta property="og:title" content="${escape(page.title)}">
<meta property="og:description" content="Your own Farcaster read node and client in three commands. No API keys.">
<link rel="icon" href="icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="${ASSET.css}">
<link rel="alternate" hreflang="${page.lang === "en" ? "zh-CN" : "en"}" href="${page.other.href}">
</head>
<body>
<header class="top">
  <a class="brand" href="index.html"><img src="icon.svg" alt="" width="28" height="28">Homestead</a>
  <nav class="top-links">
    <a href="${SITE.repo}">GitHub</a>
    <a href="${page.other.href}" hreflang="${page.lang === "en" ? "zh-CN" : "en"}">${page.other.label}</a>
    <button class="menu" aria-expanded="false" aria-controls="toc">${page.lang === "en" ? "Contents" : "目录"}</button>
  </nav>
</header>
<div class="layout">
  <nav id="toc" class="toc" aria-label="${page.lang === "en" ? "Contents" : "目录"}"><ol>${tocHtml}</ol></nav>
  <main class="content">
${body}
  </main>
</div>
<footer class="foot"><p>MIT licensed · <a href="${SITE.repo}">source</a> · not affiliated with Farcaster or Neynar</p></footer>
<script src="${ASSET.js}" defer></script>
</body>
</html>
`;
}

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });
cpSync("public", "dist", { recursive: true });
for (const page of PAGES) {
  try {
    writeFileSync(`dist/${page.file}`, render(page));
    console.log(`dist/${page.file}`);
  } catch (e) {
    if (e.code === "ENOENT") console.warn(`skipped ${page.source} (missing)`);
    else throw e;
  }
}
