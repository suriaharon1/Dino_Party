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

## Controls

- Space or Up-arrow: jump or start
- Down-arrow: duck
- R: restart for everyone

## Current Functionality

- Browser canvas renderer with pixel sprites
- Authoritative Node multiplayer server
- WebSocket input and shared state snapshots
- Client-side prediction for local jump, duck, start, and restart input
- Server reconciliation with acknowledged input sequence numbers
- Low-latency socket mode via `setNoDelay(true)`
- Multiple players with names and colors
- Shared obstacles, score, speed, game over, and restart

## Networking Model

Dino Party uses an authoritative server: the Node server owns the game clock,
obstacles, collisions, scoring, player alive state, and shared restart state.
Browsers send input events over WebSocket instead of directly changing the
shared world.

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
    ├── index.html
    ├── styles.css
    ├── game.js
    └── server.js
```
