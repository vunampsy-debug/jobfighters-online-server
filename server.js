const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;
const rooms = new Map();

function makePlayerId() {
  return "p_" + Math.random().toString(36).slice(2, 10);
}

function makeRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function send(ws, type, payload = {}) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, ...payload }));
  }
}

function broadcast(room, type, payload = {}, exceptWs = null) {
  for (const player of Object.values(room.players)) {
    if (player.ws !== exceptWs) {
      send(player.ws, type, payload);
    }
  }
}

function getRoom(ws) {
  if (!ws.roomCode) return null;
  return rooms.get(ws.roomCode) || null;
}

function cleanupRoom(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  const hasHost = !!room.players.host;
  const hasGuest = !!room.players.guest;

  if (!hasHost && !hasGuest) {
    rooms.delete(roomCode);
  }
}

const server = http.createServer((req, res) => {
  const data = {
    ok: true,
    service: "Job Fighters Online Server",
    rooms: rooms.size,
    time: new Date().toISOString()
  };

  res.writeHead(200, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*"
  });

  res.end(JSON.stringify(data));
});

const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
  ws.id = makePlayerId();
  ws.roomCode = null;
  ws.role = null;

  send(ws, "connected", {
    playerId: ws.id,
    message: "Connected to Job Fighters Online Server"
  });

  ws.on("message", (raw) => {
    let msg;

    try {
      msg = JSON.parse(raw.toString());
    } catch {
      send(ws, "roomError", { message: "Invalid JSON message." });
      return;
    }

    if (msg.type === "ping") {
      send(ws, "pong", {
        t: msg.t,
        serverTime: Date.now()
      });
      return;
    }

    if (msg.type === "createRoom") {
      let roomCode;

      do {
        roomCode = makeRoomCode();
      } while (rooms.has(roomCode));

      const room = {
        code: roomCode,
        hostId: ws.id,
        guestId: null,
        players: {
          host: {
            id: ws.id,
            role: "host",
            ws
          }
        },
        status: "waiting",
        rules: null,
        selectedStage: null,
        selectedCharacters: {},
        ready: {
          host: false,
          guest: false
        },
        createdAt: Date.now()
      };

      rooms.set(roomCode, room);

      ws.roomCode = roomCode;
      ws.role = "host";

      send(ws, "roomCreated", {
        roomCode,
        playerId: ws.id,
        role: "host"
      });

      return;
    }

    if (msg.type === "joinRoom") {
      const roomCode = String(msg.roomCode || "").trim().toUpperCase();
      const room = rooms.get(roomCode);

      if (!room) {
        send(ws, "roomError", { message: "Không tìm thấy phòng." });
        return;
      }

      if (room.players.guest) {
        send(ws, "roomError", { message: "Phòng đã đủ 2 người." });
        return;
      }

      room.guestId = ws.id;
      room.players.guest = {
        id: ws.id,
        role: "guest",
        ws
      };
      room.status = "ready";

      ws.roomCode = roomCode;
      ws.role = "guest";

      send(ws, "roomJoined", {
        roomCode,
        playerId: ws.id,
        role: "guest"
      });

      broadcast(room, "playerJoined", {
        roomCode,
        guestId: ws.id
      });

      return;
    }

    const room = getRoom(ws);

    if (!room) {
      send(ws, "roomError", { message: "Bạn chưa ở trong phòng." });
      return;
    }

    if (msg.type === "setRules") {
      if (ws.role !== "host") return;

      room.rules = msg.rules || null;

      broadcast(room, "rulesUpdated", {
        rules: room.rules
      });

      return;
    }

    if (msg.type === "selectCharacter") {
      room.selectedCharacters[ws.role] = msg.characterId;

      broadcast(room, "characterSelected", {
        role: ws.role,
        characterId: msg.characterId
      });

      return;
    }

    if (msg.type === "selectStage") {
      if (ws.role !== "host") return;

      room.selectedStage = msg.stageId;

      broadcast(room, "stageSelected", {
        stageId: room.selectedStage
      });

      return;
    }

    if (msg.type === "playerReady") {
      room.ready[ws.role] = true;

      broadcast(room, "readyUpdated", {
        ready: room.ready
      });

      if (
        room.ready.host &&
        room.ready.guest &&
        room.selectedCharacters.host &&
        room.selectedCharacters.guest &&
        room.selectedStage
      ) {
        room.status = "playing";

        broadcast(room, "startMatch", {
          rules: room.rules,
          selectedStage: room.selectedStage,
          selectedCharacters: room.selectedCharacters
        });
      }

      return;
    }

    if (msg.type === "input") {
      broadcast(
        room,
        "remoteInput",
        {
          role: ws.role,
          frame: msg.frame,
          input: msg.input
        },
        ws
      );

      return;
    }

    if (msg.type === "state") {
      if (ws.role !== "host") return;

      broadcast(
        room,
        "hostState",
        {
          frame: msg.frame,
          state: msg.state
        },
        ws
      );

      return;
    }

    if (msg.type === "leaveRoom") {
      const roomCode = ws.roomCode;
      const role = ws.role;

      if (room && role && room.players[role]) {
        delete room.players[role];
        broadcast(room, "playerLeft", { role });
      }

      ws.roomCode = null;
      ws.role = null;

      cleanupRoom(roomCode);
      send(ws, "leftRoom");

      return;
    }

    send(ws, "roomError", {
      message: `Unknown message type: ${msg.type}`
    });
  });

  ws.on("close", () => {
    const roomCode = ws.roomCode;
    const role = ws.role;
    const room = rooms.get(roomCode);

    if (!room || !role) return;

    if (room.players[role]) {
      delete room.players[role];
      broadcast(room, "playerLeft", { role });
    }

    cleanupRoom(roomCode);
  });
});

server.listen(PORT, () => {
  console.log(`Job Fighters Online Server running on port ${PORT}`);
});