import { WebSocketServer, WebSocket, RawData } from 'ws';
import { FastifyInstance } from 'fastify';
import {
  OPENAI_API_KEY,
  currentModel,
  SYSTEM_MESSAGE,
  currentVoice,
  webSearchEnabled
} from './config.js';
import functions from './functionHandlers.js';

type Phase = 'IDLE' | 'LISTENING' | 'RESPONDING';

interface Session {
  twilio: WebSocket;
  openai?: WebSocket;
  frontends: Set<WebSocket>;
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

const tools = webSearchEnabled ? ['web_search'] : [];
const RESPONSE_TIMEOUT_MS = 15000;

const sessionPool = new Map<string, Session>();

const log = (sid: string, m: string) => console.log(`[${sid}] ${m}`);

const safeSend = (ws: WebSocket | undefined, o: unknown) => {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o));
};

const createSessionUpdate = () => ({
  type: 'session.update',
  session: {
    turn_detection: { type: 'server_vad' },
    input_audio_format: 'g711_ulaw',
    output_audio_format: 'g711_ulaw',
    voice: currentVoice,
    instructions: SYSTEM_MESSAGE,
    modalities: ['text', 'audio'],
    temperature: 0.8,
    tools,
    input_audio_transcription: { model: 'whisper-1' }
  }
});

function broadcast(session: Session, payload: LiveLog) {
  session.frontends.forEach((ws) => safeSend(ws, payload));
}

function logLive(session: Session, payload: LiveLog, consoleTxt?: string) {
  if (consoleTxt) log(session.streamSid, consoleTxt);
  broadcast(session, payload);
}

function cleanup(session: Session, reason: string) {
  ['twilio', 'openai', 'frontends'].forEach((k: any) => {
    const conn = (session as any)[k];
    if (!conn) return;
    if (k === 'frontends') {
      (conn as Set<WebSocket>).forEach((w) =>
        w.readyState === WebSocket.OPEN && w.close()
      );
    } else if ((conn as WebSocket).readyState === WebSocket.OPEN) {
      (conn as WebSocket).close();
    }
  });
  clearInterval(session.heartbeat);
  sessionPool.delete(session.streamSid);
  logLive(session, { type: 'conversation.ended', sid: session.streamSid });
  log(session.streamSid, `session closed (${reason})`);
}

export function registerWsBridge(app: FastifyInstance) {
  const wssMedia = new WebSocketServer({
    noServer: true,
      handleProtocols: (protocols) =>
      protocols.has('audio') ? 'audio' : false,
  });
  const wssLogs = new WebSocketServer({ noServer: true });

  wssMedia.on('connection', (ws, req) => {
    const sid =
      typeof req.headers['x-twilio-callsid'] === 'string'
        ? req.headers['x-twilio-callsid']
        : String(Date.now());
    const session: Session = {
      twilio: ws,
      state: 'IDLE',
      streamSid: sid,
      buffer: [],
      heartbeat: setInterval(() => {
        safeSend(session.twilio, { event: 'ping' });
        safeSend(session.openai, { type: 'ping' });
      }, 20000),
      frontends: new Set(
        [...wssLogs.clients].filter((c: any) => c['watchAll'])
      )
    };
    sessionPool.set(sid, session);

    ws.on('message', (d) => handleTwilio(session, d));
    ws.on('close', () => cleanup(session, 'twilio closed'));
    ws.on('error', () => cleanup(session, 'twilio error'));
  });

  wssLogs.on('connection', (ws, req) => {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const sid = url.searchParams.get('sid') || '*';
    const sess = sessionPool.get(sid);
    if (sess) sess.frontends.add(ws);

    ws.on('close', () => {
      sessionPool.forEach((s) => s.frontends.delete(ws));
    });
  });

  app.server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    if (url.pathname === '/media-stream') {
      wssMedia.handleUpgrade(req, socket, head, (ws) =>
        wssMedia.emit('connection', ws, req)
      );
    } else if (url.pathname === '/logs') {
      wssLogs.handleUpgrade(req, socket, head, (ws) =>
        wssLogs.emit('connection', ws, req)
      );
    } else {
      socket.destroy();
    }
  });

  app.get('/media-stream', (_, r) => r.code(400).send('WebSocket only'));
  app.get('/logs', (_, r) => r.code(400).send('WebSocket only'));
}

function handleTwilio(session: Session, raw: RawData) {
  let m: any;
  try {
    m = JSON.parse(raw.toString());
  } catch {
    return;
  }
  switch (m.event) {
    case 'start':
      session.streamSid = m.start.streamSid;
      session.state = 'LISTENING';
      session.latestMediaTs = 0;
      openOpenAI(session);
      logLive(session, { type: 'conversation.started', sid: session.streamSid });
      break;
    case 'media':
      session.latestMediaTs = m.media.timestamp;
      const append = {
        type: 'input_audio_buffer.append',
        audio: m.media.payload
      };
      if (session.openai?.readyState === WebSocket.OPEN)
        session.openai.send(JSON.stringify(append));
      else session.buffer.push(Buffer.from(JSON.stringify(append)));
      break;
    case 'stop':
      if (session.state !== 'LISTENING') return;
      session.state = 'RESPONDING';
      commitAudio(session);
      break;
  }
}

function openOpenAI(session: Session) {
  if (session.openai) return;
  const ws = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${currentModel}`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    }
  );
  session.openai = ws;
  ws.on('open', () => {
    safeSend(ws, createSessionUpdate());
    session.buffer.forEach((b) => ws.send(b));
    session.buffer.length = 0;
  });
  ws.on('message', (d) => handleOpenAI(session, d));
  ws.on('close', () => cleanup(session, 'openai closed'));
  ws.on('error', () => cleanup(session, 'openai error'));
}

function commitAudio(session: Session) {
  if (!session.openai) return;
  safeSend(session.openai, { type: 'input_audio_buffer.commit' });
  const killer = setTimeout(() => {
    if (session.openai?.readyState === WebSocket.OPEN) session.openai.close();
  }, RESPONSE_TIMEOUT_MS);
  session.openai.once('message', () => clearTimeout(killer));
}

function handleOpenAI(session: Session, raw: RawData) {
  let ev: any;
  try {
    ev = JSON.parse(raw.toString());
  } catch {
    return;
  }
  broadcast(session, ev);
  switch (ev.type) {
    case 'conversation.item.input_audio_transcription.completed':
      if (ev.transcription?.text)
        logLive(
          session,
          { type: 'user', sid: session.streamSid, text: ev.transcription.text },
          `[User] ${ev.transcription.text}`
        );
      break;
    case 'input_audio_buffer.speech_started':
      handleTruncation(session);
      break;
    case 'response.audio.delta':
      forwardAudioDelta(session, ev);
      break;
    case 'response.output_item.done':
      if (ev.item?.type === 'function_call') handleFunctionCall(session, ev.item);
      break;
    case 'response.done':
      finishTurn(session, ev);
      break;
  }
}

function forwardAudioDelta(session: Session, ev: any) {
  if (!session.twilio || !session.streamSid) return;
  if (!session.responseStartMs)
    session.responseStartMs = session.latestMediaTs;
  if (ev.item_id) session.lastAssistantItem = ev.item_id;
  safeSend(session.twilio, {
    event: 'media',
    streamSid: session.streamSid,
    media: { payload: ev.delta }
  });
  safeSend(session.twilio, { event: 'mark', streamSid: session.streamSid });
}

function finishTurn(session: Session, ev: any) {
  const agent =
    ev.response?.output?.[0]?.content?.find((c: any) => c.transcript)
      ?.transcript;
  if (agent) {
    const rt = Date.now() - (session.responseStartMs ?? Date.now());
    logLive(
      session,
      { type: 'agent', sid: session.streamSid, text: agent, thinking_ms: rt },
      `[Agent] ${agent} (${rt}ms)`
    );
  }
  session.state = 'LISTENING';
  session.responseStartMs = undefined;
  safeSend(session.openai, { type: 'input_audio_buffer.reset' });
}

function handleTruncation(session: Session) {
  if (
    !session.lastAssistantItem ||
    session.responseStartMs === undefined ||
    !session.openai
  )
    return;
  const elapsed =
    (session.latestMediaTs || 0) - (session.responseStartMs || 0);
  const audio_end_ms = elapsed > 0 ? elapsed : 0;
  safeSend(session.openai, {
    type: 'conversation.item.truncate',
    item_id: session.lastAssistantItem,
    content_index: 0,
    audio_end_ms
  });
  safeSend(session.twilio, { event: 'clear', streamSid: session.streamSid });
  session.lastAssistantItem = undefined;
}

async function handleFunctionCall(session: Session, item: any) {
  const def = functions.find((f) => f.schema.name === item.name);
  if (!def) return;
  let args: any;
  try {
    args = JSON.parse(item.arguments);
  } catch {
    return;
  }
  let output;
  try {
    output = await def.handler(args);
  } catch (e: any) {
    output = { error: e.message };
  }
  safeSend(session.openai, {
    type: 'conversation.item.create',
    item: {
      type: 'function_call_output',
      call_id: item.call_id,
      output: JSON.stringify(output)
    }
  });
  safeSend(session.openai, { type: 'response.create' });
}
