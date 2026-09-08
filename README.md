# Dino Party

A Chrome-dino-inspired multiplayer endless-runner in the browser.

## Run

```bash
cd /Users/aharonsuri/Dino_Party
node web/server.js 5173
```

Open:

```text
http://localhost:5173
```

Open the same URL in multiple tabs or on another computer on the same network to play
together. Add a name with a query string:

```text
http://localhost:5173/?name=Alice
```

## Cloudflare Deploy

The production backend is a Cloudflare Worker with one Durable Object per room.
Static files are served by Workers Static Assets, and `/ws?room=CODE` routes each
party to its own authoritative room object.

```bash
cd /Users/aharonsuri/Dino_Party/web
npm install
npm run cf:dev
```

Deploy with:

```bash
npm run deploy
```

## Controls

- Space or Up-arrow: jump, or start if you are the host
- Down-arrow: duck
- R: host reset after game over

## Current Functionality

- Browser canvas renderer with pixel sprites
- Authoritative multiplayer rooms
- Cloudflare Durable Object backend for production
- Local Node multiplayer server for development
- WebSocket input and shared state snapshots
- Client-side prediction for local jump, duck, start, and restart input
- Server reconciliation with acknowledged input sequence numbers
- Low-latency socket mode via `setNoDelay(true)`
- Shareable room links with a host-controlled waiting room
- Opening screen for setting a name, creating a room, or joining by room code
- In-game name changes that sync to everyone in the room
- Party size capped at 5 players per room
- Multiple players with names and colors
- Shared obstacles, score, speed, game over, and host reset

## Room Flow

Open the game to choose a display name and either create a room or enter an
existing room code. The first player in a room becomes the host, and the browser
updates the URL with a room code that can be shared:

```text
http://localhost:5173/?room=ABCDE
```

Players who open the shared link see the room code prefilled and join the same
waiting room. The host starts the race with Space or Up-arrow. After game over,
only the host can press R to reset everyone back to the waiting room. Each room
allows up to 5 players. Players can rename themselves from the controls without
leaving the room.

## Networking Model

Dino Party uses an authoritative room server: the backend owns the game clock,
obstacles, collisions, scoring, player alive state, host status, and shared
restart state. Browsers send input events over WebSocket instead of directly
changing the shared world.

In production, each room code maps to a Cloudflare Durable Object. That gives
every party a single stateful coordinator while allowing different rooms to run
independently at the edge.

To make localhost and network play feel faster, the browser predicts only the
local player's immediate movement. Each input gets a sequence number, the client
applies that input locally right away, and the server includes the last processed
input sequence in future snapshots. When a snapshot arrives, the client restores
the authoritative player state, discards acknowledged inputs, and reapplies any
pending inputs. That keeps the server in charge while hiding most round-trip
delay for the player pressing the key.

Remote players, obstacles, score, collisions, and game over remain purely
server-driven.

## Project Layout

```text
dino-party/
├── README.md
├── .gitignore
└── web/
    ├── package.json
    ├── wrangler.jsonc
    ├── server.js
    ├── public/
    │   ├── index.html
    │   ├── styles.css
    │   └── game.js
    └── worker/
        └── index.mjs
```
