import http from "http";
import { WebSocketServer } from "ws";

const PORT = process.env.PORT || 8080;
const TICK_RATE = 20;
const TICK_MS = 1000 / TICK_RATE;

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("RTS server online");
});

const wss = new WebSocketServer({ server });

const clients = new Map();
const rooms = new Map();

function gid(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function send(ws, type, data = {}) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify({ type, ...data }));
  }
}

function broadcastRoom(room, type, data = {}) {
  for (const pid of Object.keys(room.players)) {
    const player = room.players[pid];
    const ws = clients.get(player.clientId)?.ws;
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type, ...data }));
    }
  }
}

function getRoomSummary(room) {
  return {
    id: room.id,
    phase: room.phase,
    hostClientId: room.hostClientId,
    players: Object.values(room.players).map(p => ({
      id: p.id,
      clientId: p.clientId,
      name: p.name,
      ready: !!room.ready[p.id],
      color: p.color,
      alive: p.alive
    }))
  };
}

function createRoom(hostClientId, hostName) {
  const roomId = gid("room");
  const playerId = gid("player");

  const room = {
    id: roomId,
    hostClientId,
    phase: "lobby",
    createdAt: Date.now(),
    players: {},
    ready: {},
    diplomacy: {},
    gameState: null
  };

  room.players[playerId] = {
    id: playerId,
    clientId: hostClientId,
    name: hostName || "Host",
    color: "#4da3ff",
    alive: true
  };

  rooms.set(roomId, room);

  return { room, playerId };
}

function joinRoom(roomId, clientId, name) {
  const room = rooms.get(roomId);
  if (!room) return null;
  if (room.phase !== "lobby") return { error: "이미 시작된 방입니다." };

  const playerCount = Object.keys(room.players).length;
  if (playerCount >= 4) return { error: "방이 가득 찼습니다." };

  const colors = ["#4da3ff", "#ff6b6b", "#ffd166", "#7bd389"];
  const playerId = gid("player");

  room.players[playerId] = {
    id: playerId,
    clientId,
    name: name || `Player${playerCount + 1}`,
    color: colors[playerCount] || "#cccccc",
    alive: true
  };

  for (const a of Object.keys(room.players)) {
    for (const b of Object.keys(room.players)) {
      if (a === b) continue;
      const key = `${a}:${b}`;
      if (!room.diplomacy[key]) room.diplomacy[key] = "war";
    }
  }

  return { room, playerId };
}

function playerRoomByClientId(clientId) {
  for (const room of rooms.values()) {
    for (const p of Object.values(room.players)) {
      if (p.clientId === clientId) return room;
    }
  }
  return null;
}

function playerIdByClientId(room, clientId) {
  for (const p of Object.values(room.players)) {
    if (p.clientId === clientId) return p.id;
  }
  return null;
}

function initGameState(room) {
  const width = 1800;
  const height = 1000;
  const seaY = 780;
  const state = {
    startedAt: Date.now(),
    width,
    height,
    seaY,
    tick: 0,
    units: [],
    buildings: [],
    arrows: [],
    influence: [],
    tech: {},
    resources: {},
    messages: []
  };

  const spawns = [
    { x: 180, y: 160 },
    { x: width - 180, y: 160 },
    { x: 180, y: height - 260 },
    { x: width - 180, y: height - 260 }
  ];

  const playerIds = Object.keys(room.players);

  playerIds.forEach((pid, i) => {
    const s = spawns[i];
    state.resources[pid] = { gold: 500, science: 100 };
    state.tech[pid] = { researched: [], researching: null, progress: 0 };

    createBuilding(state, pid, "capital", s.x, s.y);
    createUnit(state, pid, "infantry", s.x + 50, s.y + 20);
    createUnit(state, pid, "tank", s.x - 40, s.y + 30);
  });

  state.influence = buildInfluenceGrid(state);
  room.gameState = state;
  room.phase = "playing";
}

function createUnit(state, ownerId, type, x, y) {
  const id = gid("unit");
  const u = {
    id,
    ownerId,
    type,
    x, y,
    tx: x, ty: y,
    hp: 100,
    maxHp: 100,
    speed: 60,
    range: 60,
    damage: 8,
    radius: 8,
    cooldown: 0,
    encircled: false,
    lastArrowAt: 0
  };

  if (type === "infantry") {
    u.hp = 80; u.maxHp = 80; u.speed = 52; u.range = 55; u.damage = 9; u.radius = 7;
  }
  if (type === "tank") {
    u.hp = 130; u.maxHp = 130; u.speed = 68; u.range = 68; u.damage = 16; u.radius = 10;
  }
  if (type === "ship") {
    u.hp = 160; u.maxHp = 160; u.speed = 74; u.range = 100; u.damage = 14; u.radius = 11;
  }

  state.units.push(u);
  return u;
}

function createBuilding(state, ownerId, type, x, y) {
  const id = gid("building");
  const b = {
    id,
    ownerId,
    type,
    x, y,
    hp: 300,
    maxHp: 300,
    radius: 18
  };

  if (type === "capital") {
    b.hp = 700;
    b.maxHp = 700;
    b.radius = 25;
  }

  if (type === "port") {
    b.hp = 350;
    b.maxHp = 350;
    b.radius = 20;
  }

  state.buildings.push(b);
  return b;
}

function buildInfluenceGrid(state) {
  const cell = 28;
  const cols = Math.ceil(state.width / cell);
  const rows = Math.ceil(state.height / cell);
  return { cell, cols, rows, owner: new Array(cols * rows).fill(null) };
}

function gridIndex(grid, c, r) {
  return r * grid.cols + c;
}

function recomputeInfluence(state) {
  const grid = state.influence;
  const owners = new Array(grid.cols * grid.rows).fill(null);

  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      const x = c * grid.cell + grid.cell / 2;
      const y = r * grid.cell + grid.cell / 2;
      let bestOwner = null;
      let bestScore = 0;

      for (const u of state.units) {
        const dx = u.x - x;
        const dy = u.y - y;
        const d2 = dx * dx + dy * dy;
        const range = (u.type === "infantry" ? 120 : u.type === "tank" ? 150 : 130);
        const score = Math.max(0, range * range - d2);
        if (score > bestScore) {
          bestScore = score;
          bestOwner = u.ownerId;
        }
      }

      for (const b of state.buildings) {
        const dx = b.x - x;
        const dy = b.y - y;
        const d2 = dx * dx + dy * dy;
        const range = b.type === "capital" ? 220 : 160;
        const score = Math.max(0, range * range - d2) * 1.3;
        if (score > bestScore) {
          bestScore = score;
          bestOwner = b.ownerId;
        }
      }

      owners[gridIndex(grid, c, r)] = bestOwner;
    }
  }

  grid.owner = owners;
}

function isSea(state, x, y) {
  return y > state.seaY;
}

function nearSea(state, x, y) {
  return y > state.seaY - 60;
}

function dist(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

function diplomacyBetween(room, a, b) {
  if (a === b) return "alliance";
  return room.diplomacy[`${a}:${b}`] || "war";
}

function setDiplomacy(room, a, b, status) {
  room.diplomacy[`${a}:${b}`] = status;
  room.diplomacy[`${b}:${a}`] = status;
}

function canAttack(room, attackerOwnerId, targetOwnerId) {
  return diplomacyBetween(room, attackerOwnerId, targetOwnerId) === "war";
}

function updateUnits(room, dt) {
  const state = room.gameState;

  for (const u of state.units) {
    const dx = u.tx - u.x;
    const dy = u.ty - u.y;
    const d = Math.hypot(dx, dy);

    if (d > 1) {
      const encPenalty = u.encircled ? 0.55 : 1.0;
      const spd = u.speed * encPenalty * dt;
      if (d <= spd) {
        u.x = u.tx;
        u.y = u.ty;
      } else {
        u.x += dx / d * spd;
        u.y += dy / d * spd;
      }
    }

    u.cooldown = Math.max(0, u.cooldown - dt);
  }

  state.arrows = state.arrows.filter(a => Date.now() - a.createdAt < 1600);
}

function updateEncirclement(room) {
  const state = room.gameState;
  for (const u of state.units) {
    let nearbyEnemies = 0;
    let nearbyFriends = 0;

    for (const other of state.units) {
      if (other.id === u.id) continue;
      const d = dist(u, other);
      if (d > 120) continue;

      if (other.ownerId === u.ownerId) nearbyFriends++;
      else if (canAttack(room, other.ownerId, u.ownerId)) nearbyEnemies++;
    }

    let supplyConnected = false;
    for (const b of state.buildings) {
      if (b.ownerId !== u.ownerId) continue;
      if (b.type !== "capital" && b.type !== "port") continue;
      if (dist(u, b) < 260) {
        supplyConnected = true;
        break;
      }
    }

    u.encircled = nearbyEnemies >= 2 && nearbyEnemies > nearbyFriends && !supplyConnected;

    if (u.encircled) {
      u.damage *= 0.999;
      if (u.damage < 60) u.damage = u.damage;
    }
  }
}

function updateCombat(room, dt) {
  const state = room.gameState;
  const deadUnits = new Set();
  const deadBuildings = new Set();

  for (const u of state.units) {
    let target = null;
    let bestDist = Infinity;

    for (const enemy of state.units) {
      if (enemy.ownerId === u.ownerId) continue;
      if (!canAttack(room, u.ownerId, enemy.ownerId)) continue;
      const d = dist(u, enemy);
      if (d < u.range && d < bestDist) {
        target = enemy;
        bestDist = d;
      }
    }

    if (!target) {
      for (const b of state.buildings) {
        if (b.ownerId === u.ownerId) continue;
        if (!canAttack(room, u.ownerId, b.ownerId)) continue;
        const d = dist(u, b);
        if (d < u.range + b.radius && d < bestDist) {
          target = b;
          bestDist = d;
        }
      }
    }

    if (target && u.cooldown <= 0) {
      let damage = u.damage;
      if (u.encircled) damage *= 0.7;

      if (state.tech[u.ownerId]?.researched.includes("rifle") && u.type === "infantry") {
        damage *= 1.2;
      }
      if (state.tech[u.ownerId]?.researched.includes("armor") && u.type === "tank") {
        damage *= 1.08;
      }

      target.hp -= damage;
      u.cooldown = 0.7;

      if (target.hp <= 0) {
        if ("type" in target && state.units.find(x => x.id === target.id)) deadUnits.add(target.id);
        else deadBuildings.add(target.id);
      }
    }
  }

  state.units = state.units.filter(u => !deadUnits.has(u.id));
  state.buildings = state.buildings.filter(b => !deadBuildings.has(b.id));

  for (const pid of Object.keys(room.players)) {
    const capitalAlive = state.buildings.some(b => b.ownerId === pid && b.type === "capital");
    if (!capitalAlive) {
      room.players[pid].alive = false;
    }
  }

  const alivePlayers = Object.values(room.players).filter(p => p.alive);
  if (alivePlayers.length <= 1 && room.phase === "playing") {
    room.phase = "ended";
    state.messages.push({
      id: gid("msg"),
      text: alivePlayers[0] ? `${alivePlayers[0].name} 승리` : "무승부",
      time: Date.now()
    });
  }
}

function updateResearch(room, dt) {
  const state = room.gameState;
  for (const pid of Object.keys(room.players)) {
    const t = state.tech[pid];
    if (!t || !t.researching) continue;
    const techDef = TECH_DEFS[t.researching];
    if (!techDef) continue;
    t.progress += dt;
    if (t.progress >= techDef.time) {
      t.researched.push(t.researching);
      t.researching = null;
      t.progress = 0;
    }
  }
}

function updateResources(room, dt) {
  const state = room.gameState;
  for (const pid of Object.keys(room.players)) {
    const res = state.resources[pid];
    if (!res) continue;
    const econBonus = state.tech[pid].researched.includes("economy") ? 1.2 : 1.0;
    res.gold += 5 * econBonus * dt;
    res.science += 2 * dt;
  }
}

const TECH_DEFS = {
  rifle: { costGold: 0, costScience: 120, time: 12, req: [] },
  armor: { costGold: 0, costScience: 160, time: 14, req: [] },
  port2: { costGold: 0, costScience: 140, time: 12, req: [] },
  supply: { costGold: 0, costScience: 180, time: 15, req: ["rifle"] },
  landing: { costGold: 0, costScience: 200, time: 18, req: ["port2"] },
  economy: { costGold: 0, costScience: 180, time: 16, req: [] },
  fortress: { costGold: 0, costScience: 220, time: 20, req: ["supply"] }
};

function canResearch(state, playerId, techId) {
  const def = TECH_DEFS[techId];
  if (!def) return false;
  const tech = state.tech[playerId];
  const res = state.resources[playerId];
  if (!tech || !res) return false;
  if (tech.researched.includes(techId)) return false;
  if (tech.researching) return false;
  for (const req of def.req) {
    if (!tech.researched.includes(req)) return false;
  }
  return res.science >= def.costScience && res.gold >= def.costGold;
}

function serializeState(room, forPlayerId) {
  const s = room.gameState;
  return {
    roomId: room.id,
    phase: room.phase,
    tick: s.tick,
    width: s.width,
    height: s.height,
    seaY: s.seaY,
    myPlayerId: forPlayerId,
    players: Object.values(room.players).map(p => ({
      id: p.id,
      name: p.name,
      color: p.color,
      alive: p.alive
    })),
    diplomacy: room.diplomacy,
    resources: s.resources,
    tech: s.tech,
    units: s.units,
    buildings: s.buildings,
    arrows: s.arrows,
    influence: s.influence,
    messages: s.messages.slice(-5)
  };
}

function gameLoop() {
  const dt = TICK_MS / 1000;

  for (const room of rooms.values()) {
    if (room.phase !== "playing" || !room.gameState) continue;
    const s = room.gameState;
    s.tick += 1;

    updateUnits(room, dt);
    updateEncirclement(room);
    updateCombat(room, dt);
    updateResearch(room, dt);
    updateResources(room, dt);

    if (s.tick % 10 === 0) {
      recomputeInfluence(s);
    }

    for (const pid of Object.keys(room.players)) {
      const player = room.players[pid];
      const ws = clients.get(player.clientId)?.ws;
      if (ws) send(ws, "state", serializeState(room, pid));
    }
  }
}

setInterval(gameLoop, TICK_MS);

function handleCreateRoom(ws, client, msg) {
  const name = (msg.name || "Host").slice(0, 20);
  const { room, playerId } = createRoom(client.id, name);
  client.roomId = room.id;
  client.playerId = playerId;
  send(ws, "roomJoined", {
    room: getRoomSummary(room),
    yourPlayerId: playerId
  });
}

function handleJoinRoom(ws, client, msg) {
  const name = (msg.name || "Player").slice(0, 20);
  const joined = joinRoom(msg.roomId, client.id, name);
  if (!joined) {
    send(ws, "errorMessage", { message: "방을 찾을 수 없습니다." });
    return;
  }
  if (joined.error) {
    send(ws, "errorMessage", { message: joined.error });
    return;
  }

  client.roomId = joined.room.id;
  client.playerId = joined.playerId;

  broadcastRoom(joined.room, "roomUpdated", {
    room: getRoomSummary(joined.room)
  });

  send(ws, "roomJoined", {
    room: getRoomSummary(joined.room),
    yourPlayerId: joined.playerId
  });
}

function handleReady(ws, client, msg) {
  const room = rooms.get(client.roomId);
  if (!room || room.phase !== "lobby") return;
  room.ready[client.playerId] = !!msg.ready;
  broadcastRoom(room, "roomUpdated", { room: getRoomSummary(room) });
}

function handleStart(ws, client) {
  const room = rooms.get(client.roomId);
  if (!room || room.phase !== "lobby") return;
  if (room.hostClientId !== client.id) return;

  const players = Object.keys(room.players);
  if (players.length < 2) {
    send(ws, "errorMessage", { message: "최소 2명이 필요합니다." });
    return;
  }

  const allReady = players.every(pid => pid === client.playerId || room.ready[pid]);
  if (!allReady) {
    send(ws, "errorMessage", { message: "모든 플레이어가 준비해야 합니다." });
    return;
  }

  initGameState(room);

  for (const pid of Object.keys(room.players)) {
    const p = room.players[pid];
    const pws = clients.get(p.clientId)?.ws;
    if (pws) send(pws, "gameStarted", serializeState(room, pid));
  }
}

function handleCommand(ws, client, msg) {
  const room = rooms.get(client.roomId);
  if (!room || room.phase !== "playing" || !room.gameState) return;
  const state = room.gameState;
  const myPlayerId = client.playerId;
  if (!room.players[myPlayerId]?.alive) return;

  if (msg.command === "move") {
    const unitIds = Array.isArray(msg.unitIds) ? msg.unitIds : [];
    const tx = Number(msg.tx);
    const ty = Number(msg.ty);

    for (const id of unitIds) {
      const u = state.units.find(x => x.id === id && x.ownerId === myPlayerId);
      if (!u) continue;
      u.tx = tx + (Math.random() * 30 - 15);
      u.ty = ty + (Math.random() * 30 - 15);
      state.arrows.push({
        id: gid("arrow"),
        ownerId: myPlayerId,
        fromX: u.x,
        fromY: u.y,
        toX: u.tx,
        toY: u.ty,
        createdAt: Date.now()
      });
    }
    return;
  }

  if (msg.command === "buildPort") {
    const x = Number(msg.x);
    const y = Number(msg.y);
    const res = state.resources[myPlayerId];
    if (!res || res.gold < 150) return;
    if (!nearSea(state, x, y)) return;
    res.gold -= 150;
    createBuilding(state, myPlayerId, "port", x, y);
    return;
  }

  if (msg.command === "train") {
    const buildingId = msg.buildingId;
    const unitType = msg.unitType;
    const b = state.buildings.find(x => x.id === buildingId && x.ownerId === myPlayerId);
    if (!b) return;
    const res = state.resources[myPlayerId];
    if (!res) return;

    if (unitType === "infantry" && b.type === "capital" && res.gold >= 60) {
      res.gold -= 60;
      createUnit(state, myPlayerId, "infantry", b.x + 30, b.y + 30);
    }
    if (unitType === "tank" && b.type === "capital" && res.gold >= 120) {
      res.gold -= 120;
      createUnit(state, myPlayerId, "tank", b.x - 30, b.y + 30);
    }
    if (unitType === "ship" && b.type === "port" && res.gold >= 180) {
      res.gold -= 180;
      createUnit(state, myPlayerId, "ship", b.x, state.seaY + 40);
    }
    return;
  }

  if (msg.command === "diplomacy") {
    const targetPlayerId = msg.targetPlayerId;
    const status = msg.status;
    if (!room.players[targetPlayerId]) return;
    if (!["war", "peace", "alliance"].includes(status)) return;
    setDiplomacy(room, myPlayerId, targetPlayerId, status);
    return;
  }

  if (msg.command === "research") {
    const techId = msg.techId;
    if (!canResearch(state, myPlayerId, techId)) return;
    const def = TECH_DEFS[techId];
    state.resources[myPlayerId].science -= def.costScience;
    state.resources[myPlayerId].gold -= def.costGold;
    state.tech[myPlayerId].researching = techId;
    state.tech[myPlayerId].progress = 0;
    return;
  }
}

function removeClient(clientId) {
  const client = clients.get(clientId);
  if (!client) return;

  const room = playerRoomByClientId(clientId);
  if (room) {
    const playerId = playerIdByClientId(room, clientId);

    if (playerId && room.players[playerId]) {
      delete room.players[playerId];
      delete room.ready[playerId];

      if (Object.keys(room.players).length === 0) {
        rooms.delete(room.id);
      } else {
        if (room.hostClientId === clientId) {
          const nextHost = Object.values(room.players)[0];
          room.hostClientId = nextHost.clientId;
        }

        if (room.phase === "lobby") {
          broadcastRoom(room, "roomUpdated", { room: getRoomSummary(room) });
        }
      }
    }
  }

  clients.delete(clientId);
}

wss.on("connection", (ws) => {
  const clientId = gid("client");
  const client = { id: clientId, ws, roomId: null, playerId: null };
  clients.set(clientId, client);

  send(ws, "hello", { clientId });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "createRoom") return handleCreateRoom(ws, client, msg);
    if (msg.type === "joinRoom") return handleJoinRoom(ws, client, msg);
    if (msg.type === "setReady") return handleReady(ws, client, msg);
    if (msg.type === "startGame") return handleStart(ws, client);
    if (msg.type === "command") return handleCommand(ws, client, msg);
  });

  ws.on("close", () => {
    removeClient(clientId);
  });
});

server.listen(PORT, () => {
  console.log(`RTS server listening on :${PORT}`);
});
