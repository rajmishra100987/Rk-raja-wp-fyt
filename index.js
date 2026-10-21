const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { makeWASocket } = require('nozez-whatsmeow');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ================================================================
//                DEVELOPED BY RAJ MISHRA
// ================================================================

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const APP_NAME = 'RAJ MISHRA';
const APP_VERSION = '1.0.0';
const START_TIME = Date.now();

// ---------- Global state ----------
let sock = null;
let isConnected = false; // ✅ कनेक्शन स्टेटस ट्रैक करने के लिए
let pairingRequested = false;
let reconnectInterval = null;
let currentPhoneNumber = null;
let currentSocketId = null;

// Task registry
const tasks = new Map();
const MAX_TASK_LOGS = 50;

// Delay helper
const delay = (ms) => new Promise((res) => setTimeout(res, ms));

// ---------- Helpers ----------
function genTaskId() {
    return `RAJ-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function serializeTask(t) {
    return {
        id: t.id,
        targetJid: t.targetJid,
        status: t.status,
        sentCount: t.sentCount,
        roundCount: t.roundCount,
        totalMessages: t.messages.length,
    };
}

// ================================================================
//                HTML + CSS + JS FRONTEND (Pink + Creamy + White)
// ================================================================
const HTML_PAGE = `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>VAMPIRE RULEX — WhatsApp Bot</title>
<script src="/socket.io/socket.io.js"></script>
<style>
    * { margin: 0; padding: 0; box-sizing: border-box; font-family: 'Segoe UI', Tahoma, sans-serif; }
    body { background: linear-gradient(135deg, #fff5f7 0%, #fde8ef 40%, #fffaf5 100%); min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
    .container { width: 100%; max-width: 650px; background: #ffffff; border-radius: 22px; padding: 34px; box-shadow: 0 20px 60px rgba(255, 105, 150, 0.18), 0 4px 16px rgba(0,0,0,0.04); border: 1px solid #ffe3ec; }
    .header { text-align: center; margin-bottom: 26px; padding-bottom: 20px; border-bottom: 2px dashed #ffd6e3; }
    .header h1 { font-size: 26px; background: linear-gradient(90deg, #ff4d88, #ff8bb3, #ff4d88); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; letter-spacing: 1px; margin-bottom: 6px; }
    .header .owner { font-size: 13px; color: #b86a85; font-weight: 600; letter-spacing: 2px; text-transform: uppercase; }
    .badge { display: inline-block; background: #fff0f5; color: #d6336c; padding: 4px 12px; border-radius: 20px; font-size: 11px; margin-top: 8px; border: 1px solid #ffd6e3; }
    
    .status-bar { background: #fff0f5; padding: 10px; border-radius: 10px; text-align: center; font-weight: bold; margin-bottom: 15px; color: #d6336c; border: 1px solid #ffd6e3; }
    .status-bar.connected { background: #e8f5e9; color: #2e7d32; border-color: #c8e6c9; }
    
    label { display: block; font-size: 13px; font-weight: 600; color: #8a3e5c; margin-bottom: 6px; margin-top: 14px; }
    input, textarea { width: 100%; padding: 12px 14px; border: 1.5px solid #ffe3ec; border-radius: 12px; background: #fffafc; font-size: 14px; color: #4a2b38; transition: all 0.25s; outline: none; }
    input:focus, textarea:focus { border-color: #ff8bb3; background: #ffffff; box-shadow: 0 0 0 4px rgba(255, 139, 179, 0.12); }
    textarea { resize: vertical; min-height: 80px; font-family: 'Courier New', monospace; font-size: 12px; }
    .btn { width: 100%; padding: 14px; margin-top: 15px; background: linear-gradient(135deg, #ff5c8a, #ff87ad); color: #fff; border: none; border-radius: 12px; font-size: 15px; font-weight: 700; letter-spacing: 1px; cursor: pointer; transition: all 0.25s; box-shadow: 0 8px 20px rgba(255, 92, 138, 0.3); }
    .btn:hover { transform: translateY(-2px); box-shadow: 0 12px 28px rgba(255, 92, 138, 0.42); }
    .btn:disabled { opacity: 0.6; cursor: not-allowed; transform: none; }
    .btn-outline { background: transparent; color: #ff5c8a; border: 2px solid #ff5c8a; box-shadow: none; }
    .btn-outline:hover { background: #fff0f5; box-shadow: none; }
    
    .log-box { margin-top: 22px; background: #fffaf5; border: 1.5px solid #ffe3ec; border-radius: 14px; padding: 14px; height: 200px; overflow-y: auto; font-family: 'Courier New', monospace; font-size: 12px; color: #5c3040; }
    .log-box::-webkit-scrollbar { width: 6px; }
    .log-box::-webkit-scrollbar-thumb { background: #ffb8ce; border-radius: 10px; }
    .log-line { padding: 3px 0; border-bottom: 1px dotted #ffe3ec; }
    .log-success { color: #2e7d32; }
    .log-error { color: #c62828; }
    .log-warn { color: #ef6c00; }
    
    .footer { text-align: center; margin-top: 24px; padding-top: 16px; border-top: 1px solid #ffe3ec; font-size: 12px; color: #b86a85; }
    .footer b { color: #d6336c; }
    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .pairing-code { font-size: 24px; font-weight: bold; text-align: center; color: #d6336c; letter-spacing: 5px; padding: 15px; background: #fff0f5; border-radius: 10px; border: 2px dashed #ff8bb3; margin-top: 15px; display: none; }
    @media (max-width: 520px) { .grid-2 { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<div class="container">
    <div class="header">
        <h1>🩸 VAMPIRE RULEX 🩸</h1>
        <div class="owner">Owner: Raj Mishra</div>
        <span class="badge">⚡ WhatsApp Auto Bot</span>
    </div>

    <div class="status-bar" id="statusBar">🔴 Bot Disconnected</div>

    <!-- Section 1: Connection -->
    <div id="connectSection">
        <label>📞 WhatsApp Number (with country code, no +)</label>
        <input type="text" id="phoneNumber" placeholder="e.g. 919876543210">
        <button class="btn" id="connectBtn" onclick="connectBot()">🔗 Connect Bot</button>
        <div class="pairing-code" id="pairingCodeDiv"></div>
    </div>

    <!-- Section 2: Task Setup -->
    <div id="taskSection" style="display: none;">
        <label>🎯 Target Group/Number ID (JID)</label>
        <div class="grid-2">
            <input type="text" id="targetJid" placeholder="e.g. 1203630...@g.us or 91...@s.whatsapp.net">
            <button class="btn btn-outline" style="margin-top:0;" onclick="fetchGroups()">📋 Fetch Groups</button>
        </div>
        
        <label>💬 Name Prefix</label>
        <input type="text" id="prefix" placeholder="e.g. RAJ MISHRA">

        <label>⏱️ Delay (seconds)</label>
        <input type="number" id="delaySec" value="5" min="1">

        <label>📄 Messages (One message per line)</label>
        <textarea id="messages" placeholder="Hello World&#10;This is a test&#10;VAMPIRE RULEX is here!"></textarea>

        <button class="btn" onclick="startTask()">🚀 START TASK</button>
    </div>

    <!-- Section 3: Live Logs -->
    <div class="log-box" id="logBox"></div>

    <div class="footer">Developed with 💖 by <b>VAMPIRE RULEX</b> • Owner: <b>Raj Mishra</b></div>
</div>

<script>
    const socket = io();
    const logBox = document.getElementById('logBox');
    const statusBar = document.getElementById('statusBar');
    const taskSection = document.getElementById('taskSection');
    const connectSection = document.getElementById('connectSection');
    const pairingCodeDiv = document.getElementById('pairingCodeDiv');

    function appendLog(msg, type = 'info') {
        const line = document.createElement('div');
        line.className = 'log-line log-' + type;
        line.textContent = msg;
        logBox.appendChild(line);
        logBox.scrollTop = logBox.scrollHeight;
    }

    socket.on('log', (data) => appendLog(data.message, data.type));
    
    socket.on('botStatus', (data) => {
        if (data.connected) {
            statusBar.textContent = '🟢 Bot Connected & Active';
            statusBar.classList.add('connected');
            connectSection.style.display = 'none';
            taskSection.style.display = 'block';
            pairingCodeDiv.style.display = 'none';
        } else {
            statusBar.textContent = '🔴 Bot Disconnected';
            statusBar.classList.remove('connected');
            connectSection.style.display = 'block';
            taskSection.style.display = 'none';
        }
    });

    socket.on('pairingCode', (code) => {
        pairingCodeDiv.style.display = 'block';
        pairingCodeDiv.textContent = code;
        appendLog('🔑 Pairing Code: ' + code, 'success');
    });

    socket.on('groupList', (groups) => {
        if (!groups.length) return appendLog('No groups found.', 'warn');
        appendLog('Groups fetched! Check prompt.', 'success');
        const groupStr = groups.map(g => g.subject + " -> " + g.id).join('\\n');
        const selected = prompt("Copy Group ID:\\n\\n" + groupStr);
        if (selected) document.getElementById('targetJid').value = selected;
    });

    function connectBot() {
        const phone = document.getElementById('phoneNumber').value.trim();
        if (!phone) return alert('Enter phone number!');
        appendLog('🔄 Connecting to WhatsApp...', 'info');
        socket.emit('connectBot', { phoneNumber: phone });
    }

    function fetchGroups() {
        socket.emit('getGroups');
    }

    function startTask() {
        const targetJid = document.getElementById('targetJid').value.trim();
        const prefix = document.getElementById('prefix').value.trim();
        const delaySec = document.getElementById('delaySec').value;
        const msgText = document.getElementById('messages').value.trim();
        
        if (!targetJid || !msgText) return alert('Target ID and Messages are required!');
        
        const messages = msgText.split('\\n').map(m => m.trim()).filter(m => m);
        
        socket.emit('startTask', { targetJid, messages, prefix, delay: delaySec });
        appendLog('🚀 Task sent to server!', 'success');
    }

    socket.emit('getTasks');
</script>
</body>
</html>
`;

// ================================================================
//                WHATSAPP BOT LOGIC (NOZEZ-WHATSMEOW)
// ================================================================
async function startBot(phoneNumber, socketId, autoRetry = true) {
    if (sock) {
        io.to(socketId).emit('log', { message: 'Bot already connected.', type: 'warn' });
        io.to(socketId).emit('botStatus', { connected: true });
        return;
    }
    
    currentPhoneNumber = phoneNumber;
    currentSocketId = socketId;

    const sessionDir = './session';
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

    // ✅ nozez-whatsmeow के अनुसार सही इनिशियलाइज़ेशन
    sock = makeWASocket({ 
        sessionName: path.join(sessionDir, 'session.db') 
    });
    
    // ✅ इंजन स्टार्ट करें
    sock.start();
    pairingRequested = false;

    // कनेक्शन अपडेट इवेंट
    sock.ev.on('connection.update', async (update) => {
        const { open, reason } = update;

        if (open) {
            isConnected = true; // ✅ स्टेटस अपडेट
            io.emit('log', { message: '[SUCCESS] WhatsApp Connected! 🎉', type: 'success' });
            io.emit('botStatus', { connected: true });
            pairingRequested = true; 
        } else {
            isConnected = false;
            if (!pairingRequested && phoneNumber) {
                pairingRequested = true;
                await delay(3000); 
                try {
                    // ✅ सही मेथड: requestPairingCode
                    let code = await sock.requestPairingCode(phoneNumber);
                    code = code?.match(/.{1,4}/g)?.join("-") || code;
                    io.to(socketId).emit('pairingCode', code);
                    io.emit('log', { message: `[+] Pairing Code: ${code}`, type: 'success' });
                } catch (error) {
                    io.emit('log', { message: `[-] Pairing Code Failed: ${error.message}`, type: 'error' });
                    sock = null;
                    io.emit('botStatus', { connected: false });
                }
            } else if (reason === 'connection_lost' || reason === 'stream_error') {
                io.emit('log', { message: '[-] Connection lost or Time Mismatch. Reconnecting...', type: 'warn' });
                sock = null;
                io.emit('botStatus', { connected: false });
                if (autoRetry) {
                    await delay(3000);
                    startBot(phoneNumber, socketId, true);
                }
            }
        }
    });

    // हेल्थ चेक (Auto Reconnect)
    if (reconnectInterval) clearInterval(reconnectInterval);
    reconnectInterval = setInterval(async () => {
        // ✅ isConnected वेरिएबल का उपयोग
        if (!sock || !isConnected) {
            io.emit('log', { message: '[-] Health check: Connection dead. Reconnecting...', type: 'warn' });
            if (sock && typeof sock.disconnect === 'function') {
                try { sock.disconnect(); } catch (e) {}
            }
            sock = null;
            isConnected = false;
            if (autoRetry) {
                await delay(2000);
                startBot(phoneNumber, socketId, true);
            }
        }
    }, 5 * 60 * 1000);
}

// ================================================================
//                MESSAGE LOOP
// ================================================================
async function runTaskLoop(task) {
    task.status = 'running';

    while (task.loopRunning) {
        for (let i = 0; i < task.messages.length; i++) {
            if (!task.loopRunning) break;
            
            let waitGuard = 0;
            // ✅ isConnected का उपयोग
            while ((!sock || !isConnected) && task.loopRunning && waitGuard < 60) {
                await delay(1000);
                waitGuard++;
            }
            if (!task.loopRunning) break;
            if (!sock || !isConnected) {
                io.emit('log', { message: 'Bot disconnected. Pausing task.', type: 'warn' });
                task.loopRunning = false;
                break;
            }

            task.sentCount++;
            const fullMessage = `${(task.prefix || '').trim()} ${task.messages[i]}`.trim();

            try {
                // ✅ सही मेथड: sendMessage
                await sock.sendMessage(task.targetJid, { text: fullMessage });
                io.emit('log', { message: `[SUCCESS] #${task.sentCount}: ${fullMessage}`, type: 'success' });
            } catch (err) {
                io.emit('log', { message: `[ERROR] Failed: ${err.message}`, type: 'error' });
            }
            await delay(task.delayMs);
        }
        if (!task.loopRunning) break;
        task.roundCount++;
        io.emit('log', { message: `[+] Round ${task.roundCount} finished. Restarting...`, type: 'info' });
    }

    task.status = 'stopped';
    io.emit('log', { message: `Task ${task.id} stopped. Total sent: ${task.sentCount}`, type: 'warn' });
}

// ================================================================
//                EXPRESS ROUTES & SOCKET.IO
// ================================================================
app.get('/', (req, res) => res.send(HTML_PAGE));
app.get('/health', (req, res) => res.status(200).send('OK'));

io.on('connection', (socket) => {
    socket.emit('botStatus', { connected: isConnected });

    socket.on('connectBot', async (data) => {
        const phoneNumber = (data.phoneNumber || '').replace(/[^0-9]/g, '');
        if (!phoneNumber) return socket.emit('log', { message: 'Phone number required.', type: 'error' });
        await startBot(phoneNumber, socket.id);
    });

    socket.on('getGroups', async () => {
        if (!sock || !isConnected) return socket.emit('log', { message: 'Bot not connected.', type: 'warn' });
        try {
            const groups = await sock.groupFetchAllParticipating();
            const list = Object.values(groups).map(g => ({ id: g.id, subject: g.subject }));
            socket.emit('groupList', list);
        } catch (err) {
            socket.emit('log', { message: `Group fetch error: ${err.message}`, type: 'error' });
        }
    });

    socket.on('startTask', (data) => {
        if (!sock || !isConnected) return socket.emit('log', { message: 'Bot not connected.', type: 'error' });
        
        const { targetJid, messages, prefix, delay: delaySec } = data;
        if (!targetJid || !messages?.length) return socket.emit('log', { message: 'Target/messages missing.', type: 'error' });

        const taskId = genTaskId();
        const task = {
            id: taskId, targetJid, messages: [...messages],
            prefix: prefix || '', delayMs: (parseInt(delaySec) || 5) * 1000,
            status: 'starting', sentCount: 0, roundCount: 1, loopRunning: true
        };
        tasks.set(taskId, task);
        runTaskLoop(task);
    });

    socket.on('stopBot', () => {
        for (const t of tasks.values()) t.loopRunning = false;
        if (sock && typeof sock.disconnect === 'function') {
            try { sock.disconnect(); } catch (e) {}
        }
        sock = null;
        isConnected = false;
        io.emit('log', { message: 'Bot stopped by user.', type: 'warn' });
        io.emit('botStatus', { connected: false });
    });
});

// ================================================================
//                START SERVER (Silent)
// ================================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    // साइलेंट स्टार्ट, होस्टिंग के लॉग्स साफ रहेंगे
});
