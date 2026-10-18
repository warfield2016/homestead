# Submitting to the bounty

Reply to https://farcaster.xyz/balajis.eth/0x50184b62 within seven days of the post with three URLs.
Draft (edit the bracketed parts, keep it short and in your own voice):

---

Homestead: your own Farcaster read node and client in three commands.

`./homestead provision` → `./homestead node` → `./homestead client`. Gasless app key, the
recovery phrase never leaves the browser (or sign with a wallet instead), per-app include/exclude
filtering, write receipts that show when a validator includes your cast. Tutorial explains each
protocol concept as it comes up, in English and 中文. Found and patched [N] outdated spots in the
Snapchain and Farcaster docs along the way.

1. Tutorial: https://warfield2016.github.io/homestead/
2. Code (MIT): https://github.com/warfield2016/homestead
3. Vouch: [link to the tester's cast]

---

Checklist before posting:

- [ ] At least one other person completed the tutorial and cast publicly about it.
- [ ] Repo is public, MIT `LICENSE` present, site deployed and links work on a phone.
- [ ] Test run logged in `docs/test-runs/`.
- [ ] Upstream PRs opened (optional), links added to `docs/upstream/README.md`.
