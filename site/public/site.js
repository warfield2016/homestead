// Progressive enhancement only: copy buttons, the mobile contents menu, and highlighting the
// current section in the sidebar. The page reads fine without any of it.

for (const block of document.querySelectorAll(".code.copyable")) {
  const button = document.createElement("button");
  button.className = "copy";
  button.type = "button";
  button.textContent = document.documentElement.lang.startsWith("zh") ? "复制" : "Copy";
  button.addEventListener("click", async () => {
    // Copy commands only: drop comment-only lines so pasted text runs as-is.
    const text = block.querySelector("code").innerText;
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = "✓";
    } catch {
      button.textContent = "⌘C";
    }
    setTimeout(() => (button.textContent = document.documentElement.lang.startsWith("zh") ? "复制" : "Copy"), 1500);
  });
  block.classList.add("has-copy");
  block.append(button);
}

const menu = document.querySelector(".menu");
const toc = document.getElementById("toc");
menu?.addEventListener("click", () => {
  const open = toc.classList.toggle("open");
  menu.setAttribute("aria-expanded", String(open));
});
toc?.addEventListener("click", (e) => {
  if (e.target.closest("a")) {
    toc.classList.remove("open");
    menu?.setAttribute("aria-expanded", "false");
  }
});

const links = new Map([...document.querySelectorAll(".toc a")].map((a) => [a.getAttribute("href").slice(1), a]));
const observer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      document.querySelector(".toc a.active")?.classList.remove("active");
      links.get(entry.target.id)?.classList.add("active");
    }
  },
  { rootMargin: "-10% 0px -80% 0px" },
);
document.querySelectorAll(".content h2[id], .content h3[id]").forEach((h) => observer.observe(h));
