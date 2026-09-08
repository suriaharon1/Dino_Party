const canvas = document.querySelector("#game");
const ctx = canvas.getContext("2d");
const scoreEl = document.querySelector("#score");
const hiScoreEl = document.querySelector("#hiScore");
const modeEl = document.querySelector("#mode");
const latencyEl = document.querySelector("#latency");
const statusEl = document.querySelector("#status");
const roomInfoEl = document.querySelector("#roomInfo");
const copyInviteEl = document.querySelector("#copyInvite");
const entryPanelEl = document.querySelector("#entryPanel");
const entryNameEl = document.querySelector("#entryName");
const entryRoomEl = document.querySelector("#entryRoom");
const createRoomEl = document.querySelector("#createRoom");
const renameFormEl = document.querySelector("#renameForm");
const renameInputEl = document.querySelector("#renameInput");

const WORLD = {
  width: 960,
  height: 300,
  groundY: 232,
  gravity: 3400,
  jumpVelocity: -920,
  jumpBufferSeconds: 0.12,
};

const sprites = makeSpriteAtlas();
const PING_INTERVAL_MS = 2000;
const PING_TIMEOUT_MS = 6000;
const LATENCY_SAMPLE_LIMIT = 8;
let playerName = getPlayerName();
let activeRoom = getRequestedRoom();

let socket;
let localPlayerId = null;
let state = blankState();
let highScore = Number(localStorage.getItem("dino-party-hi") || 0);
let reconnectTimer = null;
let lastServerTick = 0;
let nextInputSeq = 1;
let pendingInputs = [];
let predictedPlayer = null;
let lastFrameAt = performance.now();
let pingTimer = null;
let nextPingId = 1;
let pendingPings = new Map();
let latencySamples = [];
let latencyMs = null;
let lastPongAt = 0;

initEntryPanel();
requestAnimationFrame(frame);

copyInviteEl.addEventListener("click", async () => {
  const inviteUrl = getInviteUrl();
  if (!inviteUrl) {
    return;
  }

  try {
    await navigator.clipboard.writeText(inviteUrl);
    statusEl.textContent = "invite copied";
  } catch {
    window.prompt("Copy invite link", inviteUrl);
  }
});

entryPanelEl.addEventListener("submit", (event) => {
  event.preventDefault();
  joinFromEntry(false);
});

createRoomEl.addEventListener("click", () => {
  joinFromEntry(true);
});

renameFormEl.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = cleanName(renameInputEl.value);
  if (!name) {
    return;
  }

  playerName = name;
  localStorage.setItem("dino-party-name", playerName);
  renameInputEl.value = playerName;
  send({ type: "rename", name: playerName });
  statusEl.textContent = `online as ${playerName}`;
});

entryRoomEl.addEventListener("input", () => {
  entryRoomEl.value = normalizeRoomCode(entryRoomEl.value);
});

entryNameEl.addEventListener("input", () => {
  entryNameEl.value = entryNameEl.value.slice(0, 12);
});

renameInputEl.addEventListener("input", () => {
  renameInputEl.value = renameInputEl.value.slice(0, 12);
});

window.addEventListener("keydown", (event) => {
  if (isTyping(event.target)) {
    return;
  }

  if (["Space", "ArrowUp", "ArrowDown", "KeyW", "KeyS"].includes(event.code)) {
    event.preventDefault();
  }

  if (event.repeat) {
    return;
  }

  if (event.code === "Space" || event.code === "ArrowUp" || event.code === "KeyW") {
    const action = primaryAction();
    if (action) {
      sendInput(action);
    }
  } else if (event.code === "ArrowDown" || event.code === "KeyS") {
    sendInput("duck", true);
  } else if (event.code === "KeyR") {
    if (state.isHost) {
      sendInput("restart");
    }
  }
});

window.addEventListener("keyup", (event) => {
  if (isTyping(event.target)) {
    return;
  }

  if (event.code === "ArrowDown" || event.code === "KeyS") {
    sendInput("duck", false);
  }
});

function connect() {
  clearTimeout(reconnectTimer);
  localPlayerId = null;
  pendingInputs = [];
  predictedPlayer = null;
  state = { ...blankState(), room: activeRoom };
  statusEl.textContent = "connecting";
  const socketUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?room=${encodeURIComponent(activeRoom)}`;
  socket = new WebSocket(socketUrl);

  socket.addEventListener("open", () => {
    statusEl.textContent = `online as ${playerName}`;
    send({ type: "join", name: playerName, room: activeRoom });
    startLatencyMonitor();
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "pong") {
      recordLatency(message);
      return;
    }

    if (message.type === "welcome") {
      localPlayerId = message.id;
      state.room = message.room;
      state.isHost = message.host;
      state.maxPlayers = message.maxPlayers;
      updateRoomUrl(message.room);
      updateDom();
      return;
    }

    if (message.type === "rejected") {
      state.rejected = message.reason;
      state.room = message.room;
      state.maxPlayers = message.maxPlayers;
      statusEl.textContent = message.reason === "room-full" ? "room full" : "unable to join";
      entryPanelEl.hidden = false;
      entryRoomEl.select();
      updateDom();
      return;
    }

    if (message.type === "state") {
      localPlayerId = message.you ?? localPlayerId;
      state = message.state;
      reconcilePrediction();
      lastServerTick = performance.now();
      lastFrameAt = lastServerTick;
      highScore = Math.max(highScore, Math.floor(state.score));
      localStorage.setItem("dino-party-hi", String(highScore));
      updateDom();
    }
  });

  socket.addEventListener("close", () => {
    stopLatencyMonitor();
    if (state.rejected) {
      return;
    }
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

function startLatencyMonitor() {
  stopLatencyMonitor();
  pendingPings = new Map();
  latencySamples = [];
  latencyMs = null;
  lastPongAt = 0;
  updateLatencyDom();
  sendPing();
  pingTimer = setInterval(sendPing, PING_INTERVAL_MS);
}

function stopLatencyMonitor() {
  clearInterval(pingTimer);
  pingTimer = null;
  pendingPings = new Map();
  latencyMs = null;
  updateLatencyDom();
}

function sendPing() {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }

  const now = performance.now();
  for (const [id, sentAt] of pendingPings) {
    if (now - sentAt > PING_TIMEOUT_MS) {
      pendingPings.delete(id);
    }
  }

  const id = nextPingId++;
  pendingPings.set(id, now);
  send({
    type: "ping",
    id,
    sentAt: now,
  });
  updateLatencyDom();
}

function recordLatency(message) {
  const sentAt = pendingPings.get(message.id);
  if (typeof sentAt !== "number") {
    return;
  }

  pendingPings.delete(message.id);
  const roundTripMs = performance.now() - sentAt;
  latencySamples.push(roundTripMs);
  latencySamples = latencySamples.slice(-LATENCY_SAMPLE_LIMIT);
  latencyMs = latencySamples.reduce((sum, sample) => sum + sample, 0) / latencySamples.length;
  lastPongAt = performance.now();
  updateLatencyDom();
}

function updateLatencyDom() {
  if (!latencyEl) {
    return;
  }

  if (!socket || socket.readyState !== WebSocket.OPEN) {
    latencyEl.textContent = "PING --";
    return;
  }

  if (latencyMs === null) {
    latencyEl.textContent = pendingPings.size > 0 ? "PING ..." : "PING --";
    return;
  }

  const ageMs = performance.now() - lastPongAt;
  const stale = ageMs > PING_TIMEOUT_MS;
  latencyEl.textContent = stale ? "PING stale" : `PING ${Math.round(latencyMs)}ms`;
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
  const now = performance.now();
  const dt = Math.min(0.05, Math.max(0, (now - lastFrameAt) / 1000));
  lastFrameAt = now;

  advanceVisualWorld(dt);
  updatePrediction(dt);
  draw();
  requestAnimationFrame(frame);
}

function blankState() {
  return {
    room: "",
    isHost: false,
    hostId: null,
    maxPlayers: 5,
    rejected: "",
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

function initEntryPanel() {
  entryNameEl.value = playerName;
  entryRoomEl.value = activeRoom;
  renameInputEl.value = playerName;
  statusEl.textContent = "choose room";
  updateRoomUrl(activeRoom);
  updateDom();
}

function joinFromEntry(createNewRoom) {
  const name = cleanName(entryNameEl.value) || getPlayerName();
  const room = createNewRoom ? createRoomCode() : normalizeRoomCode(entryRoomEl.value || activeRoom || createRoomCode());

  playerName = name;
  activeRoom = room;
  localStorage.setItem("dino-party-name", playerName);
  entryNameEl.value = playerName;
  entryRoomEl.value = activeRoom;
  renameInputEl.value = playerName;
  entryPanelEl.hidden = true;
  updateRoomUrl(activeRoom);
  connect();
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

  replaceLocalPlayer(predictedPlayer);
}

function applyLocalInput(input) {
  if (input.action === "start") {
    state.running = true;
  } else if (input.action === "restart") {
    state.running = false;
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
    player.jumpBuffer = 0;
    return;
  }

  if (!player.alive) {
    return;
  }

  if (input.action === "start" || input.action === "jump") {
    player.duckHeld = false;
    player.jumpBuffer = WORLD.jumpBufferSeconds;
    tryStartPredictedJump(player);
  } else if (input.action === "duck") {
    player.duckHeld = Boolean(input.active);
    player.ducking = player.duckHeld && isPredictedOnGround(player);
  }
}

function updatePrediction(dt) {
  const hasStartIntent = pendingInputs.some((input) => input.action === "start");
  const hasRestartIntent = pendingInputs.some((input) => input.action === "restart");
  if (hasStartIntent) {
    state.running = true;
    state.gameOver = false;
  } else if (hasRestartIntent) {
    state.running = false;
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

function advanceVisualWorld(dt) {
  if (!state.running || state.gameOver || dt <= 0 || performance.now() - lastServerTick > 1000) {
    return;
  }

  const speed = state.speed || 360;
  state.score += dt * speed * 0.08;

  for (const cloud of state.clouds) {
    cloud.x -= speed * dt * 0.14 * cloud.scale;
    if (cloud.x < -80) {
      cloud.x += WORLD.width + 160;
    }
  }

  for (const mark of state.groundMarks) {
    mark.x -= speed * dt;
    if (mark.x < -30) {
      mark.x += WORLD.width + 42;
    }
  }

  for (const obstacle of state.obstacles) {
    obstacle.x -= speed * dt;
    obstacle.flap += dt * 10;
  }
  state.obstacles = state.obstacles.filter((obstacle) => obstacle.x > -90);
}

function simulatePredictedPlayer(player, dt, speed) {
  if (!player.alive || dt <= 0) {
    return;
  }

  tryStartPredictedJump(player);
  player.ducking = player.duckHeld && isPredictedOnGround(player);
  player.vy += WORLD.gravity * dt;
  player.y += player.vy * dt;

  if (player.y >= WORLD.groundY) {
    player.y = WORLD.groundY;
    player.vy = 0;
  }

  tryStartPredictedJump(player);
  player.jumpBuffer = Math.max(0, player.jumpBuffer - dt);
  player.onGround = isPredictedOnGround(player);
  if (player.onGround) {
    player.runFrame += dt * (speed / 48);
  }
}

function tryStartPredictedJump(player) {
  if ((player.jumpBuffer || 0) <= 0 || !isPredictedOnGround(player)) {
    return false;
  }

  player.vy = WORLD.jumpVelocity;
  player.ducking = false;
  player.onGround = false;
  player.jumpBuffer = 0;
  return true;
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
    jumpBuffer: player.jumpBuffer || 0,
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
    drawTintedSprite(sprite, Math.round(player.x), groundedSpriteY(sprite, player.y), player.color);
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
        ctx.drawImage(sprite, Math.round(obstacle.x + index * 20), groundedSpriteY(sprite, WORLD.groundY), sprite.width, sprite.height);
      }
    }
  }
}

function groundedSpriteY(sprite, groundY) {
  return Math.round(groundY - sprite.visualBottom);
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

  if (state.rejected) {
    ctx.fillText("ROOM FULL", WORLD.width / 2, 104);
    ctx.font = "14px monospace";
    ctx.fillText(`${state.room} already has ${state.maxPlayers} players`, WORLD.width / 2, 130);
  } else if (!localPlayerId) {
    ctx.fillText("Join a room", WORLD.width / 2, 104);
    ctx.font = "14px monospace";
    ctx.fillText("Choose a name, enter a code, or create a party", WORLD.width / 2, 130);
  } else if (!state.running) {
    ctx.fillText(state.isHost ? "Waiting room" : "Waiting for host", WORLD.width / 2, 88);
    ctx.font = "14px monospace";
    ctx.fillText(`Room ${state.room || "--"} - ${state.players.length}/${state.maxPlayers}`, WORLD.width / 2, 114);
    ctx.fillText(state.isHost ? "Press Space to start" : "Share the room link and get ready", WORLD.width / 2, 140);
    drawWaitingPlayers();
  } else if (state.gameOver) {
    ctx.fillText("GAME OVER", WORLD.width / 2, 104);
    ctx.font = "14px monospace";
    ctx.fillText(state.isHost ? "Press R to return everyone to the waiting room" : "Waiting for host to reset", WORLD.width / 2, 130);
  } else if (performance.now() - lastServerTick > 1500) {
    ctx.fillText("Waiting for server...", WORLD.width / 2, 118);
  }
}

function drawWaitingPlayers() {
  const startX = WORLD.width / 2 - ((state.players.length - 1) * 68) / 2;
  state.players.forEach((player, index) => {
    const x = startX + index * 68;
    const y = 188;
    const sprite = sprites.dino.runA;
    drawTintedSprite(sprite, Math.round(x - 27), groundedSpriteY(sprite, y), player.color);
    ctx.fillStyle = player.id === state.hostId ? "#202124" : "#5f6368";
    ctx.font = "12px monospace";
    ctx.textAlign = "center";
    ctx.fillText(player.id === state.hostId ? `${player.name} HOST` : player.name, x, y + 24);
  });
}

function updateDom() {
  const localPlayer = state.players.find((player) => player.id === localPlayerId);
  scoreEl.textContent = pad(localPlayer ? localPlayer.score : Math.floor(state.score));
  hiScoreEl.textContent = `HI ${pad(highScore)}`;
  modeEl.textContent = state.room ? `ROOM ${state.room}` : `ONLINE ${state.players.length}`;
  roomInfoEl.textContent = state.room ? `Room: ${state.room} (${state.players.length}/${state.maxPlayers})` : "Room: --";
  copyInviteEl.disabled = !state.room || Boolean(state.rejected);
}

function getPlayerName() {
  const params = new URLSearchParams(location.search);
  const fromUrl = params.get("name");
  if (fromUrl) {
    const name = cleanName(fromUrl);
    localStorage.setItem("dino-party-name", name);
    return name;
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

function primaryAction() {
  if (state.gameOver) {
    return state.isHost ? "restart" : null;
  }
  if (!state.running) {
    return state.isHost ? "start" : null;
  }
  return "jump";
}

function getRequestedRoom() {
  return normalizeRoomCode(new URLSearchParams(location.search).get("room"));
}

function createRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

function normalizeRoomCode(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 5);
}

function cleanName(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 12);
}

function isTyping(target) {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}

function updateRoomUrl(room) {
  const url = new URL(location.href);
  if (!room) {
    url.searchParams.delete("room");
    history.replaceState(null, "", url);
    return;
  }

  if (url.searchParams.get("room") === room) {
    return;
  }

  url.searchParams.set("room", room);
  history.replaceState(null, "", url);
}

function getInviteUrl() {
  if (!state.room) {
    return "";
  }

  const url = new URL(location.href);
  url.searchParams.set("room", state.room);
  return url.toString();
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
  source.visualBottom = getVisualBottom(rows, scale);
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

function getVisualBottom(rows, scale) {
  for (let y = rows.length - 1; y >= 0; y -= 1) {
    if (rows[y].includes("#")) {
      return y * scale + scale;
    }
  }
  return 0;
}
