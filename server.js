/* PvP v3.15.0: server owns rooms; host owns combat simulation. */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');
const codec=require('./snapshot-codec.js');
const ROOT = __dirname, VERSION = '3.15.0', rooms = new Map();
const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'online/catalog.json')));
const characters = new Set(catalog.characters), stages = new Set(catalog.stages);
const origins = new Set((process.env.ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean));
const publicFiles = new Set(['index.html','style.css','game.js','net.js','mobile.js','online-ui.js','online-config.js','rtc-transport.js','snapshot-codec.js','manifest.webmanifest','job-fighters-classic-icon-512.png']);
const MIME = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.json':'application/json','.png':'image/png','.webp':'image/webp','.mp3':'audio/mpeg','.webmanifest':'application/manifest+json'};
const server = http.createServer((req, res) => {
  if (!['GET','HEAD'].includes(req.method)) { res.writeHead(405); return res.end(); }
  let clean;
  try { clean = decodeURIComponent(req.url.split('?')[0]); } catch (_) { res.writeHead(400); return res.end(); }
  if (clean === '/health') { res.writeHead(200, {'Content-Type':'application/json','Cache-Control':'no-store'}); return res.end(JSON.stringify({ok:true,version:VERSION,protocol:1,rooms:rooms.size})); }
  const relative = clean === '/' ? 'index.html' : clean.replace(/^\/+/, '');
  const file = path.resolve(ROOT, relative);
  if ((!publicFiles.has(relative) && !relative.startsWith('assets/')) || !file.startsWith(ROOT + path.sep)) { res.writeHead(404); return res.end('Not found'); }
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404); return res.end('Not found'); }
    const headers = {'Content-Type':MIME[path.extname(file)] || 'application/octet-stream','X-Content-Type-Options':'nosniff','Cache-Control':relative.startsWith('assets/') ? 'public, max-age=3600' : 'no-cache','Accept-Ranges':'bytes'};
    let start = 0, end = stat.size - 1, status = 200;
    if (req.headers.range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (!m || (!m[1] && !m[2])) { res.writeHead(416, {'Content-Range':`bytes */${stat.size}`}); return res.end(); }
      start = m[1] ? Number(m[1]) : Math.max(0, stat.size - Number(m[2]));
      end = m[1] && m[2] ? Math.min(Number(m[2]), end) : end;
      if (start > end || start >= stat.size) { res.writeHead(416, {'Content-Range':`bytes */${stat.size}`}); return res.end(); }
      status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
    }
    headers['Content-Length'] = end - start + 1; res.writeHead(status, headers);
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(file, {start,end});
    stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res);
  });
});
const wss = new WebSocketServer({server,perMessageDeflate:false,maxPayload:256 * 1024});
const open = ws => ws && ws.readyState === 1;
function send(ws, msg, volatile = false) {
  if (!open(ws)) return;
  if (ws.bufferedAmount > 1024 * 1024) return ws.close(1013, 'Connection too slow');
  if (volatile && ws.bufferedAmount > 128 * 1024) return;
  try { ws.send(JSON.stringify(msg)); } catch (_) { ws.terminate(); }
}
function broadcast(room, msg, except, volatile = false) { room.clients.forEach(c => { if (c !== except) send(c,msg,volatile); }); }
function roster(room) { return room.clients.filter(open).map(c => ({playerNumber:c.playerNumber,role:c.role,name:c.name,ready:!!room.ready[c.playerNumber],charId:room.picks[c.playerNumber] || ''})); }
function status(room) { broadcast(room,{type:'roomStatus',code:room.code,roster:roster(room),phase:room.phase,maxPlayers:room.maxPlayers,roomMode:room.mode,matchId:room.matchId}); }
function error(ws,message,code = 'ROOM_ERROR') { send(ws,{type:'roomError',code,message}); }
function detach(ws, reason = 'left') {
  const room = rooms.get(ws.roomCode); ws.roomCode = '';
  if (!room) return;
  room.clients = room.clients.filter(c => c !== ws);
  delete room.picks[ws.playerNumber]; delete room.ready[ws.playerNumber];
  if (ws.role === 'host') {
    rooms.delete(room.code);
    for (const c of room.clients) { c.roomCode = ''; send(c,{type:'roomClosed',reason:'Chủ phòng đã rời phòng. Hãy tạo hoặc vào phòng mới.'}); }
    return;
  }
  const aborted = ['playing','paused','result'].includes(room.phase);
  if (aborted) { room.phase = 'select'; room.matchId = ''; room.ready = {}; room.picks = {}; room.round = 0; }
  broadcast(room,{type:'peerLeft',playerNumber:ws.playerNumber,roster:roster(room),aborted,reason});
  if (aborted) broadcast(room,{type:'returnSelect',summary:'Trận đã dừng vì một người chơi rời phòng. Chờ đủ người rồi chọn lại nhân vật.',teamMode:room.mode});
  else broadcast(room,{type:'pick',player:ws.playerNumber,charId:''});
  status(room);
}
function makeCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let code;
  do { code = Array.from({length:6},() => alphabet[crypto.randomInt(alphabet.length)]).join(''); } while (rooms.has(code));
  return code;
}
function validRules(r) { return r && [0,60,90,99,120].includes(Number(r.timeLimit)) && [1,3,5,7,10].includes(Number(r.healthBars)) && [1,3,5].includes(Number(r.roundLimit)); }
function iceServers() {
  const urls = (process.env.TURN_URLS || '').split(',').map(v => v.trim()).filter(Boolean);
  if (!urls.length || !process.env.TURN_SECRET) return null;
  const username = `${Math.floor(Date.now()/1000)+3600}:${crypto.randomUUID()}`;
  const credential = crypto.createHmac('sha1',process.env.TURN_SECRET).update(username).digest('base64');
  return [{urls:'stun:stun.l.google.com:19302'}, {urls,username,credential}];
}
const inputKeys = ['left','right','crouch','high','jump','block','blockPress','punch','kick','special','throw','dash'];
function handle(ws,msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.type !== 'string') return error(ws,'Gói tin không hợp lệ.');
  const aliases = {setRules:'rules',selectCharacter:'pick',startMatch:'start',selectStage:'stage',playerReady:'ready'};
  const type = aliases[msg.type] || msg.type;
  if (type === 'ping') return send(ws,{type:'pong',t:Number(msg.t) || 0});
  if (type === 'leaveRoom') { detach(ws); ws.role = null; return send(ws,{type:'roomLeft'}); }
  if (type === 'createRoom') {
    if (rooms.size >= Number(process.env.MAX_ROOMS || 200)) return error(ws,'Server đang đầy phòng. Thử lại sau.');
    detach(ws);
    const code = makeCode(), maxPlayers = Number(msg.maxPlayers) === 4 ? 4 : 2;
    ws.name = String(msg.name || 'Người chơi 1').replace(/[\x00-\x1f<>]/g,'').trim().slice(0,24) || 'Người chơi 1';
    ws.role = 'host'; ws.playerNumber = 1; ws.roomCode = code;
    const room = {code,clients:[ws],maxPlayers,mode:maxPlayers === 4 ? '2v2' : '1v1',phase:'waiting',picks:{},ready:{},rules:null,stage:'classroom',matchId:'',lastActive:Date.now(),lastStateRelay:0,round:0};
    rooms.set(code,room);
    send(ws,{type:'roomCreated',code,role:'host',playerNumber:1,maxPlayers,roomMode:room.mode,roster:roster(room)}); return status(room);
  }
  if (type === 'joinRoom') {
    const code = String(msg.roomCode || msg.code || '').trim().toUpperCase();
    if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/.test(code)) return error(ws,'Mã phòng cần 6 ký tự.');
    const room = rooms.get(code);
    if (!room) return error(ws,'Không tìm thấy phòng.');
    if (['playing','paused','result'].includes(room.phase)) return error(ws,'Phòng đang thi đấu. Hãy chờ trận kết thúc.');
    if (ws.roomCode === code) return error(ws,'Bạn đã ở trong phòng này.');
    const used = new Set(room.clients.map(c => c.playerNumber));
    const slot = Array.from({length:room.maxPlayers},(_,i) => i+1).find(i => !used.has(i));
    if (!slot) return error(ws,`Phòng đã đủ ${room.maxPlayers} người.`);
    detach(ws); ws.role = 'guest'; ws.playerNumber = slot; ws.roomCode = code;
    ws.name = String(msg.name || `Người chơi ${slot}`).replace(/[\x00-\x1f<>]/g,'').trim().slice(0,24) || `Người chơi ${slot}`;
    room.clients.push(ws);
    send(ws,{type:'joined',code,role:'guest',playerNumber:slot,maxPlayers:room.maxPlayers,roomMode:room.mode,roster:roster(room)});
    broadcast(room,{type:'peerJoined',playerNumber:slot,count:room.clients.length,roster:roster(room),maxPlayers:room.maxPlayers,roomMode:room.mode},ws);
    if (room.rules) send(ws,{type:'rules',rules:room.rules});
    Object.entries(room.picks).forEach(([player,charId]) => send(ws,{type:'pick',player:Number(player),charId})); return status(room);
  }
  const room = rooms.get(ws.roomCode);
  if (!room) return error(ws,'Bạn chưa ở trong phòng.');
  room.lastActive = Date.now();
  if (['rules','stage','start','state','roundResult','matchEnded','returnSelect'].includes(type) && ws.role !== 'host') return error(ws,'Chỉ chủ phòng được thực hiện thao tác này.','HOST_ONLY');
  if (type === 'rtcSignal') {
    const target = room.clients.find(c => c.playerNumber === Number(msg.target));
    if (!target || target === ws || (ws.playerNumber !== 1 && target.playerNumber !== 1)) return error(ws,'Tín hiệu kết nối không hợp lệ.');
    if (typeof msg.id !== 'string' || msg.id.length > 80) return;
    if (msg.description && (typeof msg.description.sdp !== 'string' || msg.description.sdp.length > 32000 || !['offer','answer'].includes(msg.description.type))) return;
    if (msg.candidate && (typeof msg.candidate.candidate !== 'string' || msg.candidate.candidate.length > 3000)) return;
    return send(target,{type:'rtcSignal',from:ws.playerNumber,id:msg.id,description:msg.description,candidate:msg.candidate});
  }
  if (type === 'rules') {
    if (!['waiting','select'].includes(room.phase)) return error(ws,'Không thể đổi luật trong trận.');
    const r = msg.rules || msg.matchRules;
    if (!validRules(r)) return error(ws,'Luật trận không hợp lệ.');
    room.rules = {timeLimit:Number(r.timeLimit),healthBars:Number(r.healthBars),roundLimit:Number(r.roundLimit),teamMode:room.mode};
    room.phase = 'select'; room.picks = {}; room.ready = {}; room.round = 0; room.matchId = '';
    broadcast(room,{type:'rules',rules:room.rules},ws); return status(room);
  }
  if (type === 'pick') {
    if (room.phase !== 'select') return error(ws,'Hãy xác nhận luật trước khi chọn nhân vật.');
    const player = Number(msg.playerNumber || msg.player || ws.playerNumber);
    if (player !== ws.playerNumber) return error(ws,'Bạn chỉ được chọn nhân vật cho mình.');
    const id = String(msg.characterId ?? msg.charId ?? '');
    if (id && !characters.has(id)) return error(ws,'Nhân vật không tồn tại.');
    if (id) room.picks[player] = id; else delete room.picks[player]; room.ready[player] = false;
    broadcast(room,{type:'pick',player,charId:id}); return status(room);
  }
  if (type === 'ready') {
    if (room.phase !== 'select' || !room.picks[ws.playerNumber]) return error(ws,'Chọn nhân vật trước khi sẵn sàng.');
    room.ready[ws.playerNumber] = msg.ready !== false; return status(room);
  }
  if (type === 'claimSlot') {
    const slot = Number(msg.slot);
    if (room.mode !== '2v2' || !['waiting','select'].includes(room.phase) || ![2,3,4].includes(slot) || ws.role === 'host') return error(ws,'Không thể đổi slot này.');
    if (room.clients.some(c => c !== ws && c.playerNumber === slot)) return error(ws,'Slot đã có người.');
    const previous = ws.playerNumber; delete room.picks[previous]; delete room.ready[previous]; ws.playerNumber = slot;
    send(ws,{type:'slotAssigned',playerNumber:slot,role:'guest',roster:roster(room)});
    broadcast(room,{type:'pick',player:previous,charId:''}); return status(room);
  }
  if (type === 'stage') {
    if (room.phase !== 'select' || !stages.has(String(msg.stageId || msg.stage))) return error(ws,'Không thể chọn sân đấu này.');
    room.stage = String(msg.stageId || msg.stage); return broadcast(room,{type:'stageSelected',stageId:room.stage});
  }
  if (type === 'start') {
    const nextRound = Number(msg.currentRound || 1);
    const continuation = room.phase === 'result' && !room.final && nextRound === room.round + 1;
    if (room.phase !== 'select' && !continuation) return error(ws,'Trận chưa thể bắt đầu.');
    if (!room.rules || room.clients.length !== room.maxPlayers || !room.clients.every(c => room.picks[c.playerNumber] && room.ready[c.playerNumber])) return error(ws,'Cần đủ người, chọn nhân vật và tất cả cùng sẵn sàng.');
    if ((!continuation && nextRound !== 1) || nextRound > room.rules.roundLimit) return error(ws,'Số hiệp không hợp lệ.');
    const stage = String(msg.stageId || msg.stage || room.stage);
    if (!stages.has(stage)) return error(ws,'Sân đấu không hợp lệ.');
    room.phase = 'playing'; room.stage = stage; room.round = nextRound; room.matchId = `${room.code}-${crypto.randomUUID()}`; room.final = false; room.lastStateRelay = 0;
    room.clients.forEach(c => { c.lastInputFrame = 0; });
    const payload = {type:'startMatch',matchId:room.matchId,stage,stageId:stage,rules:room.rules,currentRound:nextRound,p1RoundWins:continuation ? room.scores[0] : 0,p2RoundWins:continuation ? room.scores[1] : 0,maxPlayers:room.maxPlayers,teamMode:room.mode,selectedCharacters:room.picks};
    for (let i = 1; i <= room.maxPlayers; i++) payload[`p${i}Id`] = room.picks[i];
    broadcast(room,payload); return status(room);
  }
  if (type === 'input') {
    if (room.phase !== 'playing' || msg.matchId !== room.matchId || !msg.input || typeof msg.input !== 'object') return;
    const frame = Number(msg.frame);
    if (!Number.isSafeInteger(frame) || frame <= (ws.lastInputFrame || 0)) return;
    ws.lastInputFrame = frame;
    const input = {}; inputKeys.forEach(k => { input[k] = msg.input[k] === true; });
    input.dashDir = [-1,1].includes(Number(msg.input.dashDir)) ? Number(msg.input.dashDir) : 0;
    const actions = Array.isArray(msg.actions) ? msg.actions.slice(-8).filter(a => a && Number.isSafeInteger(a.id) && a.id > 0 && ['jump','punch','kick','special','throw','blockPress','dash'].includes(a.key)).map(a => ({id:a.id,key:a.key,dashDir:Math.sign(Number(a.dashDir)||0)})) : [];
    return broadcast(room,{type:'input',player:ws.playerNumber,input,actions,frame,matchId:room.matchId},ws);
  }
  if (type === 'state') {
    if (!['playing','result'].includes(room.phase) || msg.matchId !== room.matchId) return;
    const wireSnapshot = msg.snapshot || msg.state;
    let snapshot;try{snapshot=msg.packed?codec.unpack(wireSnapshot):wireSnapshot;}catch(_){return;}
    if (!snapshot || typeof snapshot !== 'object' || !snapshot.p1 || !snapshot.p2 || (room.maxPlayers === 4 && (!snapshot.p3 || !snapshot.p4))) return;
    if (!['fight','fightIntro','roundOver','gameOver'].includes(snapshot.state)) return;
    const now = Date.now(); if (now - room.lastStateRelay < 15) return; room.lastStateRelay = now;
    const packet={type:'state',snapshot:wireSnapshot,packed:!!msg.packed,frame:Number(msg.frame) || 0,matchId:room.matchId};
    if (Array.isArray(msg.targets)) for(const c of room.clients) { if(c!==ws && msg.targets.includes(c.playerNumber))send(c,packet,true); }
    else broadcast(room,packet,ws,true);
  }
  if (type === 'pause' || type === 'resume') {
    if (msg.matchId !== room.matchId) return;
    if (type === 'pause' && room.phase === 'playing') room.phase = 'paused';
    else if (type === 'resume' && room.phase === 'paused' && room.clients.length === room.maxPlayers) room.phase = 'playing';
    else return;
    broadcast(room,{type},ws); return status(room);
  }
  if (type === 'roundResult' || type === 'matchEnded') {
    if (room.phase !== 'playing' || msg.matchId !== room.matchId || Number(msg.currentRound) !== room.round) return;
    if (!['Draw','Player 1','Player 2','Đội Xanh','Đội Đỏ'].includes(msg.winner)) return error(ws,'Kết quả không hợp lệ.');
    room.phase = 'result'; room.scores = [Number(msg.p1RoundWins) || 0,Number(msg.p2RoundWins) || 0];
    const need = Math.floor(room.rules.roundLimit / 2) + 1; room.final = room.round >= room.rules.roundLimit || room.scores.some(n => n >= need);
    broadcast(room,{type:'roundResult',winner:msg.winner,resultId:`${room.matchId}-result`,currentRound:room.round,p1RoundWins:room.scores[0],p2RoundWins:room.scores[1],final:room.final},ws); return status(room);
  }
  if (type === 'returnSelect') {
    room.phase = 'select'; room.picks = {}; room.ready = {}; room.matchId = ''; room.round = 0;
    broadcast(room,{type:'returnSelect',summary:String(msg.summary || 'Chọn nhân vật cho trận tiếp theo.').slice(0,240),teamMode:room.mode},ws); return status(room);
  }
  if (type === 'backMenu') return detach(ws);
  error(ws,`Thao tác online không được hỗ trợ: ${type}.`);
}
 wss.on('connection',(ws,req) => {
  if (wss.clients.size > Number(process.env.MAX_CLIENTS || 800) || (origins.size && !origins.has(req.headers.origin))) return ws.close(1008,'Server policy');
  ws.roomCode = ''; ws.isAlive = true; ws.tokens = 240; ws.tokenTime = Date.now();
  send(ws,{type:'connected',protocol:1,version:VERSION,playerId:crypto.randomUUID(),iceServers:iceServers()});
  ws.on('message',(raw,binary) => {
    const now = Date.now(); ws.tokens = Math.min(240,ws.tokens + (now-ws.tokenTime)*0.18); ws.tokenTime = now;
    if (--ws.tokens < 0) return ws.close(1008,'Rate limit');
    if (binary) return error(ws,'Chỉ hỗ trợ JSON.');
    let msg; try { msg = JSON.parse(raw.toString()); } catch (_) { return error(ws,'JSON không hợp lệ.'); }
    try { handle(ws,msg); } catch (err) { console.error('Protocol failure:',err.message); error(ws,'Không xử lý được yêu cầu.'); }
  });
  ws.on('pong',() => { ws.isAlive = true; });
  ws.on('close',() => detach(ws,'disconnected')); ws.on('error',() => detach(ws,'disconnected'));
});
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); }
  for (const room of rooms.values()) if (['waiting','select'].includes(room.phase) && Date.now()-room.lastActive > 30*60*1000) {
    for (const ws of room.clients) { send(ws,{type:'roomClosed',reason:'Phòng đã hết thời gian chờ.'}); ws.roomCode = ''; } rooms.delete(room.code);
  }
},15000);
function stop() { clearInterval(heartbeat); for (const ws of wss.clients) ws.terminate(); wss.close(); server.close(); }
process.on('SIGTERM',stop); process.on('SIGINT',stop);
server.listen(Number(process.env.PORT || 3000),'0.0.0.0',() => console.log(`Job Fighters PvP ${VERSION}: http://localhost:${server.address().port}`));
