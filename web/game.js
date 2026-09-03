const canvas = document.querySelector("#game");
const ctx = canvas.getContext("2d");
const scoreEl = document.querySelector("#score");
const hiScoreEl = document.querySelector("#hiScore");
const modeEl = document.querySelector("#mode");
const statusEl = document.querySelector("#status");

const WORLD = {
  width: 960,
  height: 300,
  groundY: 232,
  gravity: 2450,
  jumpVelocity: -760,
};

const sprites = makeSpriteAtlas();
const socketUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
const playerName = getPlayerName();

let socket;
let localPlayerId = null;
let state = blankState();
let highScore = Number(localStorage.getItem("dino-party-hi") || 0);
let reconnectTimer = null;
let lastServerTick = 0;
let nextInputSeq = 1;
let pendingInputs = [];
let predictedPlayer = null;
let lastPredictionAt = performance.now();

connect();
requestAnimationFrame(frame);

window.addEventListener("keydown", (event) => {
  if (["Space", "ArrowUp", "ArrowDown", "KeyW", "KeyS"].includes(event.code)) {
    event.preventDefault();
  }

  if (event.repeat) {
    return;
  }

  if (event.code === "Space" || event.code === "ArrowUp" || event.code === "KeyW") {
    sendInput(state.gameOver ? "restart" : state.running ? "jump" : "start");
  } else if (event.code === "ArrowDown" || event.code === "KeyS") {
    sendInput("duck", true);
  } else if (event.code === "KeyR") {
    sendInput("restart");
  }
});

window.addEventListener("keyup", (event) => {
  if (event.code === "ArrowDown" || event.code === "KeyS") {
    sendInput("duck", false);
  }
});

function connect() {
  clearTimeout(reconnectTimer);
  statusEl.textContent = "connecting";
  socket = new WebSocket(socketUrl);

  socket.addEventListener("open", () => {
    statusEl.textContent = `online as ${playerName}`;
    send({ type: "join", name: playerName });
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "welcome") {
      localPlayerId = message.id;
      return;
    }

    if (message.type === "state") {
      localPlayerId = message.you ?? localPlayerId;
      state = message.state;
      reconcilePrediction();
      lastServerTick = performance.now();
      highScore = Math.max(highScore, Math.floor(state.score));
      localStorage.setItem("dino-party-hi", String(highScore));
      updateDom();
    }
  });

  socket.addEventListener("close", () => {
    statusEl.textContent = "offline - reconnecting";
    reconnectTimer = setTimeout(connect, 900);
  });

  socket.addEventListener("error", () => {
    statusEl.textContent = "connection error";
  });
}

function send(message) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
    return true;
  }
  return false;
}

function sendInput(action, active) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }

  const input = {
    type: "input",
    action,
    seq: nextInputSeq++,
  };

  if (typeof active === "boolean") {
    input.active = active;
  }

  pendingInputs.push(input);
  applyLocalInput(input);
  send(input);
}

function frame() {
  updatePrediction();
  draw();
  requestAnimationFrame(frame);
}

function blankState() {
  return {
    running: false,
    gameOver: false,
    score: 0,
    speed: 360,
    players: [],
    obstacles: [],
    clouds: [],
    groundMarks: [],
  };
}

function reconcilePrediction() {
  const serverPlayer = state.players.find((player) => player.id === localPlayerId);
  if (!serverPlayer) {
    predictedPlayer = null;
    pendingInputs = [];
    return;
  }

  const ackSeq = serverPlayer.lastProcessedInputSeq || 0;
  pendingInputs = pendingInputs.filter((input) => input.seq > ackSeq);
  predictedPlayer = clonePlayer(serverPlayer);

  for (const input of pendingInputs) {
    applyPredictedInput(predictedPlayer, input);
  }

  lastPredictionAt = performance.now();
  replaceLocalPlayer(predictedPlayer);
}

function applyLocalInput(input) {
  if (input.action === "start") {
    state.running = true;
  } else if (input.action === "restart") {
    state.running = true;
    state.gameOver = false;
  }

  if (!predictedPlayer) {
    const serverPlayer = state.players.find((player) => player.id === localPlayerId);
    predictedPlayer = serverPlayer ? clonePlayer(serverPlayer) : null;
  }

  if (predictedPlayer) {
    applyPredictedInput(predictedPlayer, input);
    replaceLocalPlayer(predictedPlayer);
  }
}

function applyPredictedInput(player, input) {
  if (input.action === "restart") {
    player.y = WORLD.groundY;
    player.vy = 0;
    player.alive = true;
    player.ducking = false;
    player.duckHeld = false;
    player.onGround = true;
    player.runFrame = 0;
    return;
  }

  if (!player.alive) {
    return;
  }

  if (input.action === "start" || input.action === "jump") {
    player.duckHeld = false;
    if (isPredictedOnGround(player)) {
      player.vy = WORLD.jumpVelocity;
      player.ducking = false;
      player.onGround = false;
    }
  } else if (input.action === "duck") {
    player.duckHeld = Boolean(input.active);
    player.ducking = player.duckHeld && isPredictedOnGround(player);
  }
}

function updatePrediction() {
  const now = performance.now();
  const dt = Math.min(0.05, Math.max(0, (now - lastPredictionAt) / 1000));
  lastPredictionAt = now;

  const hasRunIntent = pendingInputs.some((input) => input.action === "start" || input.action === "restart");
  if (hasRunIntent) {
    state.running = true;
    state.gameOver = false;
  }

  if (!predictedPlayer) {
    return;
  }

  const authoritativePlayer = state.players.find((player) => player.id === localPlayerId);
  if (!authoritativePlayer) {
    predictedPlayer = null;
    return;
  }

  if (!authoritativePlayer.alive || state.gameOver) {
    predictedPlayer = clonePlayer(authoritativePlayer);
    pendingInputs = pendingInputs.filter((input) => input.action === "restart");
    replaceLocalPlayer(predictedPlayer);
    return;
  }

  simulatePredictedPlayer(predictedPlayer, dt, state.speed);
  replaceLocalPlayer(predictedPlayer);
}

function simulatePredictedPlayer(player, dt, speed) {
  if (!player.alive || dt <= 0) {
    return;
  }

  player.ducking = player.duckHeld && isPredictedOnGround(player);
  player.vy += WORLD.gravity * dt;
  player.y += player.vy * dt;

  if (player.y >= WORLD.groundY) {
    player.y = WORLD.groundY;
    player.vy = 0;
  }

  player.onGround = isPredictedOnGround(player);
  if (player.onGround) {
    player.runFrame += dt * (speed / 48);
  }
}

function replaceLocalPlayer(player) {
  const index = state.players.findIndex((candidate) => candidate.id === localPlayerId);
  if (index !== -1) {
    state.players[index] = { ...player };
  }
}

function clonePlayer(player) {
  return {
    ...player,
    vy: player.vy || 0,
    duckHeld: Boolean(player.duckHeld),
  };
}

function isPredictedOnGround(player) {
  return Math.abs(player.y - WORLD.groundY) < 0.5;
}

function draw() {
  resizeCanvas();
  ctx.setTransform(canvas.width / WORLD.width, 0, 0, canvas.height / WORLD.height, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, WORLD.width, WORLD.height);

  drawClouds();
  drawGround();
  drawObstacles();
  drawPlayers();
  drawPlayerBoard();
  drawOverlayText();
}

function resizeCanvas() {
  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  const targetWidth = Math.floor(canvas.clientWidth * dpr);
  const targetHeight = Math.floor(canvas.clientHeight * dpr);
  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth;
    canvas.height = targetHeight;
  }
}

function drawClouds() {
  ctx.strokeStyle = "#d9dde5";
  ctx.lineWidth = 3;
  for (const cloud of state.clouds) {
    ctx.save();
    ctx.translate(cloud.x, cloud.y);
    ctx.scale(cloud.scale, cloud.scale);
    ctx.beginPath();
    ctx.moveTo(0, 18);
    ctx.lineTo(16, 18);
    ctx.moveTo(12, 18);
    ctx.quadraticCurveTo(20, 4, 34, 14);
    ctx.quadraticCurveTo(46, 6, 58, 18);
    ctx.lineTo(78, 18);
    ctx.stroke();
    ctx.restore();
  }
}

function drawGround() {
  ctx.strokeStyle = "#5f6368";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(0, WORLD.groundY + 1);
  ctx.lineTo(WORLD.width, WORLD.groundY + 1);
  ctx.stroke();

  ctx.fillStyle = "#bdc1c6";
  for (const mark of state.groundMarks) {
    ctx.fillRect(Math.round(mark.x), WORLD.groundY + 14, mark.w, 3);
  }
}

function drawPlayers() {
  for (const player of state.players) {
    const frameName = player.alive
      ? player.ducking
        ? "duck"
        : player.onGround
          ? Math.floor(player.runFrame) % 2 === 0
            ? "runA"
            : "runB"
          : "jump"
      : "dead";

    const sprite = sprites.dino[frameName];
    const isLocal = player.id === localPlayerId;
    ctx.save();
    ctx.globalAlpha = player.alive ? (isLocal ? 1 : 0.72) : 0.45;
    drawTintedSprite(sprite, Math.round(player.x), Math.round(player.y - sprite.height), player.color);
    ctx.fillStyle = isLocal ? "#202124" : player.color;
    ctx.fillRect(player.x + 14, player.y + 8, 30, 4);
    ctx.font = "12px monospace";
    ctx.textAlign = "center";
    ctx.fillText(player.name, player.x + 28, player.y + 28);
    ctx.restore();
  }
}

function drawTintedSprite(sprite, x, y, color) {
  ctx.drawImage(sprite, x, y, sprite.width, sprite.height);
  if (color === "#202124") {
    return;
  }

  ctx.save();
  ctx.globalCompositeOperation = "source-atop";
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.65;
  ctx.fillRect(x, y, sprite.width, sprite.height);
  ctx.restore();
}

function drawObstacles() {
  for (const obstacle of state.obstacles) {
    if (obstacle.type === "bird") {
      const sprite = Math.floor(obstacle.flap) % 2 === 0 ? sprites.bird.a : sprites.bird.b;
      ctx.drawImage(sprite, Math.round(obstacle.x), Math.round(obstacle.y - sprite.height), sprite.width, sprite.height);
    } else {
      for (let index = 0; index < obstacle.group; index += 1) {
        const sprite = index % 2 === 0 ? sprites.cactus.tall : sprites.cactus.short;
        ctx.drawImage(sprite, Math.round(obstacle.x + index * 20), Math.round(WORLD.groundY - sprite.height), sprite.width, sprite.height);
      }
    }
  }
}

function drawPlayerBoard() {
  if (state.players.length <= 1) {
    return;
  }

  const boardX = WORLD.width - 176;
  const boardHeight = Math.min(160, 24 + state.players.length * 23);
  ctx.fillStyle = "rgba(255,255,255,0.84)";
  ctx.fillRect(boardX - 10, 18, 166, boardHeight);
  ctx.strokeStyle = "#d7dbe3";
  ctx.strokeRect(boardX - 10, 18, 166, boardHeight);
  ctx.fillStyle = "#5f6368";
  ctx.font = "12px monospace";
  ctx.textAlign = "left";
  ctx.fillText("Players", boardX, 36);

  state.players.forEach((player, index) => {
    const y = 58 + index * 22;
    ctx.fillStyle = player.alive ? player.color : "#9aa0a6";
    ctx.fillRect(boardX, y - 10, 8, 8);
    ctx.fillStyle = "#3c4043";
    ctx.fillText(`${player.name} ${pad(player.score)}`, boardX + 16, y);
  });
}

function drawOverlayText() {
  ctx.textAlign = "center";
  ctx.fillStyle = "#3c4043";
  ctx.font = "700 18px monospace";

  if (!state.running) {
    ctx.fillText("Press Space to start the shared race", WORLD.width / 2, 118);
  } else if (state.gameOver) {
    ctx.fillText("GAME OVER", WORLD.width / 2, 104);
    ctx.font = "14px monospace";
    ctx.fillText("Press R or Space to restart for everyone", WORLD.width / 2, 130);
  } else if (performance.now() - lastServerTick > 1500) {
    ctx.fillText("Waiting for server...", WORLD.width / 2, 118);
  }
}

function updateDom() {
  const localPlayer = state.players.find((player) => player.id === localPlayerId);
  scoreEl.textContent = pad(localPlayer ? localPlayer.score : Math.floor(state.score));
  hiScoreEl.textContent = `HI ${pad(highScore)}`;
  modeEl.textContent = `ONLINE ${state.players.length}`;
}

function getPlayerName() {
  const params = new URLSearchParams(location.search);
  const fromUrl = params.get("name");
  if (fromUrl) {
    localStorage.setItem("dino-party-name", fromUrl.slice(0, 12));
    return fromUrl.slice(0, 12);
  }

  const existing = localStorage.getItem("dino-party-name");
  if (existing) {
    return existing;
  }

  const generated = `Dino${Math.floor(100 + Math.random() * 900)}`;
  localStorage.setItem("dino-party-name", generated);
  return generated;
}

function pad(value) {
  return String(value).padStart(5, "0");
}

function makeSpriteAtlas() {
  return {
    dino: {
      runA: sprite(54, 58, [
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
      runB: sprite(54, 58, [
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
      jump: sprite(54, 58, [
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
      duck: sprite(76, 38, [
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
      dead: sprite(54, 58, [
        "...........................",
        ".............########......",
        "............##########.....",
        "............##.#.#.###.....",
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
    },
    cactus: {
      tall: sprite(30, 58, [
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
      short: sprite(24, 44, [
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
    },
    bird: {
      a: sprite(58, 38, [
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
      b: sprite(58, 38, [
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
    },
  };
}

function sprite(width, height, rows) {
  const scale = 2;
  const source = document.createElement("canvas");
  source.width = width;
  source.height = height;
  const sctx = source.getContext("2d");
  sctx.imageSmoothingEnabled = false;
  sctx.fillStyle = "#202124";

  rows.forEach((row, y) => {
    [...row].forEach((cell, x) => {
      if (cell === "#") {
        sctx.fillRect(x * scale, y * scale, scale, scale);
      }
    });
  });

  return source;
}
