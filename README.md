# 🎲 Bank El Haz — بنك الحظ

> *The classic board game* — buy, trade and build your way around the board. Last player standing wins!

A Monopoly-style property game for **2–6 players** (friends and/or bots). Roll the dice, snap up the 48 squares from Cairo to Dubai, charge rent, build houses and hotels, and try not to go broke.

---

## 🚀 Getting a game going
- The **host** starts a game and shares the invite link with everyone.
- Each player opens the link, types a name, and **joins**.
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

## 🛠️ Hosting & Discord setup (for whoever runs the game)

The game is a single page (`index.html`) plus a tiny self-hosted relay (`server.js`) that keeps
players in sync. There are **no third-party services** — the Discord SDK, the Cairo/Amiri fonts and
all tile images are bundled locally under `vendor/` and `assets/`.

**1. Run the relay**
```bash
npm install
npm start            # serves the game + WebSocket relay on http://localhost:3000
```

**2. Create the Discord application**
- Discord Developer Portal → **New Application**.
- **Activities → Settings** → turn on **Enable Activities**.
- **Activities → URL Mappings** → add two mappings to the same host: Prefix `/` → Target
  `<your-relay-host>` (e.g. `bank-el-haz.onrender.com`, no `https://`), and Prefix `/cdn` →
  the same target. The relay proxies Discord avatars through `/cdn`, so the game itself only
  ever makes same-origin requests.
- **OAuth2 → Redirects** → add `https://127.0.0.1` as a placeholder.
- `DISCORD_CLIENT_ID` is pre-filled with the Bank El Haz application id near the bottom of
  `index.html`; change it (or append `?client_id=…`) if you run your own application.

Players join automatically: the app reads the current Discord user from the Embedded App SDK's
`READY` event (no OAuth token exchange needed) and drops them into the lobby with their Discord
display name and avatar. The shared lobby is keyed by the SDK's **`instanceId`** — the id Discord
gives everyone who opens the same activity instance — so all players in one voice channel land in
the same game. Their Discord id is also used as their player id, so a refresh keeps their seat.
If the SDK is unavailable the normal name field is shown instead.

The SDK provides identity, participants and the instance id; the game state itself is synced by
the included relay (`server.js`), since the Embedded App SDK has no shared-state API.

**3. Serve over HTTPS**
The Discord proxy only speaks HTTPS, so host the relay somewhere that terminates TLS — Render,
Railway, Fly.io, a Cloudflare Tunnel (`cloudflared tunnel --url http://localhost:3000`), or
nginx + certbot. Point the `/` URL Mapping at that HTTPS host.

**4. Play**
Enable **Developer Mode** in Discord, join a voice channel, open the **rocket / App Launcher** and
pick the activity. Everyone in that voice channel is dropped into the same game automatically —
the room is keyed to the channel, and the bar at the bottom shows who's in the call.

**Local test without Discord:** `npm start`, then open `http://localhost:3000/?room=test` in two
tabs — they sync through the relay. With no `?room` and no Discord, the game runs single-device.