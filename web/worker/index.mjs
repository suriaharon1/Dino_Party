const MAX_PLAYERS_PER_ROOM = 5;
const ROOM_ID_LENGTH = 5;
const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const BROADCAST_HZ = 30;

const WORLD = {
  width: 960,
  height: 300,
  groundY: 232,
  gravity: 3400,
  jumpVelocity: -920,
  jumpBufferSeconds: 0.12,
  baseSpeed: 360,
  maxSpeed: 760,
};

const colors = ["#202124", "#0b8043", "#1967d2", "#b06000", "#a142f4"];
const HIT_SPRITES = makeHitSprites();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket upgrade", { status: 426 });
      }

      const roomId = normalizeRoomId(url.searchParams.get("room"));
      if (!roomId) {
        return new Response("Missing room", { status: 400 });
      }

      const id = env.ROOMS.idFromName(roomId);
      return env.ROOMS.get(id).fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
};

export class GameRoom {
  constructor(state) {
    this.state = state;
    this.roomId = "";
    this.nextPlayerId = 1;
    this.clients = new Map();
    this.rand = mulberry32(20260829);
    this.game = makeGame(this.rand);
    this.hostId = null;
    this.last = Date.now();
    this.accumulator = 0;
    this.loop = null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    this.roomId = normalizeRoomId(url.searchParams.get("room")) || this.roomId;

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    const connection = {
      id: null,
      socket: server,
      joined: false,
    };
    this.clients.set(server, connection);

    server.addEventListener("message", (event) => this.handleMessage(connection, event.data));
    server.addEventListener("close", () => this.removeClient(connection));
    server.addEventListener("error", () => this.removeClient(connection));

    this.ensureLoop();
    return new Response(null, { status: 101, webSocket: client });
  }

  handleMessage(client, data) {
    let message;
    try {
      message = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data));
    } catch {
      return;
    }

    if (message.type === "join") {
      this.joinRoom(client, message);
      return;
    }

    if (message.type === "ping") {
      client.socket.send(
        JSON.stringify({
          type: "pong",
          id: message.id,
          sentAt: message.sentAt,
          serverAt: Date.now(),
        }),
      );
      return;
    }

    const player = this.game.players.get(client.id);
    if (!player) {
      return;
    }

    if (message.type === "rename") {
      player.name = cleanName(message.name, `Dino${client.id}`);
      return;
    }

    if (message.type !== "input") {
      return;
    }

    const isHost = this.hostId === client.id;
    if (message.action === "start") {
      rememberInput(player, message.seq);
      if (isHost && !this.game.running && !this.game.gameOver) {
        this.game.running = true;
      }
    } else if (message.action === "jump") {
      rememberInput(player, message.seq);
      queueJump(player);
    } else if (message.action === "duck") {
      rememberInput(player, message.seq);
      player.duckHeld = Boolean(message.active);
    } else if (message.action === "restart") {
      rememberInput(player, message.seq);
      if (isHost) {
        this.resetGame();
      }
    }
  }

  joinRoom(client, message) {
    if (client.joined) {
      return;
    }

    if (this.game.players.size >= MAX_PLAYERS_PER_ROOM) {
      client.socket.send(
        JSON.stringify({
          type: "rejected",
          reason: "room-full",
          room: this.roomId,
          maxPlayers: MAX_PLAYERS_PER_ROOM,
        }),
      );
      client.socket.close(1008, "Room full");
      return;
    }

    client.id = this.nextPlayerId++;
    client.joined = true;

    const name = String(message.name || `Dino${client.id}`).slice(0, 12);
    this.game.players.set(client.id, makePlayer(client.id, name));
    if (!this.hostId) {
      this.hostId = client.id;
    }

    client.socket.send(
      JSON.stringify({
        type: "welcome",
        id: client.id,
        room: this.roomId,
        host: this.hostId === client.id,
        maxPlayers: MAX_PLAYERS_PER_ROOM,
      }),
    );
    this.broadcastState();
  }

  removeClient(client) {
    if (!this.clients.has(client.socket)) {
      return;
    }

    this.clients.delete(client.socket);
    if (client.id) {
      this.game.players.delete(client.id);
      if (this.hostId === client.id) {
        const nextHost = this.game.players.keys().next();
        this.hostId = nextHost.done ? null : nextHost.value;
      }
    }

    this.broadcastState();
    if (this.clients.size === 0 && this.loop) {
      clearInterval(this.loop);
      this.loop = null;
    }
  }

  resetGame() {
    const oldPlayers = [...this.game.players.values()];
    this.game = makeGame(this.rand);
    for (const oldPlayer of oldPlayers) {
      const player = makePlayer(oldPlayer.id, oldPlayer.name);
      player.lastReceivedInputSeq = oldPlayer.lastReceivedInputSeq;
      player.lastProcessedInputSeq = oldPlayer.lastReceivedInputSeq;
      this.game.players.set(oldPlayer.id, player);
    }
  }

  ensureLoop() {
    if (this.loop) {
      return;
    }

    this.last = Date.now();
    this.loop = setInterval(() => {
      const now = Date.now();
      this.accumulator += Math.min(0.05, (now - this.last) / 1000);
      this.last = now;

      const tickSeconds = 1 / 120;
      while (this.accumulator >= tickSeconds) {
        updateGame(this.game, tickSeconds);
        this.accumulator -= tickSeconds;
      }

      this.broadcastState();
    }, 1000 / BROADCAST_HZ);
  }

  broadcastState() {
    for (const client of this.clients.values()) {
      if (client.joined && client.socket.readyState === WebSocket.OPEN) {
        client.socket.send(JSON.stringify(publicStateFor(this.roomId, this.hostId, this.game, client.id)));
      }
    }
  }
}

function makeGame(rand) {
  return {
    rand,
    running: false,
    gameOver: false,
    tick: 0,
    time: 0,
    score: 0,
    speed: WORLD.baseSpeed,
    players: new Map(),
    obstacles: [],
    clouds: Array.from({ length: 5 }, (_, index) => ({
      x: index * 220 + randRange(rand, 0, 80),
      y: randRange(rand, 42, 116),
      scale: randRange(rand, 0.8, 1.6),
    })),
    groundMarks: Array.from({ length: 34 }, (_, index) => ({
      x: index * 42 + randRange(rand, 0, 16),
      w: randRange(rand, 8, 22),
    })),
    nextObstacleIn: 1.2,
  };
}

function makePlayer(id, name) {
  const index = (id - 1) % colors.length;
  return {
    id,
    name: cleanName(name, `Dino${id}`),
    x: 92 + index * 28,
    y: WORLD.groundY,
    vy: 0,
    color: colors[index],
    alive: true,
    ducking: false,
    duckHeld: false,
    jumpBuffer: 0,
    lastReceivedInputSeq: 0,
    lastProcessedInputSeq: 0,
    runFrame: 0,
    score: 0,
  };
}

function updateGame(game, dt) {
  game.tick += 1;

  if (!game.running || game.gameOver) {
    return;
  }

  game.time += dt;
  game.speed = Math.min(WORLD.maxSpeed, WORLD.baseSpeed + game.time * 9.5);
  game.score += dt * game.speed * 0.08;

  updateScenery(game, dt);
  updateObstacles(game, dt);
  spawnObstacles(game);

  for (const player of game.players.values()) {
    if (!player.alive) {
      continue;
    }

    tryStartBufferedJump(player);

    player.ducking = player.duckHeld && onGround(player);
    player.vy += WORLD.gravity * dt;
    player.y += player.vy * dt;
    if (player.y >= WORLD.groundY) {
      player.y = WORLD.groundY;
      player.vy = 0;
    }
    tryStartBufferedJump(player);
    player.jumpBuffer = Math.max(0, player.jumpBuffer - dt);

    player.runFrame += dt * (onGround(player) ? game.speed / 48 : 0);
    player.score = Math.floor(game.score);

    if (collides(game, player)) {
      player.alive = false;
      player.ducking = false;
    }

    player.lastProcessedInputSeq = player.lastReceivedInputSeq;
  }

  if (game.players.size > 0 && [...game.players.values()].every((player) => !player.alive)) {
    game.gameOver = true;
  }
}

function queueJump(player) {
  player.jumpBuffer = WORLD.jumpBufferSeconds;
  player.duckHeld = false;
}

function tryStartBufferedJump(player) {
  if (player.jumpBuffer <= 0 || !onGround(player)) {
    return false;
  }

  player.vy = WORLD.jumpVelocity;
  player.ducking = false;
  player.jumpBuffer = 0;
  return true;
}

function rememberInput(player, seq) {
  if (Number.isSafeInteger(seq) && seq > player.lastReceivedInputSeq) {
    player.lastReceivedInputSeq = seq;
  }
}

function updateScenery(game, dt) {
  for (const cloud of game.clouds) {
    cloud.x -= game.speed * dt * 0.14 * cloud.scale;
    if (cloud.x < -80) {
      cloud.x = WORLD.width + randRange(game.rand, 20, 140);
      cloud.y = randRange(game.rand, 38, 112);
      cloud.scale = randRange(game.rand, 0.8, 1.6);
    }
  }

  for (const mark of game.groundMarks) {
    mark.x -= game.speed * dt;
    if (mark.x < -30) {
      mark.x = WORLD.width + randRange(game.rand, 0, 42);
      mark.w = randRange(game.rand, 8, 24);
    }
  }
}

function updateObstacles(game, dt) {
  game.nextObstacleIn -= dt * (game.speed / WORLD.baseSpeed);
  for (const obstacle of game.obstacles) {
    obstacle.x -= game.speed * dt;
    obstacle.flap += dt * 10;
  }
  game.obstacles = game.obstacles.filter((obstacle) => obstacle.x > -90);
}

function spawnObstacles(game) {
  if (game.nextObstacleIn > 0) {
    return;
  }

  const type = game.rand() > 0.72 && game.time > 12 ? "bird" : "cactus";
  const group = type === "cactus" ? 1 + Math.floor(game.rand() * 3) : 1;
  game.obstacles.push({
    type,
    x: WORLD.width + 30,
    y: type === "bird" ? WORLD.groundY - randChoice(game.rand, [78, 96, 112]) : WORLD.groundY,
    group,
    flap: 0,
    w: type === "bird" ? 56 : 24 + group * 16,
    h: type === "bird" ? 36 : 54,
  });

  game.nextObstacleIn = randRange(game.rand, 0.72, 1.28) - Math.min(0.28, game.time * 0.003);
}

function collides(game, player) {
  const playerSprite = getPlayerHitSprite(player);
  const playerInstance = {
    sprite: playerSprite,
    x: Math.round(player.x),
    y: Math.round(player.y - playerSprite.visualBottom),
  };
  return game.obstacles.some((obstacle) =>
    getObstacleHitSpriteInstances(obstacle).some((obstacleInstance) => masksOverlap(playerInstance, obstacleInstance)),
  );
}

function intersects(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function getPlayerHitSprite(player) {
  if (player.ducking) {
    return HIT_SPRITES.dino.duck;
  }
  if (!onGround(player)) {
    return HIT_SPRITES.dino.jump;
  }
  return Math.floor(player.runFrame) % 2 === 0 ? HIT_SPRITES.dino.runA : HIT_SPRITES.dino.runB;
}

function getObstacleHitSpriteInstances(obstacle) {
  if (obstacle.type === "bird") {
    const sprite = Math.floor(obstacle.flap) % 2 === 0 ? HIT_SPRITES.bird.a : HIT_SPRITES.bird.b;
    return [{ sprite, x: Math.round(obstacle.x), y: Math.round(obstacle.y - sprite.height) }];
  }

  return Array.from({ length: obstacle.group }, (_, index) => {
    const sprite = index % 2 === 0 ? HIT_SPRITES.cactus.tall : HIT_SPRITES.cactus.short;
    return {
      sprite,
      x: Math.round(obstacle.x + index * 20),
      y: Math.round(WORLD.groundY - sprite.visualBottom),
    };
  });
}

function masksOverlap(a, b) {
  if (!intersects(instanceBounds(a), instanceBounds(b))) {
    return false;
  }

  for (const aRun of a.sprite.runs) {
    const aRect = { x: a.x + aRun.x, y: a.y + aRun.y, w: aRun.w, h: aRun.h };
    for (const bRun of b.sprite.runs) {
      if (intersects(aRect, { x: b.x + bRun.x, y: b.y + bRun.y, w: bRun.w, h: bRun.h })) {
        return true;
      }
    }
  }
  return false;
}

function instanceBounds(instance) {
  return {
    x: instance.x + instance.sprite.bounds.x,
    y: instance.y + instance.sprite.bounds.y,
    w: instance.sprite.bounds.w,
    h: instance.sprite.bounds.h,
  };
}

function onGround(player) {
  return Math.abs(player.y - WORLD.groundY) < 0.5;
}

function publicStateFor(roomId, hostId, game, clientId) {
  return {
    type: "state",
    you: clientId,
    state: {
      room: roomId,
      hostId,
      isHost: hostId === clientId,
      maxPlayers: MAX_PLAYERS_PER_ROOM,
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
        vy: player.vy,
        color: player.color,
        alive: player.alive,
        ducking: player.ducking,
        duckHeld: player.duckHeld,
        onGround: onGround(player),
        runFrame: player.runFrame,
        score: player.score,
        lastProcessedInputSeq: player.lastProcessedInputSeq,
      })),
      obstacles: game.obstacles,
      clouds: game.clouds,
      groundMarks: game.groundMarks,
    },
  };
}

function normalizeRoomId(value) {
  const roomId = String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, ROOM_ID_LENGTH);
  return roomId.length >= 3 ? roomId : "";
}

function cleanName(value, fallback) {
  const name = String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 12);
  return name || fallback;
}

function randRange(rand, min, max) {
  return min + rand() * (max - min);
}

function randChoice(rand, items) {
  return items[Math.floor(rand() * items.length)];
}

function makeHitSprites() {
  const dino = {
    runA: makeHitSprite(58, [
      "...........................",
      ".............########......",
      "............##########.....",
      "............###..#####.....",
      "............##########.....",
      "............#######........",
      "#..........#########.......",
      "##.......#############.....",
      "###....#############.......",
      ".##################........",
      "..################.........",
      "...##############..........",
      "....############...........",
      ".....###########...........",
      "......#########............",
      ".......#######.............",
      ".......###..###............",
      "......###....##............",
      ".....###...................",
      ".....##....................",
      "....###....................",
    ]),
    runB: makeHitSprite(58, [
      "...........................",
      ".............########......",
      "............##########.....",
      "............###..#####.....",
      "............##########.....",
      "............#######........",
      "#..........#########.......",
      "##.......#############.....",
      "###....#############.......",
      ".##################........",
      "..################.........",
      "...##############..........",
      "....############...........",
      ".....###########...........",
      "......#########............",
      ".......#######.............",
      ".......###..###............",
      ".......##....###...........",
      "..............##...........",
      "..............###..........",
    ]),
    jump: makeHitSprite(58, [
      "...........................",
      ".............########......",
      "............##########.....",
      "............###..#####.....",
      "............##########.....",
      "............#######........",
      "#..........#########.......",
      "##.......#############.....",
      "###....#############.......",
      ".##################........",
      "..################.........",
      "...##############..........",
      "....############...........",
      ".....###########...........",
      "......#########............",
      ".......#######.............",
      ".......###.###.............",
      "......###...###............",
      ".....###.....##............",
    ]),
    duck: makeHitSprite(38, [
      "......................................",
      "........................########......",
      ".......................##########.....",
      ".......................###..#####.....",
      ".......................##########.....",
      ".......................#######........",
      "......########################........",
      "....###########################.......",
      "..############################........",
      "############################..........",
      ".#########################............",
      "...#####################..............",
      ".....##########..####.................",
      "......#######.....###.................",
      "......###.........###.................",
      ".....###..........##..................",
    ]),
  };

  const cactus = {
    tall: makeHitSprite(58, [
      "........####.......",
      "........####.......",
      "........####.......",
      "........####.......",
      "....##..####.......",
      "...###..####...##..",
      "...###..####..###..",
      "...#########..###..",
      "...#########..###..",
      "........#########..",
      "........#########..",
      "........####.......",
      "........####.......",
      "........####.......",
      "........####.......",
      "........####.......",
      "........####.......",
      "........####.......",
      "........####.......",
      "........####.......",
      "........####.......",
    ]),
    short: makeHitSprite(44, [
      "......###.....",
      "......###.....",
      "......###.....",
      "...#..###.....",
      "..##..###..#..",
      "..##..###.##..",
      "..##########..",
      "......######..",
      "......###.....",
      "......###.....",
      "......###.....",
      "......###.....",
      "......###.....",
      "......###.....",
      "......###.....",
      "......###.....",
    ]),
  };

  const bird = {
    a: makeHitSprite(38, [
      ".............................",
      "........####.................",
      ".......######................",
      "...###############...........",
      "..##################.........",
      ".######..############........",
      "..........##############.....",
      ".............############....",
      "..................#######....",
      "....................####.....",
    ]),
    b: makeHitSprite(38, [
      ".............................",
      "....................####.....",
      ".................#######.....",
      ".............##########......",
      "...###################.......",
      "..################...........",
      ".######..########............",
      "..........#####..............",
      "...........###...............",
    ]),
  };

  return { dino, cactus, bird };
}

function makeHitSprite(height, rows) {
  const scale = 2;
  const runs = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let visualBottom = 0;

  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (row[x] !== "#") {
        x += 1;
        continue;
      }

      const start = x;
      while (x < row.length && row[x] === "#") {
        x += 1;
      }

      const run = { x: start * scale, y: y * scale, w: (x - start) * scale, h: scale };
      runs.push(run);
      minX = Math.min(minX, run.x);
      minY = Math.min(minY, run.y);
      maxX = Math.max(maxX, run.x + run.w);
      maxY = Math.max(maxY, run.y + run.h);
      visualBottom = Math.max(visualBottom, run.y + run.h);
    }
  });

  return {
    height,
    visualBottom,
    runs,
    bounds: {
      x: minX === Infinity ? 0 : minX,
      y: minY === Infinity ? 0 : minY,
      w: minX === Infinity ? 0 : maxX - minX,
      h: minY === Infinity ? 0 : maxY - minY,
    },
  };
}

function mulberry32(seed) {
  return function next() {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
