const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    fetchLatestBaileysVersion, 
    delay 
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ================================================================
//                DEVELOPED BY RAJ MISHRA
// ================================================================

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const APP_NAME = 'RAJ MISHRA';
const APP_VERSION = '1.0.0';
const START_TIME = Date.now();

// ---------- Global state ----------
let sock = null;
let botActive = false;
let pairingRequested = false;

// Task registry
const tasks = new Map();
const MAX_TASK_LOGS = 100;

// ---------- Helpers ----------
function genTaskId() {
    return `RAJ-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function fmtUptime(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}

function serializeTask(t) {
    return {
        id: t.id,
        targetJid: t.targetJid,
        status: t.status,
        startTime: t.startTime,
        endTime: t.endTime,
        uptimeMs: (t.endTime || Date.now()) - t.startTime,
        sentCount: t.sentCount,
        roundCount: t.roundCount,
        totalMessages: t.messages.length,
        currentIndex: t.currentIndex
    };
}

// ---------- Logging (terminal silent) ----------
function emitLog(msg, type = 'info') {
    io.emit('log', { message: msg, type, ts: Date.now() });
}

function taskLog(task, msg, type = 'info') {
    const entry = { message: msg, type, ts: Date.now() };
    task.logs.push(entry);
    if (task.logs.length > MAX_TASK_LOGS) task.logs.shift();
    io.emit('taskLogBroadcast', { taskId: task.id, ...entry });
}

// ================================================================
//                Session Backup (every 6 hours, keep last 3)
// ================================================================
function backupSession() {
    const src = './session';
    if (!fs.existsSync(src)) return;
    const backupDir = './session_backups';
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

    try {
        const dst = path.join(backupDir, `session_${Date.now()}`);
        fs.cpSync(src, dst, { recursive: true });
        emitLog(`[BACKUP] Session backed up`, 'info');

        const backups = fs.readdirSync(backupDir).sort();
        while (backups.length > 3) {
            const old = backups.shift();
            fs.rmSync(path.join(backupDir, old), { recursive: true, force: true });
        }
    } catch (err) {
        emitLog(`[BACKUP FAIL] ${err.message}`, 'error');
    }
}

setInterval(backupSession, 6 * 60 * 60 * 1000);
setTimeout(backupSession, 60 * 1000);

// ================================================================
//                WhatsApp Bot Logic
// ================================================================
async function startBot(phoneNumber, socketId, autoRetry = true) {
    if (sock) {
        io.to(socketId).emit('log', { message: 'Bot already connected.', type: 'warn', ts: Date.now() });
        io.to(socketId).emit('botStatus', { connected: true });
        return;
    }
    botActive = true;

    const sessionDir = './session';
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        browser: ["Ubuntu", "Chrome", "20.0.0"]
    });

    pairingRequested = false;

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'connecting' && !sock.authState.creds.registered && !pairingRequested) {
            pairingRequested = true;
            await delay(4000);
            try {
                let code = await sock.requestPairingCode(phoneNumber);
                code = code?.match(/.{1,4}/g)?.join("-") || code;
                emitLog(`[+] PAIRING CODE: ${code}`, 'success');
                io.to(socketId).emit('pairingCode', code);
            } catch (error) {
                emitLog(`[-] Pairing Code Failed: ${error.message || error}`, 'error');
                botActive = false;
                sock = null;
                io.emit('botStatus', { connected: false });
            }
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode !== 401 && autoRetry) {
                emitLog('[-] Network lost. Reconnecting in 3s...', 'warn');
                sock = null;
                botActive = false;
                io.emit('botStatus', { connected: false });
                await delay(3000);
                startBot(phoneNumber, socketId, true);
            } else if (statusCode === 401) {
                emitLog('[-] Session expired, delete "session" folder.', 'error');
                sock = null;
                botActive = false;
                io.emit('botStatus', { connected: false });
            }
        } else if (connection === 'open') {
            emitLog('[SUCCESS] WhatsApp Connected! 🎉', 'success');
            io.emit('botStatus', { connected: true });
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

// ================================================================
//                Message Loop (per task)
// ================================================================
async function runTaskLoop(task) {
    task.status = 'running';
    io.emit('taskUpdate', serializeTask(task));

    while (task.loopRunning) {
        for (let i = 0; i < task.messages.length; i++) {
            if (!task.loopRunning) break;
            task.currentIndex = i + 1;

            let waitGuard = 0;
            while (!sock && task.loopRunning && waitGuard < 60) {
                await delay(1000);
                waitGuard++;
            }
            if (!task.loopRunning) break;
            if (!sock) {
                taskLog(task, 'Bot disconnected. Pausing task.', 'warn');
                task.loopRunning = false;
                break;
            }

            task.sentCount++;
            const fullMessage = `${(task.prefix || '').trim()} ${task.messages[i]}`.trim();

            try {
                await sock.sendMessage(task.targetJid, { text: fullMessage });
                taskLog(task,
                    `[SUCCESS] #${task.sentCount} | R${task.roundCount} [${i + 1}/${task.messages.length}]: ${fullMessage}`,
                    'success');
            } catch (err) {
                taskLog(task,
                    `[ERROR] #${task.sentCount} | Failed: ${err.message || err}`,
                    'error');
            }

            if (task.sentCount % 5 === 0) io.emit('taskUpdate', serializeTask(task));
            await delay(task.delayMs);
        }
        if (!task.loopRunning) break;
        task.roundCount++;
        taskLog(task, `[+] Round ${task.roundCount} finished. Restarting...`, 'info');
    }

    task.status = 'stopped';
    task.endTime = Date.now();
    io.emit('taskUpdate', serializeTask(task));
    taskLog(task, `Task ${task.id} stopped. Total sent: ${task.sentCount}`, 'warn');
}

// ================================================================
//                HEALTH ENDPOINT  (GET + HEAD, always 200)
// ================================================================
function buildHealthData() {
    const mem = process.memoryUsage();
    const active = [...tasks.values()].filter(t => t.status === 'running').length;
    return {
        app: APP_NAME,
        version: APP_VERSION,
        status: 'ok',
        message: 'Bot is alive ✅',
        uptimeSec: Math.floor(process.uptime()),
        uptimeHuman: fmtUptime(Date.now() - START_TIME),
        memoryMB: Math.round(mem.rss / 1024 / 1024),
        heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
        botConnected: !!(sock && sock.user),
        activeTasks: active,
        totalTasks: tasks.size,
        serverTime: new Date().toISOString()
    };
}

// GET /health  → returns JSON
app.get('/health', (req, res) => {
    res.status(200).json(buildHealthData());
});

// HEAD /health → returns 200 with no body (for pingers that only need status)
app.head('/health', (req, res) => {
    res.status(200).end();
});

// GET /  → simple text (for root pings)
app.get('/', (req, res) => {
    res.status(200).send('RAJ MISHRA Bot is running ✅');
});

// HEAD /  → for root pings
app.head('/', (req, res) => {
    res.status(200).end();
});

// HEAD /index.html → for UI pings
app.head('/index.html', (req, res) => {
    res.status(200).end();
});

// Catch-all HEAD for any other path → 200 (so any pinger URL works)
app.head('*', (req, res) => {
    res.status(200).end();
});

// ================================================================
//                Graceful shutdown + crash handlers
// ================================================================
process.on('SIGINT', async () => {
    for (const t of tasks.values()) t.loopRunning = false;
    backupSession();
    if (sock) { try { sock.end(undefined); } catch (e) {} }
    await delay(500);
    process.exit(0);
});
process.on('SIGTERM', () => process.emit('SIGINT'));
process.on('uncaughtException', (err) => {
    emitLog(`[FATAL] ${err.message}`, 'error');
});
process.on('unhandledRejection', (reason) => {
    emitLog(`[FATAL REJECTION] ${reason}`, 'error');
});

// ================================================================
//                Socket.IO Events
// ================================================================
io.on('connection', (socket) => {
    socket.emit('botStatus', { connected: !!(sock && sock.user) });
    socket.emit('taskList', [...tasks.values()].map(serializeTask));

    socket.on('connectBot', async (data) => {
        const phoneNumber = (data.phoneNumber || '').replace(/[^0-9]/g, '');
        if (!phoneNumber) {
            socket.emit('log', { message: 'Phone number required.', type: 'error', ts: Date.now() });
            return;
        }
        await startBot(phoneNumber, socket.id);
    });

    socket.on('getGroups', async () => {
        if (!sock) {
            socket.emit('log', { message: 'Pehle connect karo.', type: 'warn', ts: Date.now() });
            return;
        }
        try {
            const groups = await sock.groupFetchAllParticipating();
            const list = Object.values(groups).map(g => ({ id: g.id, subject: g.subject }));
            socket.emit('groupList', list);
            socket.emit('log', { message: `Fetched ${list.length} groups.`, type: 'success', ts: Date.now() });
        } catch (err) {
            socket.emit('log', { message: `Group fetch error: ${err.message || err}`, type: 'error', ts: Date.now() });
        }
    });

    socket.on('startTask', async (data) => {
        if (!sock) {
            socket.emit('log', { message: 'Pehle bot connect karo.', type: 'error', ts: Date.now() });
            return;
        }
        const { targetJid, messages, prefix, delay: delaySec } = data;
        if (!targetJid || !messages?.length) {
            socket.emit('log', { message: 'Target/messages missing.', type: 'error', ts: Date.now() });
            return;
        }

        const taskId = genTaskId();
        const delayMs = (parseInt(delaySec) || 5) * 1000;

        const task = {
            id: taskId, targetJid, messages: [...messages],
            prefix: prefix || '', delayMs,
            status: 'starting', startTime: Date.now(), endTime: null,
            sentCount: 0, roundCount: 1, currentIndex: 0,
            loopRunning: true, logs: []
        };

        tasks.set(taskId, task);
        emitLog(`Task ${taskId} created → ${targetJid}`, 'success');
        socket.emit('taskCreated', serializeTask(task));
        io.emit('taskList', [...tasks.values()].map(serializeTask));
        runTaskLoop(task);
    });

    socket.on('stopTask', (data) => {
        const task = tasks.get(data?.taskId);
        if (!task) {
            socket.emit('log', { message: `Task not found.`, type: 'error', ts: Date.now() });
            return;
        }
        task.loopRunning = false;
        taskLog(task, 'Stop requested by user.', 'warn');
        io.emit('taskUpdate', serializeTask(task));
    });

    socket.on('getTaskInfo', (data) => {
        const task = tasks.get(data?.taskId);
        if (!task) { socket.emit('taskInfo', { error: 'Not found', taskId: data?.taskId }); return; }
        socket.emit('taskInfo', {
            ...serializeTask(task),
            uptimeHuman: fmtUptime((task.endTime || Date.now()) - task.startTime),
            logs: task.logs
        });
    });

    socket.on('getTasks', () => {
        socket.emit('taskList', [...tasks.values()].map(serializeTask));
    });

    socket.on('stopBot', () => {
        for (const t of tasks.values()) t.loopRunning = false;
        try { if (sock) sock.end(undefined); } catch (e) {}
        sock = null;
        botActive = false;
        emitLog('Bot stopped by user.', 'warn');
        io.emit('botStatus', { connected: false });
    });

    socket.on('disconnect', () => {});
});

// ================================================================
//                Start Server
// ================================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    // silent start
});
