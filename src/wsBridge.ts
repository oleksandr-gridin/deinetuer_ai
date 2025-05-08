import { WebSocketServer, WebSocket, RawData } from 'ws';
import { FastifyInstance } from 'fastify';
import {
  OPENAI_API_KEY,
  SYSTEM_MESSAGE,
  currentModel,
  currentVoice
} from './config.js';

const RESPONSE_TIMEOUT_MS = 15_000;

type Phase = 'IDLE' | 'LISTENING' | 'RESPONDING';
type LogSocket = WebSocket & { watchAll?: boolean };

interface Session {
  twilio: WebSocket;
  openai?: WebSocket;
  frontends: Set<LogSocket>;
  state: Phase;
  streamSid: string;
  buffer: RawData[];
  lastAssistantItem?: string;
  responseStartMs?: number;
  latestMediaTs?: number;
  heartbeat: NodeJS.Timeout;
}

type LiveLog =
  | { type: 'conversation.started'; sid: string }
  | { type: 'conversation.ended'; sid: string }
  | { type: 'user'; sid: string; text: string }
  | { type: 'agent'; sid: string; text: string; thinking_ms: number };

const log = (sid: string, m: string) => console.log(`[${sid}] ${m}`);
const safeSend = (ws: WebSocket | undefined, o: unknown) =>
  ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(o));

const createSessionUpdate = () => ({
  type: 'session.update',
  session: {
    turn_detection: { type: 'server_vad' },
    input_audio_format: 'g711_ulaw',
    output_audio_format: 'g711_ulaw',
    voice: currentVoice,
    instructions: SYSTEM_MESSAGE,
    modalities: ['audio', 'text'],
    temperature: 0.8,
    tools: ['web_search'],                        // tool подключён
    input_audio_transcription: { model: 'whisper-1' }
  }
});

const sessions = new Map<string, Session>();

const broadcast = (s: Session, p: LiveLog) =>
  s.frontends.forEach((w) => safeSend(w, p));

function closeSession(s: Session, reason: string) {
  [s.twilio, s.openai].forEach((ws) =>
    ws?.readyState === WebSocket.OPEN && ws.close()
  );
  s.frontends.forEach((w) => w.readyState === WebSocket.OPEN && w.close());
  clearInterval(s.heartbeat);
  sessions.delete(s.streamSid);
  broadcast(s, { type: 'conversation.ended', sid: s.streamSid });
  log(s.streamSid, `session closed (${reason})`);
}

export function registerWsBridge(app: FastifyInstance) {
  const wssMedia = new WebSocketServer({ noServer: true });
  const wssLogs = new WebSocketServer({ noServer: true });

  wssMedia.on('connection', (ws, req) => {
    const sid = String(req.headers['x-twilio-call-sid'] ?? Date.now());
    const front = new Set(
      [...wssLogs.clients].filter(
        (c): c is LogSocket => !!(c as LogSocket).watchAll
      )
    );

    const session: Session = {
      twilio: ws,
      state: 'IDLE',
      streamSid: sid,
      buffer: [],
      heartbeat: setInterval(() => {
        safeSend(session.twilio, { event: 'ping' });
        safeSend(session.openai, { type: 'ping' });
      }, 20_000),
      frontends: front
    };
    sessions.set(sid, session);

    ws.on('message', (d) => handleTwilio(session, d));
    ws.on('close', () => closeSession(session, 'twilio closed'));
    ws.on('error', () => closeSession(session, 'twilio error'));
  });

  wssLogs.on('connection', (ws, req) => {
    const sock = ws as LogSocket;
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const sid = url.searchParams.get('sid') || '*';

    if (sid === '*') {
      sock.watchAll = true;
      sessions.forEach((s) => s.frontends.add(sock));
    } else {
      sessions.get(sid)?.frontends.add(sock);
    }

    ws.on('close', () => sessions.forEach((s) => s.frontends.delete(sock)));
  });

  app.server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    if (url.pathname === '/media-stream')
      wssMedia.handleUpgrade(req, socket, head, (ws) =>
        wssMedia.emit('connection', ws, req)
      );
    else if (url.pathname === '/logs')
      wssLogs.handleUpgrade(req, socket, head, (ws) =>
        wssLogs.emit('connection', ws, req)
      );
    else socket.destroy();
  });

  app.get('/media-stream', (_, r) => r.code(400).send('WebSocket only'));
  app.get('/logs', (_, r) => r.code(400).send('WebSocket only'));
}

function handleTwilio(s: Session, raw: RawData) {
  let m: any;
  try {
    m = JSON.parse(raw.toString());
  } catch {
    return;
  }

  switch (m.event) {
    case 'start':
      s.streamSid = m.start.streamSid;
      s.state = 'LISTENING';
      s.latestMediaTs = 0;
      openOpenAI(s);
      broadcast(s, { type: 'conversation.started', sid: s.streamSid });
      break;

    case 'media':
      s.latestMediaTs = m.media.timestamp;
      const append = { type: 'input_audio_buffer.append', audio: m.media.payload };
      s.openai?.readyState === WebSocket.OPEN
        ? s.openai.send(JSON.stringify(append))
        : s.buffer.push(Buffer.from(JSON.stringify(append)));
      break;

    case 'stop':
      if (s.state !== 'LISTENING') return;
      s.state = 'RESPONDING';
      commitAudio(s);
      break;
  }
}

function openOpenAI(s: Session) {
  if (s.openai) return;

  const ws = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${currentModel}`,
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'OpenAI-Beta': 'realtime=v1' } }
  );
  s.openai = ws;

  ws.on('open', () => {
    safeSend(ws, createSessionUpdate());
    s.buffer.forEach((b) => ws.send(b));
    s.buffer.length = 0;
  });

  ws.on('message', (d) => handleOpenAI(s, d));

  ws.on('close', () => {
    log(s.streamSid, 'OpenAI closed - wait for timeout');
    s.openai = undefined;
  });
  ws.on('error', (e) => {
    log(s.streamSid, `OpenAI error: ${(e as Error).message}`);
    s.openai = undefined;
  });
}

function commitAudio(s: Session) {
  if (!s.openai) return;
  safeSend(s.openai, { type: 'input_audio_buffer.commit' });
  const killer = setTimeout(
    () => s.openai?.readyState === WebSocket.OPEN && s.openai.close(),
    RESPONSE_TIMEOUT_MS
  );
  s.openai.once('message', () => clearTimeout(killer));
}

function handleOpenAI(s: Session, raw: RawData) {
  let ev: any;
  try {
    ev = JSON.parse(raw.toString());
  } catch {
    return;
  }

  switch (ev.type) {
    case 'conversation.item.input_audio_transcription.completed':
      if (ev.transcription?.text)
        broadcast(
          s,
          { type: 'user', sid: s.streamSid, text: ev.transcription.text }
        );
      break;

    case 'response.audio.delta':
      if (!s.responseStartMs) s.responseStartMs = s.latestMediaTs;
      if (ev.item_id) s.lastAssistantItem = ev.item_id;

      safeSend(s.twilio, {
        event: 'media',
        streamSid: s.streamSid,
        media: { payload: ev.delta }
      });
      break;

    case 'response.done':
      const agent =
        ev.response?.output?.[0]?.content?.find((c: any) => c.transcript)
          ?.transcript;
      if (agent) {
        const rt = Date.now() - (s.responseStartMs ?? Date.now());
        broadcast(
          s,
          { type: 'agent', sid: s.streamSid, text: agent, thinking_ms: rt }
        );
      }
      s.state = 'LISTENING';
      s.responseStartMs = undefined;
      safeSend(s.openai, { type: 'input_audio_buffer.reset' });
      break;
  }
}