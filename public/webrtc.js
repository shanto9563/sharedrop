/* ═══════════════════════════════════════════════════════════════════════
   webrtc.js — ShareDrop P2P engine
   ● All file bytes travel exclusively through RTCDataChannel (peer-to-peer)
   ● Server is never involved in file data — only SDP/ICE signalling
   ● Protocol: JSON control messages (strings) + binary chunks (ArrayBuffer)
═══════════════════════════════════════════════════════════════════════ */

'use strict';

/* ── ICE / STUN / TURN configuration ─────────────────────────────────── */
const ICE_CONFIG = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] },
    { urls: 'stun:stun.cloudflare.com:3478' },
    /* Public TURN fallback – handles symmetric NAT.
       Replace with your own TURN credentials for production. */
    { urls: 'turn:openrelay.metered.ca:80',              username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443',             username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
  ]
};

/* ── Constants ────────────────────────────────────────────────────────── */
const CHUNK_SIZE  = 64 * 1024;       // 64 KB — good balance of throughput vs latency
const HIGH_WATER  = 4 * 1024 * 1024; // 4 MB  — pause sending when DC buffer exceeds this
const LOW_WATER   = 512 * 1024;      // 512 KB — resume when DC buffer drains below this

/* ── Tiny EventEmitter ────────────────────────────────────────────────── */
class Emitter {
  constructor() { this._h = new Map(); }
  on(e, fn)  { (this._h.get(e) || (this._h.set(e,[]) && this._h.get(e))).push(fn); return this; }
  off(e, fn) { const a = this._h.get(e); if (a) { const i = a.indexOf(fn); if (i>-1) a.splice(i,1); } }
  emit(e, d) { (this._h.get(e)||[]).slice().forEach(fn => { try{ fn(d); }catch(err){ console.error(err); } }); }
}

/* ═══════════════════════════════════════════════════════════════════════
   FileTransferManager
   Manages outgoing + incoming file transfer state machines.
   Communicates via DataChannel messages injected by PeerManager.
═══════════════════════════════════════════════════════════════════════ */
class FileTransferManager extends Emitter {
  constructor() {
    super();
    /* Injected by PeerManager */
    this._rawSend = null; // (peerId, string|ArrayBuffer) → void
    this._getDC   = null; // (peerId) → RTCDataChannel | null

    /* Outgoing: transferId → { id, files, meta, cancelled, peers: Map<peerId,{cancelled}> } */
    this.outgoing = new Map();

    /* Pending offers waiting for user accept/reject: `${peerId}:${tid}` → offerInfo */
    this.pending  = new Map();

    /* Active receive state per peer: peerId → rxState */
    this.rxState  = new Map();
  }

  /* ──────────────────────────────────────────────────────────────────
     Dispatch incoming DataChannel messages from PeerManager
  ────────────────────────────────────────────────────────────────── */
  handleMessage(peerId, data) {
    if (typeof data === 'string') {
      let msg; try { msg = JSON.parse(data); } catch { return; }
      this._ctrl(peerId, msg);
    } else if (data instanceof ArrayBuffer) {
      this._chunk(peerId, data);
    }
  }

  /* ──────────────────────────────────────────────────────────────────
     OUTGOING — send files to one or more peers
  ────────────────────────────────────────────────────────────────── */
  sendFiles(files, peerIds, fromNickname) {
    const tid = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);

    const meta = files.map(f => ({
      name:         f.name,
      size:         f.size,
      mimeType:     f.type || 'application/octet-stream',
      relativePath: f.relativePath || f.name
    }));

    const totalSize = meta.reduce((s, f) => s + f.size, 0);

    this.outgoing.set(tid, {
      id: tid, files, meta, cancelled: false,
      peers: new Map()   // filled as peers accept
    });

    peerIds.forEach(pid => {
      this._rawSend(pid, JSON.stringify({
        type: 'transfer-request', transferId: tid,
        files: meta, from: fromNickname
      }));
    });

    this.emit('outgoing-created', { transferId: tid, meta, totalSize, peerIds });
    return tid;
  }

  cancelOutgoing(tid) {
    const t = this.outgoing.get(tid);
    if (!t) return;
    t.cancelled = true;
    t.peers.forEach((_, pid) =>
      this._rawSend(pid, JSON.stringify({ type: 'transfer-cancel', transferId: tid }))
    );
    this.emit('outgoing-cancelled', { transferId: tid });
  }

  /* ──────────────────────────────────────────────────────────────────
     INCOMING — accept / reject offers
  ────────────────────────────────────────────────────────────────── */
  acceptOffer(peerId, tid) {
    this._rawSend(peerId, JSON.stringify({ type: 'transfer-response', transferId: tid, accepted: true }));
    this.rxState.set(peerId, {
      transferId: tid,
      currentFile: null, chunks: [], rxBytes: 0, totalRxBytes: 0,
      t0: Date.now(), speedT: Date.now(), speedB: 0, speed: 0,
      received: []
    });
    this.pending.delete(`${peerId}:${tid}`);
    this.emit('offer-accepted', { peerId, transferId: tid });
  }

  rejectOffer(peerId, tid) {
    this._rawSend(peerId, JSON.stringify({ type: 'transfer-response', transferId: tid, accepted: false }));
    this.pending.delete(`${peerId}:${tid}`);
    this.emit('offer-rejected', { peerId, transferId: tid });
  }

  cancelIncoming(peerId, tid) {
    this._rawSend(peerId, JSON.stringify({ type: 'transfer-cancel', transferId: tid }));
    this.rxState.delete(peerId);
    this.emit('incoming-cancelled', { peerId, transferId: tid });
  }

  /* ──────────────────────────────────────────────────────────────────
     Control message router
  ────────────────────────────────────────────────────────────────── */
  _ctrl(peerId, msg) {
    const dispatch = {
      'transfer-request':  () => this._onRequest (peerId, msg),
      'transfer-response': () => this._onResponse(peerId, msg),
      'file-start':        () => this._onFileStart(peerId, msg),
      'file-done':         () => this._onFileDone (peerId, msg),
      'transfer-complete': () => this._onComplete (peerId, msg),
      'transfer-cancel':   () => this._onCancel   (peerId, msg),
    };
    dispatch[msg.type]?.();
  }

  _onRequest(peerId, { transferId, files, from }) {
    const key = `${peerId}:${transferId}`;
    this.pending.set(key, { peerId, transferId, files, from });
    this.emit('transfer-offer', { peerId, transferId, files, from });
  }

  _onResponse(peerId, { transferId, accepted }) {
    const t = this.outgoing.get(transferId);
    if (!t || t.cancelled) return;
    if (accepted) {
      t.peers.set(peerId, { cancelled: false });
      this.emit('peer-accepted', { transferId, peerId });
      this._sendToPeer(t, peerId).catch(console.error);
    } else {
      this.emit('peer-rejected', { transferId, peerId });
    }
  }

  _onFileStart(peerId, { transferId, fileIndex, name, size, mimeType, relativePath, totalChunks }) {
    const s = this.rxState.get(peerId);
    if (!s || s.transferId !== transferId) return;
    s.currentFile = { fileIndex, name, size, mimeType, relativePath, totalChunks };
    s.chunks = []; s.rxBytes = 0;
    s.speedT = Date.now(); s.speedB = 0;
    this.emit('incoming-file-start', { peerId, transferId, fileIndex, name, size, mimeType, relativePath });
  }

  /* Binary chunk — appended to the current in-progress file for this peer */
  _chunk(peerId, buf) {
    const s = this.rxState.get(peerId);
    if (!s || !s.currentFile) return;
    s.chunks.push(buf);
    s.rxBytes       += buf.byteLength;
    s.totalRxBytes  += buf.byteLength;

    const now = Date.now(), dt = (now - s.speedT) / 1000;
    if (dt >= 0.4) {
      s.speed  = (s.rxBytes - s.speedB) / dt;
      s.speedT = now; s.speedB = s.rxBytes;
    }

    const { size, name, fileIndex } = s.currentFile;
    const progress = size > 0 ? s.rxBytes / size : 1;
    const eta      = s.speed > 0 ? Math.max(0, (size - s.rxBytes) / s.speed) : 0;
    this.emit('incoming-progress', {
      peerId, transferId: s.transferId, fileIndex, fileName: name,
      rxBytes: s.rxBytes, totalBytes: size, progress, speed: s.speed, eta
    });
  }

  _onFileDone(peerId, { transferId, fileIndex }) {
    const s = this.rxState.get(peerId);
    if (!s || s.transferId !== transferId || !s.currentFile) return;
    const { name, mimeType, relativePath } = s.currentFile;
    const blob = new Blob(s.chunks, { type: mimeType });
    const url  = URL.createObjectURL(blob);
    const rec  = { name, size: blob.size, mimeType, relativePath, url, blob };
    s.received.push(rec);
    this.emit('file-received', { peerId, transferId, fileIndex, ...rec });
    s.currentFile = null; s.chunks = []; s.rxBytes = 0;
  }

  _onComplete(peerId, { transferId }) {
    const s = this.rxState.get(peerId);
    if (!s || s.transferId !== transferId) return;
    this.emit('transfer-complete-rx', { peerId, transferId, received: s.received.slice() });
    this.rxState.delete(peerId);
  }

  _onCancel(peerId, { transferId }) {
    /* Sender cancelled a transfer we were receiving */
    const s = this.rxState.get(peerId);
    if (s && s.transferId === transferId) {
      this.rxState.delete(peerId);
      this.emit('incoming-cancelled', { peerId, transferId });
    }
    /* Receiver cancelled mid-send */
    const t = this.outgoing.get(transferId);
    if (t) { const ps = t.peers.get(peerId); if (ps) ps.cancelled = true; }
  }

  /* ──────────────────────────────────────────────────────────────────
     Sender loop — runs per accepted peer, per file, sequentially
  ────────────────────────────────────────────────────────────────── */
  async _sendToPeer(t, peerId) {
    const ps = t.peers.get(peerId);
    for (let fi = 0; fi < t.files.length; fi++) {
      if (t.cancelled || ps.cancelled) {
        this._rawSend(peerId, JSON.stringify({ type: 'transfer-cancel', transferId: t.id }));
        return;
      }
      await this._sendFile(t, peerId, t.files[fi], fi);
    }
    if (!t.cancelled && !ps.cancelled) {
      this._rawSend(peerId, JSON.stringify({ type: 'transfer-complete', transferId: t.id }));
      this.emit('outgoing-complete', { transferId: t.id, peerId });
    }
  }

  async _sendFile(t, peerId, file, fi) {
    const ps         = t.peers.get(peerId);
    const totalChunks = file.size > 0 ? Math.ceil(file.size / CHUNK_SIZE) : 0;

    this._rawSend(peerId, JSON.stringify({
      type: 'file-start', transferId: t.id, fileIndex: fi,
      name: file.name, size: file.size,
      mimeType: file.type || 'application/octet-stream',
      relativePath: file.relativePath || file.name,
      totalChunks
    }));

    let sent = 0, speedT = Date.now(), speedB = 0, speed = 0;

    for (let i = 0; i < totalChunks; i++) {
      if (t.cancelled || ps.cancelled) return;

      /* Read this chunk from disk (does not load whole file into memory) */
      let chunk;
      try {
        chunk = await file.slice(i * CHUNK_SIZE, Math.min((i + 1) * CHUNK_SIZE, file.size)).arrayBuffer();
      } catch (e) {
        console.error('File read error:', e);
        this.emit('outgoing-error', { transferId: t.id, peerId, error: e.message });
        return;
      }

      const dc = this._getDC(peerId);
      if (!dc || dc.readyState !== 'open') return;

      /* Backpressure — pause until DataChannel buffer drains */
      while (dc.bufferedAmount > HIGH_WATER) {
        if (t.cancelled || ps.cancelled) return;
        await new Promise(r => setTimeout(r, 20));
      }

      dc.send(chunk);
      sent += chunk.byteLength;

      const now = Date.now(), dt = (now - speedT) / 1000;
      if (dt >= 0.5) { speed = (sent - speedB) / dt; speedT = now; speedB = sent; }

      this.emit('outgoing-progress', {
        transferId: t.id, peerId, fileIndex: fi, fileName: file.name,
        bytesSent: sent, totalBytes: file.size,
        progress: file.size > 0 ? sent / file.size : 1,
        speed, eta: speed > 0 ? Math.max(0, (file.size - sent) / speed) : 0
      });
    }

    this._rawSend(peerId, JSON.stringify({ type: 'file-done', transferId: t.id, fileIndex: fi }));
    this.emit('outgoing-file-done', { transferId: t.id, peerId, fileIndex: fi, fileName: file.name });
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   PeerManager
   Manages RTCPeerConnections and DataChannels for all room peers.
   Delegates file-transfer messages to FileTransferManager.
═══════════════════════════════════════════════════════════════════════ */
class PeerManager extends Emitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.peers  = new Map();   // socketId → { pc: RTCPeerConnection, dc: RTCDataChannel }

    this.ftm = new FileTransferManager();
    this.ftm._rawSend = (pid, data) => this._dc_send(pid, data);
    this.ftm._getDC   = (pid)       => this.peers.get(pid)?.dc ?? null;

    /* Bubble FTM events up through PeerManager so callers need only one listener */
    const ftmEvents = [
      'outgoing-created','outgoing-progress','outgoing-file-done','outgoing-complete',
      'outgoing-cancelled','outgoing-error','peer-accepted','peer-rejected',
      'transfer-offer','offer-accepted','offer-rejected',
      'incoming-file-start','incoming-progress','file-received',
      'transfer-complete-rx','incoming-cancelled','outgoing-peer-cancelled'
    ];
    ftmEvents.forEach(e => this.ftm.on(e, d => this.emit(e, d)));

    this._bindSocket();
  }

  /* ── Socket event bindings (signalling relay) ──────────────────────── */
  _bindSocket() {
    const s = this.socket;

    s.on('webrtc-offer', async ({ from, sdp }) => {
      const peer = this._getOrCreate(from, false);
      try {
        await peer.pc.setRemoteDescription(new RTCSessionDescription(sdp));
        const ans = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(ans);
        s.emit('webrtc-answer', { to: from, sdp: ans });
      } catch (e) { console.error('Answer error:', e); }
    });

    s.on('webrtc-answer', async ({ from, sdp }) => {
      const peer = this.peers.get(from);
      if (peer) {
        try { await peer.pc.setRemoteDescription(new RTCSessionDescription(sdp)); }
        catch (e) { console.error('Set answer error:', e); }
      }
    });

    s.on('webrtc-ice', async ({ from, candidate }) => {
      const peer = this.peers.get(from);
      if (peer && candidate) {
        try { await peer.pc.addIceCandidate(new RTCIceCandidate(candidate)); }
        catch { /* ignore stale candidates */ }
      }
    });
  }

  /* ── Initiate connection to a new peer (called by existing users on user-joined) ── */
  connect(socketId) {
    const peer = this._getOrCreate(socketId, true);
    peer.pc.createOffer()
      .then(offer => peer.pc.setLocalDescription(offer).then(() =>
        this.socket.emit('webrtc-offer', { to: socketId, sdp: offer })
      ))
      .catch(e => console.error('Create offer error:', e));
  }

  disconnect(socketId) {
    const peer = this.peers.get(socketId);
    if (!peer) return;
    try { peer.dc?.close(); peer.pc.close(); } catch {}
    this.peers.delete(socketId);
    this.emit('peer-removed', { socketId });
  }

  isOpen(socketId) {
    return this.peers.get(socketId)?.dc?.readyState === 'open';
  }

  getOpenPeers() {
    return [...this.peers.entries()]
      .filter(([, p]) => p.dc?.readyState === 'open')
      .map(([id]) => id);
  }

  /* ── Internal peer creation ────────────────────────────────────────── */
  _getOrCreate(socketId, isOfferer) {
    if (this.peers.has(socketId)) return this.peers.get(socketId);

    const pc    = new RTCPeerConnection(ICE_CONFIG);
    const entry = { pc, dc: null };
    this.peers.set(socketId, entry);

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.socket.emit('webrtc-ice', { to: socketId, candidate });
    };

    pc.onconnectionstatechange = () => {
      this.emit('peer-conn-state', { socketId, state: pc.connectionState });
    };

    pc.ondatachannel = ({ channel }) => this._attachDC(socketId, channel, entry);

    if (isOfferer) {
      const dc = pc.createDataChannel('fd', { ordered: true });
      this._attachDC(socketId, dc, entry);
    }

    return entry;
  }

  _attachDC(socketId, dc, entry) {
    entry.dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = LOW_WATER;
    dc.onopen    = () => this.emit('dc-open',  { socketId });
    dc.onclose   = () => this.emit('dc-close', { socketId });
    dc.onerror   = e  => this.emit('dc-error', { socketId, e });
    dc.onmessage = ({ data }) => this.ftm.handleMessage(socketId, data);
  }

  _dc_send(socketId, data) {
    const peer = this.peers.get(socketId);
    if (peer?.dc?.readyState === 'open') { peer.dc.send(data); return true; }
    return false;
  }
}

/* Export globals — consumed by app.js */
window.PeerManager = PeerManager;
