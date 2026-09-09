/**
 * Chicken Run — server
 * Express static host + Socket.io room / match state manager for private 1v1
 * head-to-head matches joined by room code.
 *
 * Design notes:
 *  - The world is generated CLIENT-side from a shared seed the server hands out,
 *    so both players hop through an identical map without streaming any terrain.
 *  - Obstacle positions are pure functions of match time, so a clock handshake
 *    ("tsync") is all that's needed to keep both clients' traffic in lockstep.
 *  - Players never physically interact. There is no cross-player collision:
 *    each runs their own copy of the same layout, and the rival is drawn purely
 *    as a translucent ghost.
 *  - Scoring is pending-vs-banked. A run resolves exactly once, either by
 *    CASHOUT (pending is banked) or DEATH (banked is zero). The server is the
 *    authority on that resolution and on the match result.
 *  - No stakes, entry fees, or wagering of any kind — this is a private
 *    for-bragging-rights scoreboard between two people.
 */
'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 10000,
  pingTimeout: 20000,
  maxHttpBufferSize: 1e5
});

// maxAge 0 + etag => cheap 304s on revalidation, and no stale client after a
// deploy (the asset filenames are unversioned, so caching them would sting).
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: 0,
  etag: true,
  lastModified: true
}));

// The Netlify-hosted client pings this cross-origin to wake a sleeping Render
// dyno before the player taps CREATE, so allow it explicitly.
app.get('/health', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, rooms: rooms.size, sockets: io.engine.clientsCount });
});

/* ------------------------------------------------------------------ */
/* Room registry                                                       */
/* ------------------------------------------------------------------ */

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O — unambiguous on small screens
const COUNTDOWN_MS = 3500;
const ROOM_TTL_MS = 30 * 60 * 1000;

/** @type {Map<string, object>} */
const rooms = new Map();
/** @type {Map<string, string>} socket.id -> room code */
const socketRoom = new Map();

function makeCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += CODE_ALPHABET[(Math.random() * CODE_ALPHABET.length) | 0];
  } while (rooms.has(code));
  return code;
}

function makeSeed() {
  return (
    Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6)
  ).toUpperCase();
}

function sanitizeName(n) {
  if (typeof n !== 'string') return '';
  return n.replace(/[^\w \-]/g, '').trim().slice(0, 12).toUpperCase();
}

// Cosmetic only — never touches gameplay — but still whitelisted server-side
// since it comes straight off the wire from the other player's client.
const SPECIES = ['chicken', 'duck', 'pig', 'manatee'];
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function sanitizeSpecies(s) {
  return SPECIES.includes(s) ? s : 'chicken';
}

function sanitizeColor(c) {
  return typeof c === 'string' && HEX_COLOR.test(c) ? c : '#ffffff';
}

function newPlayer(socket, slot, name, species, bodyColor) {
  return {
    id: socket.id,
    slot,                       // 0 = host, 1 = challenger (drives avatar colour)
    name: sanitizeName(name) || (slot === 0 ? 'PLAYER 1' : 'PLAYER 2'),
    species: sanitizeSpecies(species),
    bodyColor: sanitizeColor(bodyColor),
    x: 0,
    y: 0,
    pending: 0,                 // live, at-risk score
    banked: 0,                  // locked-in score; stays 0 if they die
    status: 'running',          // running | banked | dead
    connected: true,
    wantsRematch: false
  };
}

function createRoom(socket, name, species, bodyColor) {
  const code = makeCode();
  const room = {
    code,
    seed: makeSeed(),
    state: 'lobby',            // lobby | countdown | playing | ended
    startAt: 0,
    createdAt: Date.now(),
    touchedAt: Date.now(),
    players: [newPlayer(socket, 0, name, species, bodyColor)]
  };
  rooms.set(code, room);
  socketRoom.set(socket.id, code);
  socket.join(code);
  return room;
}

function roomOf(socket) {
  const code = socketRoom.get(socket.id);
  return code ? rooms.get(code) : null;
}

function playerIn(room, id) {
  return room ? room.players.find((p) => p.id === id) : null;
}

function opponentIn(room, id) {
  return room ? room.players.find((p) => p.id !== id) : null;
}

function lobbyView(room) {
  return {
    code: room.code,
    state: room.state,
    players: room.players.map((p) => ({
      id: p.id, slot: p.slot, name: p.name, connected: p.connected
    }))
  };
}

function pushLobby(room) {
  room.touchedAt = Date.now();
  io.to(room.code).emit('room', lobbyView(room));
}

function clampNum(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(hi, Math.max(lo, n));
}

/* ------------------------------------------------------------------ */
/* Match lifecycle                                                     */
/* ------------------------------------------------------------------ */

function startMatch(room) {
  if (room.players.length < 2) return;
  room.seed = makeSeed();
  room.state = 'countdown';
  room.startAt = Date.now() + COUNTDOWN_MS;
  room.touchedAt = Date.now();

  for (const p of room.players) {
    p.x = 0; p.y = 0;
    p.pending = 0; p.banked = 0;
    p.status = 'running';
    p.wantsRematch = false;
  }

  for (const p of room.players) {
    const opp = opponentIn(room, p.id);
    io.to(p.id).emit('matchStart', {
      seed: room.seed,
      startAt: room.startAt,
      you: { slot: p.slot, name: p.name, species: p.species, bodyColor: p.bodyColor },
      opponent: opp ? { slot: opp.slot, name: opp.name, species: opp.species, bodyColor: opp.bodyColor } : null
    });
  }

  // Flip to "playing" the moment the gate opens so late joiners can't slip in.
  setTimeout(() => {
    if (rooms.get(room.code) === room && room.state === 'countdown') room.state = 'playing';
  }, COUNTDOWN_MS);
}

/** A match is over once both runs have resolved (banked or dead). */
function matchIsOver(room) {
  return room.players.every((p) => p.status !== 'running');
}

function endMatch(room, reason) {
  if (room.state === 'ended' || room.state === 'lobby') return;
  room.state = 'ended';
  room.touchedAt = Date.now();

  for (const p of room.players) {
    const opp = opponentIn(room, p.id);
    let result = 'draw';
    if (!opp || !opp.connected) {
      result = 'win';
    } else if (p.banked > opp.banked) {
      result = 'win';
    } else if (p.banked < opp.banked) {
      result = 'loss';
    }
    io.to(p.id).emit('matchEnd', {
      reason,
      result,
      you: {
        name: p.name, slot: p.slot, banked: p.banked, status: p.status,
        species: p.species, bodyColor: p.bodyColor
      },
      opponent: opp
        ? {
            name: opp.name, slot: opp.slot, banked: opp.banked,
            status: opp.status, connected: opp.connected,
            species: opp.species, bodyColor: opp.bodyColor
          }
        : null
    });
  }
}

/* ------------------------------------------------------------------ */
/* Socket wiring                                                       */
/* ------------------------------------------------------------------ */

io.on('connection', (socket) => {
  // Clock handshake — clients average a few of these to align match time.
  socket.on('tsync', (t0) => {
    socket.emit('tsync', { t0: Number(t0) || 0, server: Date.now() });
  });

  socket.on('createMatch', (payload, ack) => {
    if (roomOf(socket)) leaveRoom(socket);
    const room = createRoom(socket, payload && payload.name, payload && payload.species, payload && payload.bodyColor);
    if (typeof ack === 'function') ack({ ok: true, code: room.code, slot: 0 });
    pushLobby(room);
  });

  socket.on('joinMatch', (payload, ack) => {
    const code = String((payload && payload.code) || '')
      .toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
    const room = rooms.get(code);
    const reply = (o) => { if (typeof ack === 'function') ack(o); };

    if (!room) return reply({ ok: false, error: 'NO MATCH WITH THAT CODE' });
    if (room.players.length >= 2) return reply({ ok: false, error: 'THAT MATCH IS FULL' });
    if (room.state !== 'lobby' && room.state !== 'ended') {
      return reply({ ok: false, error: 'MATCH ALREADY IN PROGRESS' });
    }

    if (roomOf(socket)) leaveRoom(socket);
    const player = newPlayer(socket, 1, payload && payload.name, payload && payload.species, payload && payload.bodyColor);
    room.players.push(player);
    socketRoom.set(socket.id, code);
    socket.join(code);

    reply({ ok: true, code: room.code, slot: 1 });
    pushLobby(room);
    startMatch(room);
  });

  // 20 Hz stream: tile x/y, live pending score, still-running flag.
  socket.on('state', (d) => {
    const room = roomOf(socket);
    if (!room || (room.state !== 'playing' && room.state !== 'countdown')) return;
    const me = playerIn(room, socket.id);
    if (!me || !d) return;

    me.x = clampNum(d.x, -32, 32);
    me.y = clampNum(d.y, -32, 100000);
    me.pending = clampNum(d.p, 0, 10000000) | 0;
    room.touchedAt = Date.now();

    // NOTE: run status is deliberately NOT taken from this stream. The client
    // force-sends one last packet (a:0) immediately before it emits `died` or
    // `cashout`, so trusting it here would flip the status first and make those
    // handlers' duplicate guards swallow the real resolution — ending the match
    // never. Lifecycle comes from `died`/`cashout` only; `a` is relay-only.
    const opp = opponentIn(room, socket.id);
    if (opp) {
      io.to(opp.id).emit('oppState', { x: me.x, y: me.y, p: me.pending, a: d.a ? 1 : 0 });
    }
  });

  // CASHOUT — the whole game. Locks pending into banked and ends that run.
  socket.on('cashout', (d) => {
    const room = roomOf(socket);
    if (!room || room.state !== 'playing') return;
    const me = playerIn(room, socket.id);
    if (!me || me.status !== 'running') return;

    if (d && typeof d.p === 'number') me.pending = clampNum(d.p, 0, 10000000) | 0;
    me.banked = me.pending;
    me.status = 'banked';

    const opp = opponentIn(room, socket.id);
    if (opp) io.to(opp.id).emit('oppCashout', { banked: me.banked });
    if (matchIsOver(room)) endMatch(room, 'both-resolved');
  });

  // DEATH — pending is forfeit. Nothing is ever auto-saved on death.
  socket.on('died', () => {
    const room = roomOf(socket);
    if (!room || room.state !== 'playing') return;
    const me = playerIn(room, socket.id);
    if (!me || me.status !== 'running') return;

    me.pending = 0;
    me.banked = 0;
    me.status = 'dead';

    const opp = opponentIn(room, socket.id);
    if (opp) io.to(opp.id).emit('oppDied', {});
    if (matchIsOver(room)) endMatch(room, 'both-resolved');
  });

  socket.on('rematch', () => {
    const room = roomOf(socket);
    if (!room || room.state !== 'ended') return;
    const me = playerIn(room, socket.id);
    if (!me) return;
    me.wantsRematch = true;

    const opp = opponentIn(room, socket.id);
    if (opp && opp.connected && opp.wantsRematch) {
      startMatch(room);
    } else if (opp && opp.connected) {
      io.to(opp.id).emit('rematchPending', { name: me.name });
    }
  });

  socket.on('leaveMatch', () => leaveRoom(socket));
  socket.on('disconnect', () => leaveRoom(socket, true));

  function leaveRoom(sock, disconnected) {
    const code = socketRoom.get(sock.id);
    if (!code) return;
    socketRoom.delete(sock.id);
    const room = rooms.get(code);
    sock.leave(code);
    if (!room) return;

    const idx = room.players.findIndex((p) => p.id === sock.id);
    if (idx === -1) return;
    room.players.splice(idx, 1);
    room.touchedAt = Date.now();

    if (room.players.length === 0) {
      rooms.delete(code);
      return;
    }

    io.to(code).emit('opponentLeft', { disconnected: !!disconnected });
    if (room.state === 'countdown' || room.state === 'playing') {
      endMatch(room, 'opponent-left');
    } else {
      room.state = 'lobby';
      // Promote the remaining player to host so the room code stays live.
      room.players[0].slot = 0;
      room.players[0].wantsRematch = false;
      pushLobby(room);
    }
  }
});

// Sweep abandoned rooms.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.players.length === 0 || now - room.touchedAt > ROOM_TTL_MS) rooms.delete(code);
  }
}, 60000).unref();

server.listen(PORT, () => {
  console.log('Chicken Run running at http://localhost:' + PORT);
});
