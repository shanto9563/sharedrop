# ShareDrop — P2P File Sharing

> Secure, serverless browser-to-browser file sharing powered by WebRTC DataChannel.  
> Files travel **directly** between peers — the server never sees, stores, or caches any file data.

---

## ✨ Features

| Category | Details |
|---|---|
| **Rooms** | Create / Join · Custom or random ID · Optional password · Copy link · QR code · Lock room · Auto-cleanup |
| **Users** | Nicknames · Random emoji avatars · Host badge · Online list · Kick users · Join/leave notifications |
| **File Sharing** | Any type · Any size · Drag & Drop · Folder upload · Preserve folder structure · Send to all or one peer · Accept / Reject · Cancel mid-transfer · Queue · Parallel transfers |
| **Progress** | Per-file progress bar · Upload & download speed · ETA · File icons |
| **Preview** | Images · Video · Audio · PDF (in-browser) |
| **Chat** | Room-wide chat · Emoji picker · System messages |
| **Security** | WebRTC DTLS-SRTP (E2E encrypted) · Lock room · Kick user · Zero server file storage |
| **Connectivity** | Google STUN · TURN fallback · Auto-reconnect · Connection indicator |
| **UI** | Mobile-first · Responsive · Dark glassmorphism · Smooth animations · Toast notifications |

---

## 🔧 Requirements

- **Node.js** ≥ 18.0.0
- **npm** ≥ 8.0.0
- Modern browser with WebRTC support (Chrome 80+, Firefox 75+, Safari 15+, Edge 80+)

---

## 🚀 Installation & Running Locally

```bash
# 1. Clone the repository
git clone https://github.com/YOUR_USERNAME/sharedrop.git
cd sharedrop

# 2. Install dependencies
npm install

# 3. Start the server
npm start

# 4. Open in browser
# http://localhost:3000
```

For development with auto-reload:
```bash
npm run dev   # requires nodemon (included in devDependencies)
```

---

## 🗂️ Project Structure

```
sharedrop/
├── server.js          ← Express + Socket.IO signalling server
├── package.json       ← Project metadata and scripts
├── .gitignore         ← Git ignore rules
├── README.md          ← This file
├── SETUPGUIDE.md      ← Bangla setup guide for GitHub + Render
└── public/
    ├── index.html     ← Single-page app shell
    ├── style.css      ← Dark glassmorphism UI (no frameworks)
    ├── webrtc.js      ← WebRTC engine (PeerManager + FileTransferManager)
    └── app.js         ← Application logic, UI, Socket.IO events
```

### Architecture

```
Browser A                 Server (Render)              Browser B
─────────                 ───────────────              ─────────
Socket.IO ←── SDP/ICE ──→ Socket.IO relay ←── SDP/ICE ──→ Socket.IO
                               │
                         (no file data)
                               │
DataChannel ════════════ Direct P2P ════════════════ DataChannel
              File bytes travel peer-to-peer only
```

---

## 🌐 Deployment on Render

1. Push code to GitHub
2. Go to [render.com](https://render.com) → **New Web Service**
3. Connect your GitHub repository
4. Configure:
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
5. Click **Deploy** — done!

See **SETUPGUIDE.md** for a complete step-by-step guide in Bangla.

---

## 🔒 Security Notes

- All file transfers use **WebRTC DTLS-SRTP** — encrypted end-to-end by the browser.
- The server only relays SDP offers, SDP answers, and ICE candidates.
- No file bytes, metadata, or content ever reach the server.
- Room passwords are compared in plain text on the server — for stronger security, hash them client-side before sending.

---

## 🌍 Browser Support

| Browser | Support |
|---|---|
| Chrome / Chromium | ✅ Full |
| Firefox | ✅ Full |
| Edge | ✅ Full |
| Safari 15+ | ✅ Full |
| Safari < 15 | ⚠️ Limited |
| Mobile Chrome | ✅ Full |
| Mobile Safari | ✅ Supported |

---

## 📡 STUN / TURN Configuration

The app ships with Google's public STUN servers and the free Open Relay TURN service.  
For production with many users, provide your own TURN credentials in `public/webrtc.js`:

```js
const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:your-stun-server:3478' },
    {
      urls: 'turn:your-turn-server:3478',
      username: 'YOUR_USERNAME',
      credential: 'YOUR_PASSWORD'
    }
  ]
};
```

---

## 📄 License

MIT © Dibya Jyoti Mahanta
