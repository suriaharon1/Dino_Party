const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const PORT = Number(process.argv[2] || 5173);
const ROOT = __dirname;
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const WORLD = {
  width: 960,
  height: 300,
  groundY: 232,
  gravity: 2450,
  jumpVelocity: -760,
  baseSpeed: 360,
  maxSpeed: 760,
};

const colors = ["#202124", "#0b8043", "#1967d2", "#b06000", "#a142f4", "#c5221f"];
let nextPlayerId = 1;
const clients = new Map();
const rand = mulberry32(20260829);
let game = makeGame();

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname);
  const requestedPath = urlPath === "/" ? "/index.html" : urlPath;
  const filePath = path.normalize(path.join(ROOT, requestedPath));

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, contents) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    res.writeHead(200, { "Content-Type": contentType(filePath) });
    res.end(contents);
  });
});

server.on("upgrade", (req, socket) => {
  if (!req.headers["sec-websocket-key"]) {
    socket.destroy();
    return;
  }

  const accept = crypto
    .createHash("sha1")
    .update(req.headers["sec-websocket-key"] + GUID)
    .digest("base64");

  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );

  const client = {
    id: nextPlayerId++,
    socket,
    buffer: Buffer.alloc(0),
    joined: false,
  };
  clients.set(socket, client);

  socket.on("data", (chunk) => handleSocketData(client, chunk));
  socket.on("close", () => removeClient(client));
  socket.on("error", () => removeClient(client));
});

server.listen(PORT, () => {
  console.log(`Dino Party multiplayer running at http://localhost:${PORT}`);
});

let last = performance.now();
let accumulator = 0;
const tickSeconds = 1 / 120;

setInterval(() => {
  const now = performance.now();
  accumulator += Math.min(0.05, (now - last) / 1000);
  last = now;

  while (accumulator >= tickSeconds) {
    updateGame(tickSeconds);
    accumulator -= tickSeconds;
  }

  broadcastState();
}, 1000 / 60);

function handleSocketData(client, chunk) {
  client.buffer = Buffer.concat([client.buffer, chunk]);
  const messages = decodeFrames(client);
  for (const message of messages) {
    handleMessage(client, message);
  }
}

function handleMessage(client, text) {
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return;
  }

  if (message.type === "join") {
    client.joined = true;
    const name = String(message.name || `Dino${client.id}`).slice(0, 12);
    game.players.set(client.id, makePlayer(client.id, name));
    sendFrame(client.socket, JSON.stringify({ type: "welcome", id: client.id }));
    return;
  }

  const player = game.players.get(client.id);
  if (!player || message.type !== "input") {
    return;
  }

  if (message.action === "start") {
    game.running = true;
    queueJump(player);
  } else if (message.action === "jump") {
    queueJump(player);
  } else if (message.action === "duck") {
    player.duckHeld = Boolean(message.active);
  } else if (message.action === "restart") {
    resetGame();
  }
}

function removeClient(client) {
  if (!clients.has(client.socket)) {
    return;
  }

  clients.delete(client.socket);
  game.players.delete(client.id);
  client.socket.destroy();
}

function makeGame() {
  return {
    running: false,
    gameOver: false,
    tick: 0,
    time: 0,
    score: 0,
    speed: WORLD.baseSpeed,
    players: new Map(),
    obstacles: [],
    clouds: Array.from({ length: 5 }, (_, index) => ({
      x: index * 220 + randRange(0, 80),
      y: randRange(42, 116),
      scale: randRange(0.8, 1.6),
    })),
    groundMarks: Array.from({ length: 34 }, (_, index) => ({
      x: index * 42 + randRange(0, 16),
      w: randRange(8, 22),
    })),
    nextObstacleIn: 1.2,
  };
}

function resetGame() {
  const oldPlayers = [...game.players.values()];
  game = makeGame();
  game.running = true;
  for (const oldPlayer of oldPlayers) {
    game.players.set(oldPlayer.id, makePlayer(oldPlayer.id, oldPlayer.name));
  }
}

function makePlayer(id, name) {
  const index = (id - 1) % 6;
  return {
    id,
    name,
    x: 92 + index * 28,
    y: WORLD.groundY,
    vy: 0,
    color: colors[index],
    alive: true,
    ducking: false,
    duckHeld: false,
    jumpQueued: false,
    runFrame: 0,
    score: 0,
  };
}

function updateGame(dt) {
  game.tick += 1;

  if (!game.running || game.gameOver) {
    return;
  }

  game.time += dt;
  game.speed = Math.min(WORLD.maxSpeed, WORLD.baseSpeed + game.time * 9.5);
  game.score += dt * game.speed * 0.08;

  updateScenery(dt);
  updateObstacles(dt);
  spawnObstacles();

  for (const player of game.players.values()) {
    if (!player.alive) {
      continue;
    }

    if (player.jumpQueued && onGround(player)) {
      player.vy = WORLD.jumpVelocity;
      player.ducking = false;
    }
    player.jumpQueued = false;

    player.ducking = player.duckHeld && onGround(player);
    player.vy += WORLD.gravity * dt;
    player.y += player.vy * dt;
    if (player.y >= WORLD.groundY) {
      player.y = WORLD.groundY;
      player.vy = 0;
    }

    player.runFrame += dt * (onGround(player) ? game.speed / 48 : 0);
    player.score = Math.floor(game.score);

    if (collides(player)) {
      player.alive = false;
      player.ducking = false;
    }
  }

  if (game.players.size > 0 && [...game.players.values()].every((player) => !player.alive)) {
    game.gameOver = true;
  }
}

function queueJump(player) {
  player.jumpQueued = true;
  player.duckHeld = false;
}

function updateScenery(dt) {
  for (const cloud of game.clouds) {
    cloud.x -= game.speed * dt * 0.14 * cloud.scale;
    if (cloud.x < -80) {
      cloud.x = WORLD.width + randRange(20, 140);
      cloud.y = randRange(38, 112);
      cloud.scale = randRange(0.8, 1.6);
    }
  }

  for (const mark of game.groundMarks) {
    mark.x -= game.speed * dt;
    if (mark.x < -30) {
      mark.x = WORLD.width + randRange(0, 42);
      mark.w = randRange(8, 24);
    }
  }
}

function updateObstacles(dt) {
  game.nextObstacleIn -= dt * (game.speed / WORLD.baseSpeed);
  for (const obstacle of game.obstacles) {
    obstacle.x -= game.speed * dt;
    obstacle.flap += dt * 10;
  }
  game.obstacles = game.obstacles.filter((obstacle) => obstacle.x > -90);
}

function spawnObstacles() {
  if (game.nextObstacleIn > 0) {
    return;
  }

  const type = rand() > 0.72 && game.time > 12 ? "bird" : "cactus";
  const group = type === "cactus" ? 1 + Math.floor(rand() * 3) : 1;
  game.obstacles.push({
    type,
    x: WORLD.width + 30,
    y: type === "bird" ? WORLD.groundY - randChoice([78, 96, 112]) : WORLD.groundY,
    group,
    flap: 0,
    w: type === "bird" ? 56 : 24 + group * 16,
    h: type === "bird" ? 36 : 54,
  });

  game.nextObstacleIn = randRange(0.72, 1.28) - Math.min(0.28, game.time * 0.003);
}

function collides(player) {
  const playerBox = getPlayerBox(player);
  return game.obstacles.some((obstacle) => intersects(playerBox, getObstacleBox(obstacle)));
}

function getPlayerBox(player) {
  if (player.ducking) {
    return { x: player.x + 8, y: player.y - 30, w: 58, h: 28 };
  }
  return { x: player.x + 10, y: player.y - 52, w: 34, h: 48 };
}

function getObstacleBox(obstacle) {
  if (obstacle.type === "bird") {
    return { x: obstacle.x + 8, y: obstacle.y - 28, w: 42, h: 20 };
  }
  return { x: obstacle.x + 4, y: WORLD.groundY - 48, w: obstacle.w - 8, h: 48 };
}

function intersects(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function onGround(player) {
  return Math.abs(player.y - WORLD.groundY) < 0.5;
}

function publicStateFor(clientId) {
  return {
    type: "state",
    you: clientId,
    state: {
      running: game.running,
      gameOver: game.gameOver,
      tick: game.tick,
      score: Math.floor(game.score),
      speed: Math.round(game.speed),
      players: [...game.players.values()].map((player) => ({
        id: player.id,
        name: player.name,
        x: player.x,
        y: player.y,
        color: player.color,
        alive: player.alive,
        ducking: player.ducking,
        onGround: onGround(player),
        runFrame: player.runFrame,
        score: player.score,
      })),
      obstacles: game.obstacles,
      clouds: game.clouds,
      groundMarks: game.groundMarks,
    },
  };
}

function broadcastState() {
  for (const client of clients.values()) {
    if (client.joined) {
      sendFrame(client.socket, JSON.stringify(publicStateFor(client.id)));
    }
  }
}

function decodeFrames(client) {
  const messages = [];
  let offset = 0;

  while (client.buffer.length - offset >= 2) {
    const first = client.buffer[offset];
    const second = client.buffer[offset + 1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let headerLength = 2;

    if (length === 126) {
      if (client.buffer.length - offset < 4) break;
      length = client.buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      client.socket.destroy();
      return messages;
    }

    const maskLength = masked ? 4 : 0;
    const frameLength = headerLength + maskLength + length;
    if (client.buffer.length - offset < frameLength) {
      break;
    }

    if (opcode === 8) {
      client.socket.end();
      offset += frameLength;
      continue;
    }

    const maskStart = offset + headerLength;
    const payloadStart = maskStart + maskLength;
    const payload = Buffer.from(client.buffer.subarray(payloadStart, payloadStart + length));

    if (masked) {
      const mask = client.buffer.subarray(maskStart, maskStart + 4);
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= mask[index % 4];
      }
    }

    if (opcode === 1) {
      messages.push(payload.toString("utf8"));
    }

    offset += frameLength;
  }

  client.buffer = client.buffer.subarray(offset);
  return messages;
}

function sendFrame(socket, text) {
  const payload = Buffer.from(text);
  let header;

  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    return;
  }

  socket.write(Buffer.concat([header, payload]));
}

function contentType(filePath) {
  const extension = path.extname(filePath);
  if (extension === ".html") return "text/html; charset=utf-8";
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".js") return "text/javascript; charset=utf-8";
  if (extension === ".png") return "image/png";
  return "application/octet-stream";
}

function randRange(min, max) {
  return min + rand() * (max - min);
}

function randChoice(items) {
  return items[Math.floor(rand() * items.length)];
}

function mulberry32(seed) {
  return function next() {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
