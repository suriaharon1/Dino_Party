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
- Multiple players with names and colors
- Shared obstacles, score, speed, game over, and restart

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
