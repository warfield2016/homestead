# Testing Homestead: a guide for volunteers

Thank you for trying this. The bounty only counts if real people get through the tutorial, so an
honest report — including "it broke at step X" — is the most useful thing you can give.

## What you'll do

1. Follow the quickstart at the top of the tutorial: https://warfield2016.github.io/homestead/
2. Get to the point where you've posted a cast from **your own** node and client.
3. Tell us how it went (issue template below), and if you think it deserves it, vouch publicly.

## What it costs you

| | |
|---|---|
| Time at the keyboard | ~15 minutes, in three sittings |
| Waiting | a few hours while the node syncs (you can walk away) |
| Money | a Hetzner Cloud server for a day: roughly €4–7. Run `./homestead destroy` when done. |
| Accounts | a Hetzner (or DigitalOcean) account, and a **throwaway** Farcaster account with storage |

Please don't use your main Farcaster account. Use a fresh one from the Farcaster app.

## Checklist

- [ ] `./homestead provision` printed a price and created a server
- [ ] `./homestead node` finished and `./homestead status` showed the snapshot downloading
- [ ] a few hours later, `status` said **node is in sync**
- [ ] `./homestead client` printed an `https://…sslip.io` URL and a passphrase
- [ ] the URL opened on your phone and on your laptop
- [ ] you connected your test account (phrase or wallet) and the key showed up on the Keys page
- [ ] you cast, liked, recasted and followed someone, and saw each receipt turn green
- [ ] you saw your cast from a *different* Farcaster client
- [ ] you hid an app on the Filter apps page and its casts disappeared from your feed
- [ ] you revoked the key (Keys → Revoke) and ran `./homestead destroy`

## Reporting

Open an issue at https://github.com/warfield2016/homestead/issues with:

- your OS, provider and region, and the server type command 0 picked
- how long the sync took
- anything confusing, wrong or slow, with the exact command and output
- what the tutorial explained well, and what it didn't

## Vouching

If it worked and you think the tutorial is good, a public cast helps. Write it in your own words:
what you ran, how long it took, and whether you'd point another developer at it. Please include
the link to the tutorial, and mention @balajis.eth so it's counted.
