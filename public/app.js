/* ═══════════════════════════════════════════════════════════════════════
   app.js — ShareDrop main application
   Handles: UI state, Socket.IO events, room/user management,
            file selection, transfer UI, chat, modals, toasts
═══════════════════════════════════════════════════════════════════════ */

'use strict';

/* ── Utilities ────────────────────────────────────────────────────────── */
const $ = id => document.getElementById(id);
const fmt = {
  bytes(b, d = 1) {
    if (b === 0) return '0 B';
    const k = 1024, s = ['B','KB','MB','GB','TB'];
    const i = Math.floor(Math.log(b) / Math.log(k));
    return `${(b / k ** i).toFixed(i ? d : 0)} ${s[i]}`;
  },
  speed(bps)  { return bps > 0 ? `${fmt.bytes(bps)}/s` : '--'; },
  eta(secs) {
    if (!isFinite(secs) || secs <= 0) return '--';
    if (secs < 60)   return `${Math.ceil(secs)}s`;
    if (secs < 3600) return `${Math.ceil(secs/60)}m`;
    return `${Math.ceil(secs/3600)}h`;
  },
  pct(p)   { return `${Math.min(100, Math.round(p * 100))}%`; },
  time(ts) { return new Date(ts).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }); }
};

function fileIcon(mime, name = '') {
  const m = (mime || '').toLowerCase(), n = name.toLowerCase();
  if (m.startsWith('image/'))  return '🖼️';
  if (m.startsWith('video/'))  return '🎬';
  if (m.startsWith('audio/'))  return '🎵';
  if (m === 'application/pdf') return '📄';
  if (m.includes('zip') || m.includes('rar') || m.includes('7z') || m.includes('tar') || m.includes('gz')) return '📦';
  if (m.includes('word') || n.endsWith('.docx') || n.endsWith('.doc')) return '📝';
  if (m.includes('excel') || m.includes('spreadsheet') || n.endsWith('.xlsx') || n.endsWith('.xls')) return '📊';
  if (m.includes('powerpoint') || m.includes('presentation') || n.endsWith('.pptx')) return '📑';
  if (m.startsWith('text/') || n.endsWith('.txt') || n.endsWith('.md')) return '📃';
  if (m.includes('javascript') || m.includes('python') || n.endsWith('.js') || n.endsWith('.py') || n.endsWith('.ts')) return '💻';
  if (m.includes('json') || n.endsWith('.json')) return '🗂️';
  return '📁';
}

function isPreviewable(mime) {
  const m = (mime || '').toLowerCase();
  return m.startsWith('image/') || m.startsWith('video/') || m.startsWith('audio/') || m === 'application/pdf';
}

const EMOJIS = ['😀','😂','😅','🥰','😎','🤔','😢','😡','🥳','🎉','🔥','💯','👍','👎','❤️','✨','🚀','💀','🤯','👀','🙌','💪','🎵','🎬','💻','📁','⭐','🌙','☀️','🌈'];

/* ── App State ────────────────────────────────────────────────────────── */
const state = {
  socket:       null,
  pm:           null,
  ftm:          null,
  roomId:       null,
  user:         null,
  users:        [],        // { id, nickname, avatar, isHost }
  isHost:       false,
  stagedFiles:  [],        // File objects waiting to be sent
  transfers:    new Map(), // transferId → transfer UI record
  xferCount:    0,
  chatUnread:   0,
  activeTab:    'files',
  roomLocked:   false,

  /* pending incoming offer for modal */
  pendingOffer: null       // { peerId, transferId, files, from }
};

/* ══════════════════════════════════════════════════════════════════════
   INIT
══════════════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  initLoadingScreen();
  initSocket();
  initLandingUI();
  initRoomUI();
  initDropZone();
  initChat();
  initModals();
  initEmojiPicker();
  initMobileTabs();
  populateNicknameAvatar();
});

function initLoadingScreen() {
  setTimeout(() => {
    $('screen-loading').classList.remove('active');
    $('screen-landing').classList.add('active');
  }, 1800);
}

/* ══════════════════════════════════════════════════════════════════════
   SOCKET.IO
══════════════════════════════════════════════════════════════════════ */
function initSocket() {
  const socket = io({ transports: ['websocket', 'polling'] });
  state.socket = socket;
  state.pm  = new PeerManager(socket);
  state.ftm = state.pm.ftm;

  socket.on('connect',    () => updateConnIndicator('connecting'));
  socket.on('disconnect', () => {
    updateConnIndicator('disconnected');
    toast('Connection lost. Reconnecting…', 'warning');
  });
  socket.on('reconnect',  () => toast('Reconnected!', 'success'));

  /* Room events */
  socket.on('room-created', onRoomCreated);
  socket.on('room-joined',  onRoomJoined);
  socket.on('room-error',   msg => { toast(msg, 'error'); setLoading(false); });
  socket.on('user-joined',  ({ user, users }) => {
    updateUsers(users);
    systemMsg(`${user.nickname} joined the room`);
    toast(`${user.avatar} ${user.nickname} joined`, 'info', 2500);
    /* Existing users initiate WebRTC connection to new peer */
    if (user.id !== state.user?.id) state.pm.connect(user.id);
  });
  socket.on('user-left', ({ userId, users }) => {
    const leaving = state.users.find(u => u.id === userId);
    updateUsers(users);
    if (leaving) {
      systemMsg(`${leaving.nickname} left the room`);
      toast(`${leaving.avatar} ${leaving.nickname} left`, 'info', 2500);
    }
    state.pm.disconnect(userId);
    updateTargetSelect();
  });
  socket.on('room-locked',    ({ locked }) => onRoomLocked(locked));
  socket.on('host-granted',   ()           => onHostGranted());
  socket.on('kicked',         ()           => onKicked());
  socket.on('chat',           msg          => onChatMessage(msg));

  /* WebRTC events via PeerManager */
  state.pm.on('dc-open',         ({ socketId }) => onDCOpen(socketId));
  state.pm.on('dc-close',        ({ socketId }) => onDCClose(socketId));
  state.pm.on('peer-conn-state', ({ socketId, state: s }) => onPeerConnState(socketId, s));

  /* File transfer events */
  state.ftm.on('transfer-offer',       onTransferOffer);
  state.ftm.on('offer-accepted',       ({ transferId }) => updateXferCard(transferId));
  state.ftm.on('outgoing-created',     onOutgoingCreated);
  state.ftm.on('peer-accepted',        ({ transferId, peerId }) => onPeerAccepted(transferId, peerId));
  state.ftm.on('peer-rejected',        ({ transferId, peerId }) => onPeerRejected(transferId, peerId));
  state.ftm.on('outgoing-progress',    onOutgoingProgress);
  state.ftm.on('outgoing-file-done',   onOutgoingFileDone);
  state.ftm.on('outgoing-complete',    onOutgoingComplete);
  state.ftm.on('outgoing-cancelled',   ({ transferId }) => setXferStatus(transferId, 'cancelled', '✕ Cancelled'));
  state.ftm.on('outgoing-error',       ({ transferId, error }) => setXferStatus(transferId, 'rejected', `Error: ${error}`));
  state.ftm.on('incoming-file-start',  onIncomingFileStart);
  state.ftm.on('incoming-progress',    onIncomingProgress);
  state.ftm.on('file-received',        onFileReceived);
  state.ftm.on('transfer-complete-rx', onTransferCompleteRx);
  state.ftm.on('incoming-cancelled',   ({ peerId, transferId }) => {
    setXferStatus(transferId, 'cancelled', '✕ Sender cancelled');
    const peer = state.users.find(u => u.id === peerId);
    toast(`${peer?.nickname || 'Peer'} cancelled the transfer`, 'warning');
  });
}

/* ══════════════════════════════════════════════════════════════════════
   ROOM CALLBACKS
══════════════════════════════════════════════════════════════════════ */
function onRoomCreated({ roomId, user, users }) {
  setLoading(false);
  state.roomId = roomId; state.user = user;
  state.isHost = true; updateUsers(users);
  showRoomScreen(roomId);
  systemMsg(`Room ${roomId} created. Share the link to invite peers.`);
  updateConnIndicator('connecting');
}

function onRoomJoined({ roomId, user, users }) {
  setLoading(false);
  state.roomId = roomId; state.user = user;
  state.isHost = user.isHost; updateUsers(users);
  showRoomScreen(roomId);
  systemMsg(`Joined room ${roomId}. Connecting to peers…`);
  updateConnIndicator('connecting');
}

function onRoomLocked(locked) {
  state.roomLocked = locked;
  const btn = $('btn-lock-room');
  const badge = $('disp-lock-badge');
  btn.textContent = locked ? '🔓 Unlock' : '🔒 Lock';
  badge.classList.toggle('hidden', !locked);
  systemMsg(locked ? 'Room is now locked.' : 'Room is now unlocked.');
  toast(locked ? '🔒 Room locked' : '🔓 Room unlocked', 'info');
}

function onHostGranted() {
  state.isHost = true;
  state.users = state.users.map(u => u.id === state.user.id ? { ...u, isHost: true } : u);
  renderUsers();
  showHostControls(true);
  toast('👑 You are now the room host', 'success');
  systemMsg('You are now the host.');
}

function onKicked() {
  toast('You were kicked from the room.', 'error');
  leaveRoom();
}

/* ══════════════════════════════════════════════════════════════════════
   LANDING UI
══════════════════════════════════════════════════════════════════════ */
function initLandingUI() {
  $('btn-gen-id').addEventListener('click', () => {
    $('inp-create-id').value = genRoomId();
  });

  $('btn-create').addEventListener('click', () => {
    const nick = $('inp-nick').value.trim();
    if (!nick) { toast('Please enter a nickname.', 'warning'); $('inp-nick').focus(); return; }
    setLoading(true, 'btn-create');
    state.socket.emit('create-room', {
      customId:  $('inp-create-id').value.trim() || '',
      password:  $('inp-create-pass').value.trim() || '',
      nickname:  nick
    });
  });

  $('btn-join').addEventListener('click', () => {
    const nick = $('inp-nick').value.trim();
    const rid  = $('inp-join-id').value.trim().toUpperCase();
    if (!nick) { toast('Please enter a nickname.', 'warning'); $('inp-nick').focus(); return; }
    if (!rid)  { toast('Please enter a Room ID.', 'warning'); $('inp-join-id').focus(); return; }
    setLoading(true, 'btn-join');
    state.socket.emit('join-room', {
      roomId:   rid,
      password: $('inp-join-pass').value.trim() || '',
      nickname: nick
    });
  });

  /* Allow Enter key in join field */
  $('inp-join-id').addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-join').click(); });
  $('inp-nick').addEventListener('keydown', e => { if (e.key === 'Enter') $('inp-create-id').focus(); });

  /* Check for room ID in URL ?room=XXXX */
  const urlParams = new URLSearchParams(window.location.search);
  const urlRoom = urlParams.get('room');
  if (urlRoom) {
    $('inp-join-id').value = urlRoom.toUpperCase();
    toast(`Room ID ${urlRoom.toUpperCase()} pre-filled. Enter your nickname and join!`, 'info', 5000);
  }
}

function populateNicknameAvatar() {
  const saved = localStorage.getItem('sd_nickname');
  if (saved) $('inp-nick').value = saved;
  updateAvatarPreview();
  $('inp-nick').addEventListener('input', () => {
    localStorage.setItem('sd_nickname', $('inp-nick').value);
    updateAvatarPreview();
  });
}

function updateAvatarPreview() {
  const avatars = ['🦊','🐼','🦁','🐯','🐸','🦄','🐙','🦋','🐳','🦅','🐉','🦚','🐬'];
  const nick = $('inp-nick').value.trim();
  const idx  = nick.length % avatars.length;
  $('landing-avatar').textContent = nick ? avatars[idx] : '🦊';
}

function genRoomId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

/* ══════════════════════════════════════════════════════════════════════
   ROOM UI
══════════════════════════════════════════════════════════════════════ */
function initRoomUI() {
  $('btn-leave').addEventListener('click', () => { if (confirm('Leave room?')) leaveRoom(); });
  $('btn-copy-link').addEventListener('click', copyRoomLink);
  $('btn-show-qr').addEventListener('click', showQR);
  $('btn-lock-room').addEventListener('click', () => state.socket.emit('lock-room'));
  $('btn-send').addEventListener('click', doSendFiles);
  $('btn-clear-staged').addEventListener('click', clearStaged);
  $('btn-pick-files').addEventListener('click', () => $('inp-files').click());
  $('btn-pick-folder').addEventListener('click', () => $('inp-folder').click());
  $('inp-files').addEventListener('change', e => stageFiles(Array.from(e.target.files)));
  $('inp-folder').addEventListener('change', e => stageFiles(Array.from(e.target.files)));
}

function showRoomScreen(roomId) {
  $('screen-landing').classList.remove('active');
  $('screen-room').classList.add('active');
  $('disp-room-id').textContent = roomId;
  showHostControls(state.isHost);
  $('tab-user-count').textContent = state.users.length;
  $('user-count-badge').textContent = state.users.length;
  clearTransfersUI();
  clearChatUI();
  updateTargetSelect();
}

function showHostControls(isHost) {
  document.querySelectorAll('.host-ctrl').forEach(el =>
    el.classList.toggle('hidden', !isHost)
  );
}

function leaveRoom() {
  state.socket.emit('leave-room');
  state.pm.peers.forEach((_, id) => state.pm.disconnect(id));
  state.roomId = null; state.user = null; state.users = [];
  state.isHost = false; state.stagedFiles = [];
  state.transfers.clear(); state.xferCount = 0;
  state.pendingOffer = null; state.roomLocked = false;
  closeModal('modal-offer'); closeModal('modal-preview'); closeModal('modal-qr');
  $('screen-room').classList.remove('active');
  $('screen-landing').classList.add('active');
  updateConnIndicator('connecting');
  history.replaceState(null, '', window.location.pathname);
  toast('Left the room.', 'info');
}

/* ── Users ──────────────────────────────────────────────────────────── */
function updateUsers(users) {
  state.users = users || [];
  renderUsers();
  updateTargetSelect();
  $('tab-user-count').textContent  = state.users.length;
  $('user-count-badge').textContent = state.users.length;
}

function renderUsers() {
  const list = $('users-list');
  list.innerHTML = '';
  state.users.forEach(u => {
    const isMe   = u.id === state.user?.id;
    const dcOpen = isMe || state.pm.isOpen(u.id);

    const el = document.createElement('div');
    el.className = `user-item${isMe ? ' me' : ''}`;
    el.dataset.uid = u.id;
    el.innerHTML = `
      <span class="user-avatar">${u.avatar}</span>
      <div class="user-info">
        <div class="user-nick">${esc(u.nickname)}${isMe ? ' <span class="text-muted" style="font-weight:400;font-size:.75rem;">(you)</span>' : ''}</div>
        <div class="user-status">
          <span class="peer-dot${dcOpen ? ' open' : ''}" title="${dcOpen ? 'Connected' : 'Connecting…'}"></span>
          ${dcOpen ? 'connected' : 'connecting…'}
        </div>
      </div>
      ${u.isHost ? '<span class="host-badge">👑 Host</span>' : ''}
      ${state.isHost && !isMe ? `<button class="kick-btn" data-uid="${u.id}" title="Kick">✕</button>` : ''}
    `;
    list.appendChild(el);
  });

  /* Kick button handlers */
  list.querySelectorAll('.kick-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const u = state.users.find(u => u.id === btn.dataset.uid);
      if (u && confirm(`Kick ${u.nickname}?`)) state.socket.emit('kick-user', { userId: u.id });
    });
  });
}

function updateTargetSelect() {
  const sel = $('sel-target');
  const cur = sel.value;
  sel.innerHTML = '<option value="all">👥 Everyone</option>';
  state.users.filter(u => u.id !== state.user?.id).forEach(u => {
    const opt = document.createElement('option');
    opt.value = u.id;
    opt.textContent = `${u.avatar} ${u.nickname}`;
    sel.appendChild(opt);
  });
  if ([...sel.options].some(o => o.value === cur)) sel.value = cur;
}

/* ── Peer connection status ─────────────────────────────────────────── */
function onDCOpen(socketId) {
  renderUsers(); // refresh peer-dot to green
  updateTargetSelect();
  /* Check if any peer is now connected */
  const openCount = state.pm.getOpenPeers().length;
  if (openCount > 0) updateConnIndicator('connected');
}

function onDCClose(socketId) {
  renderUsers();
  if (state.pm.getOpenPeers().length === 0 && state.users.length > 1)
    updateConnIndicator('connecting');
}

function onPeerConnState(socketId, s) {
  if (s === 'failed') {
    toast(`⚠️ P2P connection failed — using relay`, 'warning');
  }
}

function updateConnIndicator(status) {
  const el = $('conn-indicator');
  el.className = `conn-indicator conn-${status}`;
  const labels = { connecting: 'Connecting', connected: 'P2P Ready', disconnected: 'Disconnected' };
  $('conn-label').textContent = labels[status] || status;
}

/* ══════════════════════════════════════════════════════════════════════
   FILE SELECTION & STAGING
══════════════════════════════════════════════════════════════════════ */
function initDropZone() {
  const zone = $('drop-zone');

  zone.addEventListener('dragover', e => {
    e.preventDefault(); e.stopPropagation();
    zone.classList.add('drag-over');
  });

  ['dragleave', 'dragend'].forEach(ev =>
    zone.addEventListener(ev, () => zone.classList.remove('drag-over'))
  );

  zone.addEventListener('drop', async e => {
    e.preventDefault(); e.stopPropagation();
    zone.classList.remove('drag-over');
    const files = await extractDroppedFiles(e.dataTransfer.items || e.dataTransfer.files);
    if (files.length > 0) stageFiles(files);
  });
}

/* Recursively extract files (supports folder drops via FileSystem API) */
async function extractDroppedFiles(items) {
  const files = [];

  async function traverseEntry(entry, basePath) {
    if (entry.isFile) {
      return new Promise(res => {
        entry.file(f => { f.relativePath = basePath + f.name; res([f]); },
                   () => res([]));
      });
    }
    if (entry.isDirectory) {
      return new Promise(res => {
        const reader = entry.createReader();
        const all = [];
        function readBatch() {
          reader.readEntries(async batch => {
            if (!batch.length) {
              const found = [];
              for (const e of all) found.push(...await traverseEntry(e, basePath + entry.name + '/'));
              res(found);
            } else { all.push(...batch); readBatch(); }
          }, () => res([]));
        }
        readBatch();
      });
    }
    return [];
  }

  /* Use DataTransferItemList if available (supports folders) */
  if (items && items[0] && items[0].webkitGetAsEntry) {
    for (const item of items) {
      const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
      if (entry) {
        files.push(...await traverseEntry(entry, ''));
      } else if (item.getAsFile) {
        const f = item.getAsFile();
        if (f) { f.relativePath = f.name; files.push(f); }
      }
    }
  } else {
    /* Fallback: FileList */
    for (const f of items) { f.relativePath = f.relativePath || f.webkitRelativePath || f.name; files.push(f); }
  }

  return files.filter(f => f.size >= 0);
}

function stageFiles(files) {
  if (!files.length) return;
  /* Assign relativePath from webkitRelativePath if not already set */
  files.forEach(f => { if (!f.relativePath) f.relativePath = f.webkitRelativePath || f.name; });
  state.stagedFiles = files;
  renderStagedFiles();
  $('staged-section').classList.remove('hidden');
  $('drop-zone').style.opacity = '.5';
}

function renderStagedFiles() {
  const list   = $('staged-list');
  const label  = $('staged-label');
  const total  = state.stagedFiles.reduce((s, f) => s + f.size, 0);
  const count  = state.stagedFiles.length;
  label.textContent = `${count} file${count > 1 ? 's' : ''} selected — ${fmt.bytes(total)}`;
  list.innerHTML = '';
  state.stagedFiles.slice(0, 50).forEach(f => {
    const div = document.createElement('div');
    div.className = 'staged-file-item';
    div.innerHTML = `
      <span class="sf-icon">${fileIcon(f.type, f.name)}</span>
      <div class="sf-info">
        <div class="sf-name">${esc(f.name)}</div>
        ${f.relativePath && f.relativePath !== f.name
          ? `<div class="sf-path">${esc(f.relativePath)}</div>` : ''}
      </div>
      <span class="sf-size">${fmt.bytes(f.size)}</span>
    `;
    list.appendChild(div);
  });
  if (count > 50) {
    const more = document.createElement('div');
    more.className = 'sf-path'; more.style.padding = '4px 10px';
    more.textContent = `…and ${count - 50} more files`;
    list.appendChild(more);
  }
}

function clearStaged() {
  state.stagedFiles = [];
  $('staged-section').classList.add('hidden');
  $('drop-zone').style.opacity = '';
  $('inp-files').value  = '';
  $('inp-folder').value = '';
}

/* ══════════════════════════════════════════════════════════════════════
   SENDING FILES
══════════════════════════════════════════════════════════════════════ */
function doSendFiles() {
  if (!state.stagedFiles.length) { toast('No files selected.', 'warning'); return; }
  const target = $('sel-target').value;

  let peerIds;
  if (target === 'all') {
    peerIds = state.pm.getOpenPeers();
  } else {
    if (!state.pm.isOpen(target)) {
      toast('That peer is not connected yet.', 'warning'); return;
    }
    peerIds = [target];
  }

  if (!peerIds.length) {
    toast('No connected peers. Wait for someone to join!', 'warning'); return;
  }

  state.ftm.sendFiles(state.stagedFiles.slice(), peerIds, state.user.nickname);
  clearStaged();
}

/* ══════════════════════════════════════════════════════════════════════
   TRANSFER EVENT HANDLERS — build/update cards in the transfers list
══════════════════════════════════════════════════════════════════════ */
function onOutgoingCreated({ transferId, meta, totalSize, peerIds }) {
  const targets = peerIds.map(pid => state.users.find(u => u.id === pid)?.nickname || pid).join(', ');
  const card = makeXferCard(transferId, {
    direction: 'out',
    icon:  meta.length === 1 ? fileIcon(meta[0].mimeType, meta[0].name) : '📦',
    name:  meta.length === 1 ? meta[0].name : `${meta.length} files (${fmt.bytes(totalSize)})`,
    meta:  `To: ${targets}`,
    status: 'pending',
    statusLabel: '⏳ Waiting…',
    files: meta,
    totalSize
  });
  addXferCard(transferId, card);
}

function onPeerAccepted(transferId, peerId) {
  const peer = state.users.find(u => u.id === peerId);
  updateXferCardMeta(transferId, `Sending to ${peer?.nickname || 'peer'}…`);
  setXferStatus(transferId, 'sending', '📤 Sending');
}

function onPeerRejected(transferId, peerId) {
  const peer = state.users.find(u => u.id === peerId);
  toast(`${peer?.nickname || 'Peer'} declined the transfer`, 'warning');
  updateXferCardMeta(transferId, `Declined by ${peer?.nickname || 'peer'}`);
  setXferStatus(transferId, 'rejected', '✕ Declined');
}

function onOutgoingProgress({ transferId, fileIndex, fileName, bytesSent, totalBytes, progress, speed, eta }) {
  const r = state.transfers.get(transferId);
  if (!r) return;
  const bar    = r.el.querySelector('.prog-fill');
  const pctEl  = r.el.querySelector('[data-pct]');
  const spdEl  = r.el.querySelector('[data-spd]');
  const etaEl  = r.el.querySelector('[data-eta]');
  if (bar)   bar.style.width = fmt.pct(progress);
  if (pctEl) pctEl.textContent = fmt.pct(progress);
  if (spdEl) spdEl.textContent = fmt.speed(speed);
  if (etaEl) etaEl.textContent = `ETA ${fmt.eta(eta)}`;
}

function onOutgoingFileDone({ transferId, fileIndex, fileName }) {
  updateXferCardMeta(transferId, `Sent: ${fileName}`);
}

function onOutgoingComplete({ transferId, peerId }) {
  const r = state.transfers.get(transferId);
  if (r) {
    const bar = r.el.querySelector('.prog-fill');
    if (bar) { bar.style.width = '100%'; bar.classList.add('done'); }
    const spdEl = r.el.querySelector('[data-spd]');
    const etaEl = r.el.querySelector('[data-eta]');
    if (spdEl) spdEl.textContent = '';
    if (etaEl) etaEl.textContent = '';
  }
  const peer = state.users.find(u => u.id === peerId);
  updateXferCardMeta(transferId, `Completed → ${peer?.nickname || 'peer'}`);
  setXferStatus(transferId, 'done', '✓ Sent');
  toast('✅ Transfer complete!', 'success');
}

/* Incoming offer — show modal */
function onTransferOffer({ peerId, transferId, files, from }) {
  /* If another modal is already open, queue could be added here; for now show immediately */
  state.pendingOffer = { peerId, transferId, files, from };
  renderOfferModal({ peerId, transferId, files, from });
  openModal('modal-offer');

  /* Also add a card in transfers list so user can act from there too */
  const totalSize = files.reduce((s, f) => s + f.size, 0);
  const card = makeXferCard(transferId, {
    direction: 'in',
    icon:  files.length === 1 ? fileIcon(files[0].mimeType, files[0].name) : '📦',
    name:  files.length === 1 ? files[0].name : `${files.length} files (${fmt.bytes(totalSize)})`,
    meta:  `From: ${from}`,
    status: 'pending',
    statusLabel: '⏳ Incoming',
    files,
    totalSize,
    isOffer: true, peerId, transferId
  });
  addXferCard(transferId, card);
}

function onIncomingFileStart({ peerId, transferId, fileIndex, name, size }) {
  const peer = state.users.find(u => u.id === peerId);
  setXferStatus(transferId, 'recving', '📥 Receiving');
  updateXferCardMeta(transferId, `Receiving: ${name}`);
}

function onIncomingProgress({ transferId, fileIndex, fileName, rxBytes, totalBytes, progress, speed, eta }) {
  const r = state.transfers.get(transferId);
  if (!r) return;
  const bar   = r.el.querySelector('.prog-fill');
  const pctEl = r.el.querySelector('[data-pct]');
  const spdEl = r.el.querySelector('[data-spd]');
  const etaEl = r.el.querySelector('[data-eta]');
  if (bar)   bar.style.width = fmt.pct(progress);
  if (pctEl) pctEl.textContent = fmt.pct(progress);
  if (spdEl) spdEl.textContent = fmt.speed(speed);
  if (etaEl) etaEl.textContent = `ETA ${fmt.eta(eta)}`;
}

function onFileReceived({ peerId, transferId, fileIndex, name, size, mimeType, relativePath, url }) {
  const r = state.transfers.get(transferId);
  if (!r) return;
  /* Append a download row for this file */
  let filesList = r.el.querySelector('.xfer-files');
  if (!filesList) {
    filesList = document.createElement('div');
    filesList.className = 'xfer-files';
    const body = r.el.querySelector('.xfer-body');
    if (body) body.appendChild(filesList);
  }
  const row = document.createElement('div');
  row.className = 'xfer-file-row';
  row.innerHTML = `
    <span class="xfr-fi">${fileIcon(mimeType, name)}</span>
    <span class="xfr-name" title="${esc(relativePath)}">${esc(name)}</span>
    <span class="xfr-sz">${fmt.bytes(size)}</span>
    ${isPreviewable(mimeType) ? `<button class="xfr-dl preview-trigger" data-url="${url}" data-mime="${mimeType}" data-name="${esc(name)}">👁</button>` : ''}
    <a class="xfr-dl" href="${url}" download="${esc(name)}" title="Download">⬇</a>
  `;
  /* Preview trigger */
  const prevBtn = row.querySelector('.preview-trigger');
  if (prevBtn) prevBtn.addEventListener('click', () => openPreview(url, mimeType, name));
  filesList.appendChild(row);
}

function onTransferCompleteRx({ peerId, transferId, received }) {
  const bar = state.transfers.get(transferId)?.el?.querySelector('.prog-fill');
  if (bar) { bar.style.width = '100%'; bar.classList.add('done'); }
  const peer = state.users.find(u => u.id === peerId);
  setXferStatus(transferId, 'done', '✓ Received');
  updateXferCardMeta(transferId, `From: ${peer?.nickname || 'peer'} — ${received.length} file${received.length > 1 ? 's' : ''}`);
  toast(`📥 Received ${received.length} file${received.length > 1 ? 's' : ''}!`, 'success');
}

/* ── Transfer card DOM helpers ─────────────────────────────────────── */
function makeXferCard(transferId, { direction, icon, name, meta, status, statusLabel, files, totalSize, isOffer, peerId }) {
  const card = document.createElement('div');
  card.className = 'xfer-card';
  card.dataset.tid = transferId;

  const isOut = direction === 'out';
  const progColor = isOut ? 'send' : 'recv';

  card.innerHTML = `
    <div class="xfer-hdr">
      <span class="xfer-icon">${icon}</span>
      <div class="xfer-info">
        <div class="xfer-name" title="${esc(name)}">${esc(name)}</div>
        <div class="xfer-meta" data-meta>${esc(meta)}</div>
      </div>
      <div class="xfer-actions">
        <span class="xfer-badge ${status}" data-status>${statusLabel}</span>
        ${!isOffer && isOut ? `<button class="ic-sm cancel" data-cancel="${transferId}" title="Cancel">✕</button>` : ''}
      </div>
    </div>
    <div class="xfer-body">
      <div class="prog-wrap">
        <div class="prog-bar"><div class="prog-fill ${progColor}" style="width:0%"></div></div>
        <div class="prog-stats">
          <span data-pct>0%</span>
          <span data-spd></span>
          <span data-eta></span>
        </div>
      </div>
      ${isOffer ? `
        <div class="xfer-offer-btns">
          <button class="btn btn-danger"   data-reject="${transferId}" data-peer="${peerId}">✕ Decline</button>
          <button class="btn btn-primary"  data-accept="${transferId}" data-peer="${peerId}">✓ Accept</button>
        </div>
      ` : ''}
    </div>
  `;

  /* Cancel button */
  const cancelBtn = card.querySelector('[data-cancel]');
  if (cancelBtn) cancelBtn.addEventListener('click', () => state.ftm.cancelOutgoing(transferId));

  /* Accept / Reject buttons in card */
  const acceptBtn = card.querySelector('[data-accept]');
  const rejectBtn = card.querySelector('[data-reject]');
  if (acceptBtn) acceptBtn.addEventListener('click', () => {
    state.ftm.acceptOffer(peerId, transferId);
    acceptBtn.closest('.xfer-offer-btns').remove();
    closeModal('modal-offer');
    state.pendingOffer = null;
  });
  if (rejectBtn) rejectBtn.addEventListener('click', () => {
    state.ftm.rejectOffer(peerId, transferId);
    rejectBtn.closest('.xfer-offer-btns').remove();
    setXferStatus(transferId, 'rejected', '✕ Declined');
    closeModal('modal-offer');
    state.pendingOffer = null;
  });

  return card;
}

function addXferCard(transferId, card) {
  state.transfers.set(transferId, { el: card });
  $('xfer-empty').style.display = 'none';
  $('transfers-list').appendChild(card);
  state.xferCount++;
  $('xfer-count').textContent = state.xferCount;
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function updateXferCard(transferId) {
  /* Refresh full card if needed */
}

function updateXferCardMeta(transferId, text) {
  const r = state.transfers.get(transferId);
  if (!r) return;
  const el = r.el.querySelector('[data-meta]');
  if (el) el.textContent = text;
}

function setXferStatus(transferId, cls, label) {
  const r = state.transfers.get(transferId);
  if (!r) return;
  const el = r.el.querySelector('[data-status]');
  if (el) { el.className = `xfer-badge ${cls}`; el.textContent = label; }
}

function clearTransfersUI() {
  $('transfers-list').innerHTML = '';
  $('transfers-list').insertAdjacentHTML('beforeend', `
    <div id="xfer-empty" class="empty-state">
      <span class="empty-icon">📭</span>
      <p>No transfers yet</p>
      <p class="empty-hint">Pick files above and send to peers.</p>
    </div>
  `);
  state.transfers.clear();
  state.xferCount = 0;
  $('xfer-count').textContent = 0;
}

/* ══════════════════════════════════════════════════════════════════════
   CHAT
══════════════════════════════════════════════════════════════════════ */
function initChat() {
  $('btn-chat-send').addEventListener('click', sendChat);
  $('inp-chat').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });
}

function sendChat() {
  const msg = $('inp-chat').value.trim();
  if (!msg || !state.roomId) return;
  state.socket.emit('chat', { message: msg });
  $('inp-chat').value = '';
  closeEmojiPicker();
}

function onChatMessage({ from, avatar, nickname, message, ts }) {
  const isMe = from === state.user?.id;
  const wrap = document.createElement('div');
  wrap.className = `chat-msg${isMe ? ' mine' : ''}`;
  wrap.innerHTML = `
    ${!isMe ? `<div class="msg-av"><span class="user-avatar sm">${avatar}</span></div>` : ''}
    <div>
      ${!isMe ? `<div class="msg-nick">${esc(nickname)}</div>` : ''}
      <div class="msg-bubble"><div class="msg-text">${esc(message)}</div></div>
      <div class="msg-time">${fmt.time(ts)}</div>
    </div>
  `;
  const msgs = $('chat-messages');
  msgs.appendChild(wrap);
  msgs.scrollTop = msgs.scrollHeight;

  /* Badge when chat is not active tab */
  if (state.activeTab !== 'chat') {
    state.chatUnread++;
    const badge = $('tab-chat-badge');
    badge.textContent = '•';
    badge.classList.remove('hidden');
  }
}

function systemMsg(text) {
  const el = document.createElement('div');
  el.className = 'chat-msg system';
  el.innerHTML = `<div class="system-msg">${esc(text)}</div>`;
  const msgs = $('chat-messages');
  msgs.appendChild(el);
  msgs.scrollTop = msgs.scrollHeight;
}

function clearChatUI() {
  $('chat-messages').innerHTML = '';
  $('tab-chat-badge').classList.add('hidden');
  state.chatUnread = 0;
}

/* ══════════════════════════════════════════════════════════════════════
   EMOJI PICKER
══════════════════════════════════════════════════════════════════════ */
function initEmojiPicker() {
  const tray = $('emoji-picker');
  EMOJIS.forEach(em => {
    const btn = document.createElement('button');
    btn.className = 'emoji-btn';
    btn.textContent = em;
    btn.type = 'button';
    btn.addEventListener('click', () => {
      $('inp-chat').value += em;
      $('inp-chat').focus();
    });
    tray.appendChild(btn);
  });

  $('btn-emoji').addEventListener('click', e => {
    e.stopPropagation();
    tray.classList.toggle('hidden');
  });

  document.addEventListener('click', e => {
    if (!$('emoji-picker').contains(e.target) && e.target !== $('btn-emoji')) {
      closeEmojiPicker();
    }
  });
}

function closeEmojiPicker() {
  $('emoji-picker').classList.add('hidden');
}

/* ══════════════════════════════════════════════════════════════════════
   MOBILE TABS
══════════════════════════════════════════════════════════════════════ */
function initMobileTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      state.activeTab = tab;

      document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.toggle('active', p.dataset.tab === tab));

      if (tab === 'chat') {
        state.chatUnread = 0;
        $('tab-chat-badge').classList.add('hidden');
        setTimeout(() => {
          const msgs = $('chat-messages');
          msgs.scrollTop = msgs.scrollHeight;
        }, 50);
      }
    });
  });
}

/* ══════════════════════════════════════════════════════════════════════
   MODALS
══════════════════════════════════════════════════════════════════════ */
function initModals() {
  /* Close buttons */
  document.querySelectorAll('[data-close]').forEach(btn => {
    btn.addEventListener('click', () => closeModal(btn.dataset.close));
  });
  /* Overlay click to close */
  document.querySelectorAll('.overlay').forEach(ov => {
    ov.addEventListener('click', e => { if (e.target === ov) closeModal(ov.id); });
  });

  /* Offer modal buttons */
  $('btn-accept-offer').addEventListener('click', () => {
    if (!state.pendingOffer) return;
    state.ftm.acceptOffer(state.pendingOffer.peerId, state.pendingOffer.transferId);
    closeModal('modal-offer');
    state.pendingOffer = null;
  });
  $('btn-reject-offer').addEventListener('click', () => {
    if (!state.pendingOffer) return;
    state.ftm.rejectOffer(state.pendingOffer.peerId, state.pendingOffer.transferId);
    setXferStatus(state.pendingOffer.transferId, 'rejected', '✕ Declined');
    closeModal('modal-offer');
    state.pendingOffer = null;
  });

  /* Preview close */
  $('btn-close-preview').addEventListener('click', () => closeModal('modal-preview'));

  /* QR link copy */
  $('btn-copy-qr-link').addEventListener('click', () => {
    copyToClipboard(roomUrl(), 'Link copied!');
  });
}

function openModal(id)  { $(id).classList.remove('hidden'); }
function closeModal(id) { $(id).classList.add('hidden'); }

function renderOfferModal({ peerId, transferId, files, from }) {
  const totalSize = files.reduce((s, f) => s + f.size, 0);
  $('offer-body').innerHTML = `
    <p class="offer-from">📤 <strong>${esc(from)}</strong> wants to send you:</p>
    <div class="offer-files">
      ${files.map(f => `
        <div class="offer-file">
          <span class="offer-f-icon">${fileIcon(f.mimeType, f.name)}</span>
          <div class="offer-f-info">
            <div class="offer-f-name">${esc(f.name)}</div>
            <div class="offer-f-size">${fmt.bytes(f.size)} · ${esc(f.mimeType || 'unknown type')}</div>
          </div>
        </div>
      `).join('')}
    </div>
    <p class="offer-total">Total: ${files.length} file${files.length > 1 ? 's' : ''} · ${fmt.bytes(totalSize)}</p>
  `;
}

/* ── Preview modal ─────────────────────────────────────────────────── */
function openPreview(url, mimeType, name) {
  const m = (mimeType || '').toLowerCase();
  $('preview-fname').textContent = name;
  $('preview-dl').href     = url;
  $('preview-dl').download = name;

  let content = '';
  if (m.startsWith('image/'))      content = `<img src="${url}" alt="${esc(name)}">`;
  else if (m.startsWith('video/')) content = `<video src="${url}" controls autoplay style="max-width:100%"></video>`;
  else if (m.startsWith('audio/')) content = `<audio src="${url}" controls autoplay style="width:100%"></audio>`;
  else if (m === 'application/pdf') content = `<iframe src="${url}" title="${esc(name)}"></iframe>`;
  else content = `<p class="text-muted" style="padding:20px">Preview not available for this file type.</p>`;

  $('preview-body').innerHTML = content;
  openModal('modal-preview');
}

/* ── QR modal ──────────────────────────────────────────────────────── */
function showQR() {
  if (!state.roomId) return;
  const url = roomUrl();
  $('qr-img').src = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(url)}&margin=10&color=7c3aed&bgcolor=ffffff`;
  $('qr-link').textContent = url;
  openModal('modal-qr');
}

/* ══════════════════════════════════════════════════════════════════════
   UTILITIES
══════════════════════════════════════════════════════════════════════ */
function roomUrl() {
  return `${window.location.origin}${window.location.pathname}?room=${state.roomId}`;
}

function copyRoomLink() {
  if (!state.roomId) return;
  copyToClipboard(roomUrl(), '🔗 Link copied to clipboard!');
}

function copyToClipboard(text, successMsg) {
  navigator.clipboard.writeText(text)
    .then(()  => toast(successMsg || 'Copied!', 'success'))
    .catch(()  => {
      /* Fallback */
      const el = document.createElement('textarea');
      el.value = text; el.style.position = 'fixed'; el.style.opacity = '0';
      document.body.appendChild(el); el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
      toast(successMsg || 'Copied!', 'success');
    });
}

function setLoading(on, btnId) {
  if (btnId) {
    const btn = $(btnId);
    if (btn) { btn.disabled = on; btn.style.opacity = on ? '.6' : ''; }
  }
}

function esc(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

/* ── Toast Notifications ───────────────────────────────────────────── */
const ICONS = { success:'✅', error:'❌', warning:'⚠️', info:'ℹ️' };
function toast(message, type = 'info', duration = 3500) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `
    <span class="toast-icon">${ICONS[type] || 'ℹ️'}</span>
    <div class="toast-body"><div class="toast-msg">${esc(message)}</div></div>
  `;
  $('toasts').appendChild(el);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('visible')));
  setTimeout(() => {
    el.classList.add('hiding');
    setTimeout(() => el.remove(), 300);
  }, duration);
}
