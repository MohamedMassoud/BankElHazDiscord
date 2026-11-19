# 🎲 Bank El Haz — بنك الحظ

> *The classic board game* — buy, trade and build your way around the board. Last player standing wins!

A Monopoly-style property game for **2–6 players** (friends and/or bots). Roll the dice, snap up the 48 squares from Cairo to Dubai, charge rent, build houses and hotels, and try not to go broke.

---

## 🚀 Getting a game going
- Open the activity in a Discord voice channel — everyone in that channel joins automatically with their Discord name and avatar.
- Add **🤖 bots** to fill empty seats if you like.
- When everyone's in, the host taps **▶️ Start the game**.
- You can also play **pass-and-play** on one device — just add players and start.

---

## 🎲 Setting the order
At the start, everyone rolls to decide who goes first — **take turns tapping 🎲 Roll** (highest roll plays first; ties re-roll).

---

## 🕹️ How to play
- Everyone starts with **1500**; passing **Start (البداية)** earns **+200**.
- On your turn: **🎲 Roll the dice** and move around the board.
- Land on an empty property → **🏠 Buy** it, or send it to **🔨 Auction**.
- Land on someone else's property → pay **rent**. Rent climbs every time a non-owner visits, and a full colour set **doubles it**.
- Own a full set? **Build 🏠 houses and 🏨 hotels** to earn more.
- Short on cash? Your balance goes **negative** and you get **60 seconds** to **mortgage 🔒** places or **sell houses 🏚️** until it hits **0**. Run out of time and your properties are mortgaged automatically — if that still isn't enough, you go **bankrupt 💀**.
- **Jail 🚔**: roll doubles or pay the fine to get out.
- Watch out for **taxes 💸** and **luck cards ❓**.
- **Trade 🤝** properties and cash with other players — an unbalanced deal is taxed, paid by whoever gains more.
- Each turn is timed; run out and you're fined and skipped.
- **Last solvent player wins 🏆.**

---

## ✋ Things you can do
- **Roll the dice** / **Buy** / **Auction** / **End turn** / **Roll again** on doubles.
- **Tap any square** to see its details (price, rent, owner, houses, mortgage).
- **Trade 🤝**, **build / sell**, and **mortgage 🏦** your properties.
- Grab properties, complete colour sets, and charge big rent.

---

## 💡 Good to know
- **2–6 players** — add 🤖 bots any time before the start.
- Play in **English or العربية** — toggle at the top.
- Separate **music 🎵** and **sound 🔔** toggles at the top (mute each independently).
- If the host leaves, someone else takes over — the game keeps going.

---

## 🏆 Tips
- Grab full colour sets early — they double rent and unlock building.
- Keep some cash for rent; hitting zero is no fun.
- Use trades to complete sets (and to complete other players' sets — for a price).
- Watch your net worth: cash + land + buildings − debt.

Enjoy the game! 🎲🏆

---

﻿## 🛠️ Hosting & Discord setup

The game is a static page in `public/` plus a Cloudflare Worker + Durable Object relay (`worker.js`).
There are **no third-party services** — the Discord SDK, the Cairo/Amiri fonts and all tile images are
bundled locally under `public/vendor/` and `public/assets/`.

**1. Deploy to Cloudflare**
```bash
npm install
npx wrangler login
npx wrangler deploy
```
This serves the game and the relay from your Worker (e.g. `bankelhazdiscord.linkman44.workers.dev`).
Each room is a **Durable Object** (`RoomDO` in `worker.js`) that owns the game state, presence and
WebSocket connections. The first deploy creates the `RoomDO` Durable Object (confirm the migration
prompt if Wrangler asks). The Worker name in `wrangler.toml` is `bankelhazdiscord`; if you change it,
update the URL Mapping too.

**2. Create the Discord application**
- Discord Developer Portal → **New Application**.
- **Activities → Settings** → turn on **Enable Activities**.
- **Activities → URL Mappings** → add two mappings to the same host: Prefix `/` → Target
  `bankelhazdiscord.linkman44.workers.dev` (no `https://`, no path), and Prefix `/cdn` → the same
  target. The Worker proxies Discord avatars through `/cdn`, so the game only makes same-origin requests.
- **OAuth2 → Redirects** → add `https://127.0.0.1` as a placeholder.
- `DISCORD_CLIENT_ID` is pre-filled with the Bank El Haz application id near the bottom of
  `public/index.html`; change it (or append `?client_id=…`) if you run your own application.

Players join automatically: the app reads the current Discord user from the Embedded App SDK's
`READY` event (no OAuth token exchange needed) and drops them into the lobby with their Discord
display name and avatar. The shared lobby is keyed to the **voice channel** (derived from the SDK's
`instanceId` / `channel_id`) — everyone in one voice channel lands in the same game. Their Discord
id is also used as their player id, so a refresh keeps their seat. If the SDK is unavailable the
normal name field is shown instead.

The SDK provides identity, participants and the instance id; the game state is synced by the Worker's
Durable Object (`worker.js`) — the Embedded App SDK has no shared-state API.

**Privacy & Terms (required for publishing)**
- The pages are `public/privacy.html` and `public/terms.html`, served at `/privacy.html` and `/terms.html`.
- In the Developer Portal → **App Directory**, set:
  - **Privacy Policy URL** → `https://<your-worker-host>/privacy.html`
  - **Terms of Service URL** → `https://<your-worker-host>/terms.html`
- The contact is `linkman44@gmail.com`; change it in both files if it changes.
- The lobby shows links to both pages (they open through the Discord SDK's external-link command).

**3. Play**
Enable **Developer Mode** in Discord, join a voice channel, open the **rocket / App Launcher** and
pick the activity. Everyone in that voice channel is dropped into the same game automatically —
the room is keyed to the channel, and the bar at the bottom shows who's in the call.

The small dot in the top bar is the relay connection: **green = live**, **red = offline**,
**amber = connecting**.

**Local test without Discord:** `npx wrangler dev`, then open `http://localhost:8787/?room=test` in two
tabs — they sync through the local Durable Object. With no `?room` and no Discord, the game runs single-device.
