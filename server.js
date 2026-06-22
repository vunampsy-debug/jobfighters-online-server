const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const rooms = new Map();
let nextPlayerSeq = 1;

function nowIso() {
  return new Date().toISOString();
}

function makePlayerId() {
  return `p_${Date.now().toString(36)}_${(nextPlayerSeq++).toString(36)}`;
}

function makeRoomCode() {
  for (let tries = 0; tries < 64; tries++) {
    let code = "";
    for (let i = 0; i < 4; i++) code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
    if (!rooms.has(code)) return code;
  }
  return Math.random().toString(36).slice(2, 6).toUpperCase();
}

function safeJson(data) {
  try { return JSON.stringify(data); } catch (_) { return JSON.stringify({ type: "roomError", message: "Server could not serialize message." }); }
}

function send(ws, payload) {
  if (!ws || ws.readyState !== ws.OPEN) return false;
  try { ws.send(safeJson(payload)); return true; } catch (_) { return false; }
}

function normalizeRoomCode(raw) {
  return String(raw || "").trim().toUpperCase();
}

function normalizeMaxPlayers(msg = {}, fallback = 2) {
  const n = Number(msg.maxPlayers || msg.players || 0);
  if (n === 4) return 4;
  const mode = String(msg.roomMode || msg.teamMode || msg.mode || "").toLowerCase();
  if (mode.includes("2v2") || mode.includes("2vs2") || mode === "4") return 4;
  return Number(fallback) === 4 ? 4 : 2;
}

function roomMode(maxPlayers) {
  return Number(maxPlayers) === 4 ? "2v2" : "1v1";
}

function roster(room) {
  return Array.from(room.clients.values()).map(client => ({
    playerId: client.playerId,
    playerNumber: client.playerNumber,
    role: client.role,
    ready: !!room.ready[client.playerNumber],
    characterId: room.selectedCharacters[client.playerNumber] || null
  })).sort((a, b) => a.playerNumber - b.playerNumber);
}

function broadcast(room, payload, options = {}) {
  if (!room) return;
  const data = { roomCode: room.code, code: room.code, maxPlayers: room.maxPlayers, roomMode: room.roomMode, teamMode: room.roomMode, ...payload };
  for (const [clientWs] of room.clients.entries()) {
    if (options.exclude && clientWs === options.exclude) continue;
    send(clientWs, data);
  }
}

function findClientRoom(ws) {
  const client = ws.__jfcClient;
  if (!client || !client.roomCode) return null;
  return rooms.get(client.roomCode) || null;
}

function nextSlot(room) {
  const used = new Set(Array.from(room.clients.values()).map(c => c.playerNumber));
  for (let i = 1; i <= room.maxPlayers; i++) if (!used.has(i)) return i;
  return 0;
}

function createRoom(ws, msg = {}) {
  const client = ws.__jfcClient;
  const maxPlayers = normalizeMaxPlayers(msg, 2);
  const code = makeRoomCode();
  const room = {
    code,
    maxPlayers,
    roomMode: roomMode(maxPlayers),
    hostId: client.playerId,
    clients: new Map(),
    rules: {},
    selectedStage: null,
    selectedCharacters: {},
    ready: {},
    lastStartMatch: null,
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  client.roomCode = code;
  client.role = "host";
  client.playerNumber = 1;
  room.clients.set(ws, client);
  rooms.set(code, room);

  send(ws, {
    type: "roomCreated",
    roomCode: code,
    code,
    playerId: client.playerId,
    role: "host",
    playerNumber: 1,
    maxPlayers,
    roomMode: room.roomMode,
    teamMode: room.roomMode,
    roster: roster(room)
  });
}

function joinRoom(ws, msg = {}) {
  const client = ws.__jfcClient;
  const code = normalizeRoomCode(msg.roomCode || msg.code || msg.room);
  const room = rooms.get(code);
  if (!room) return send(ws, { type: "roomError", message: "Không tìm thấy phòng.", roomCode: code, code });
  if (room.clients.size >= room.maxPlayers) return send(ws, { type: "roomError", message: "Phòng đã đủ người.", roomCode: code, code });

  const slot = nextSlot(room);
  if (!slot) return send(ws, { type: "roomError", message: "Không còn slot trống.", roomCode: code, code });

  client.roomCode = code;
  client.role = slot === 1 ? "host" : "guest";
  client.playerNumber = slot;
  room.clients.set(ws, client);
  room.updatedAt = nowIso();

  send(ws, {
    type: "roomJoined",
    roomCode: code,
    code,
    playerId: client.playerId,
    role: client.role,
    playerNumber: slot,
    maxPlayers: room.maxPlayers,
    roomMode: room.roomMode,
    teamMode: room.roomMode,
    roster: roster(room),
    rules: room.rules,
    selectedStage: room.selectedStage,
    selectedCharacters: room.selectedCharacters
  });

  broadcast(room, {
    type: "playerJoined",
    playerId: client.playerId,
    guestId: client.playerId,
    role: client.role,
    playerNumber: slot,
    count: room.clients.size,
    roster: roster(room)
  });

  if (room.rules && Object.keys(room.rules).length) {
    send(ws, { type: "rulesUpdated", roomCode: code, code, rules: room.rules, matchRules: room.rules, maxPlayers: room.maxPlayers, roomMode: room.roomMode, roster: roster(room) });
  }
  if (room.selectedStage) {
    send(ws, { type: "stageSelected", roomCode: code, code, stage: room.selectedStage, stageId: room.selectedStage, maxPlayers: room.maxPlayers, roomMode: room.roomMode });
  }
  for (const [playerNumber, characterId] of Object.entries(room.selectedCharacters)) {
    send(ws, { type: "characterSelected", roomCode: code, code, playerNumber: Number(playerNumber), player: Number(playerNumber), characterId, charId: characterId, maxPlayers: room.maxPlayers, roomMode: room.roomMode });
  }
  if (room.lastStartMatch) send(ws, room.lastStartMatch);
}

function requireRoom(ws) {
  const room = findClientRoom(ws);
  if (!room) send(ws, { type: "roomError", message: "Bạn chưa ở trong phòng." });
  return room;
}

function setRules(ws, msg = {}) {
  const room = requireRoom(ws); if (!room) return;
  room.rules = msg.rules || msg.matchRules || {};
  if (room.rules.teamMode === "2v2") {
    room.maxPlayers = 4;
    room.roomMode = "2v2";
  }
  room.updatedAt = nowIso();
  broadcast(room, { type: "rulesUpdated", rules: room.rules, matchRules: room.rules, roster: roster(room) });
}

function selectCharacter(ws, msg = {}) {
  const room = requireRoom(ws); if (!room) return;
  const client = ws.__jfcClient;
  const playerNumber = Number(msg.playerNumber || msg.player || client.playerNumber || 0);
  const characterId = String(msg.characterId || msg.charId || msg.id || "");
  if (!playerNumber || !characterId) return send(ws, { type: "roomError", message: "Thiếu playerNumber hoặc characterId." });
  room.selectedCharacters[playerNumber] = characterId;
  room.updatedAt = nowIso();
  broadcast(room, { type: "characterSelected", playerNumber, player: playerNumber, characterId, charId: characterId, roster: roster(room) });
}

function selectStage(ws, msg = {}) {
  const room = requireRoom(ws); if (!room) return;
  const stage = String(msg.stageId || msg.stage || "").trim();
  if (!stage) return send(ws, { type: "roomError", message: "Thiếu stageId." });
  room.selectedStage = stage;
  room.updatedAt = nowIso();
  broadcast(room, { type: "stageSelected", stageId: stage, stage });
}

function playerReady(ws, msg = {}) {
  const room = requireRoom(ws); if (!room) return;
  const client = ws.__jfcClient;
  const playerNumber = Number(msg.playerNumber || client.playerNumber || 0);
  if (playerNumber) room.ready[playerNumber] = true;
  room.updatedAt = nowIso();
  if (msg.startMatch || msg.start || msg.matchStart || msg.fallbackStartSignal) return startMatch(ws, { ...msg, playerNumber });
  broadcast(room, { type: "playerReady", playerNumber, player: playerNumber, role: client.role, ready: true, roster: roster(room) });
}

function startMatch(ws, msg = {}) {
  const room = requireRoom(ws); if (!room) return;
  const client = ws.__jfcClient;
  const maxPlayers = normalizeMaxPlayers(msg, room.maxPlayers);
  const mode = msg.roomMode || msg.teamMode || roomMode(maxPlayers);
  const stage = String(msg.stage || msg.stageId || room.selectedStage || "classroom").trim();
  const rules = msg.rules || msg.matchRules || room.rules || {};

  const payload = {
    ...msg,
    type: "startMatch",
    matchId: msg.matchId || `${room.code}-${Date.now()}`,
    roomCode: room.code,
    code: room.code,
    playerId: client.playerId,
    role: client.role,
    playerNumber: Number(msg.playerNumber || client.playerNumber || 1),
    maxPlayers,
    roomMode: mode,
    teamMode: mode,
    stage,
    stageId: stage,
    rules,
    matchRules: rules,
    currentRound: Number(msg.currentRound || 1),
    p1RoundWins: Number(msg.p1RoundWins || 0),
    p2RoundWins: Number(msg.p2RoundWins || 0),
    p1Id: msg.p1Id || room.selectedCharacters[1] || null,
    p2Id: msg.p2Id || room.selectedCharacters[2] || null,
    p3Id: msg.p3Id || room.selectedCharacters[3] || null,
    p4Id: msg.p4Id || room.selectedCharacters[4] || null,
    selectedCharacters: { ...room.selectedCharacters },
    roster: roster(room),
    startMatch: true,
    start: true,
    syncVersion: msg.syncVersion || "server-1.1.0"
  };

  room.selectedStage = stage;
  room.rules = rules;
  room.maxPlayers = maxPlayers;
  room.roomMode = mode;
  room.lastStartMatch = payload;
  room.updatedAt = nowIso();

  broadcast(room, payload);
}

function relayToOthers(ws, msg = {}) {
  const room = requireRoom(ws); if (!room) return;
  const client = ws.__jfcClient;
  broadcast(room, { ...msg, playerId: client.playerId, role: client.role, playerNumber: msg.playerNumber || client.playerNumber }, { exclude: ws });
}

function leaveRoom(ws) {
  const client = ws.__jfcClient;
  if (!client || !client.roomCode) return;
  const room = rooms.get(client.roomCode);
  if (!room) return;
  const left = { playerId: client.playerId, role: client.role, playerNumber: client.playerNumber };
  room.clients.delete(ws);
  client.roomCode = null;
  client.role = null;
  client.playerNumber = 0;
  if (!room.clients.size) {
    rooms.delete(room.code);
    return;
  }
  if (room.hostId === left.playerId) {
    const first = Array.from(room.clients.values()).sort((a, b) => a.playerNumber - b.playerNumber)[0];
    if (first) { room.hostId = first.playerId; first.role = "host"; }
  }
  broadcast(room, { type: "playerLeft", ...left, roster: roster(room) });
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify({
    ok: true,
    service: "Job Fighters Online Server",
    version: "1.1.0",
    rooms: rooms.size,
    startMatchProtocol: true,
    time: nowIso()
  }, null, 2));
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  const client = {
    playerId: makePlayerId(),
    roomCode: null,
    role: null,
    playerNumber: 0
  };
  ws.__jfcClient = client;
  send(ws, { type: "connected", playerId: client.playerId, message: "Connected to Job Fighters Online Server", version: "1.1.0" });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch (_) { return send(ws, { type: "roomError", message: "Invalid JSON." }); }
    const type = msg.type;
    try {
      if (type === "ping") return send(ws, { type: "pong", t: msg.t || Date.now(), time: nowIso() });
      if (type === "createRoom") return createRoom(ws, msg);
      if (type === "joinRoom") return joinRoom(ws, msg);
      if (type === "setRules" || type === "rules") return setRules(ws, msg);
      if (type === "selectCharacter" || type === "pick") return selectCharacter(ws, msg);
      if (type === "selectStage") return selectStage(ws, msg);
      if (type === "playerReady" || type === "ready") return playerReady(ws, msg);
      if (type === "startMatch" || type === "start" || type === "matchStart" || type === "beginMatch") return startMatch(ws, msg);
      if (["input", "state", "pause", "resume", "roundResult", "returnSelect", "backMenu", "claimSlot"].includes(type)) return relayToOthers(ws, msg);
      return send(ws, { type: "roomError", message: `Unknown message type: ${type}` });
    } catch (err) {
      console.error("message handler error", err);
      send(ws, { type: "roomError", message: "Server error while handling message." });
    }
  });

  ws.on("close", () => leaveRoom(ws));
  ws.on("error", () => leaveRoom(ws));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Job Fighters Online Server v1.1.0 running on port ${PORT}`);
});
