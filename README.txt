LIVE CRASH (play coins)

Files: server.js, index.html, admin.html, package.json  (keep them in the same folder)

RUN IT
  node server.js          (needs Node 16+, no install step)
  Game:   http://localhost:3000
  Admin:  http://localhost:3000/admin

PUT IT ONLINE (so friends and Telegram can use it)
  Upload this folder to any Node host (Render, Railway, Fly.io, a VPS) and set the start command to "node server.js".
  The host gives you an https link. Share that link, or use it as your Telegram mini app URL.

HOW IT WORKS
  - The server runs the rounds all the time, even when nobody is connected.
  - Everyone sees the same round, the same multiplier, the same crash.
  - Balances, stats and recent crashes are saved in data.json on the server, so refreshing or coming back later changes nothing.
  - Each phone is remembered by a token saved in its browser (clearing browser data starts a new player).
  - Free hosts that reset their disk will also reset data.json. Use a host with persistent storage to keep balances.
  - Each round's crash point is fixed from a secret seed before betting opens. Seeds of finished rounds are public at /api/history so anyone can check them:
      crash comes from the first 13 hex characters of SHA-256(seed + ":" + nonce)

ADMIN PANEL  (/admin)
  - Set your own key with the ADMIN_KEY environment variable. If you don't, the server makes one and prints it in the server log when it starts (it is also kept in data.json).
  - It shows the real online count, every player with a permanent ID, name, balance, profit, rounds, current bet and last seen, plus a Restore button that tops a player's balance back up to 1000.
  - The player list and online count are ONLY on this page. The game itself does not show them.
  - The admin cannot see the upcoming crash point and has no way to change any round result.

TELEGRAM USERS
  To also identify players by their Telegram account, set BOT_TOKEN to your bot's token. The server then verifies each Telegram login and shows the player's @username and Telegram ID in the admin panel. Without it, players are identified by name and ID only.
