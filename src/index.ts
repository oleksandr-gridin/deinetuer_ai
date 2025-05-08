import Fastify from 'fastify';
import { setModel, currentModel, setVoice, currentVoice, setWebSearch, webSearchEnabled, voiceType } from './config.js';
import { registerWsBridge } from './wsBridge.js';
import formbody from '@fastify/formbody';


const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;

const app = Fastify({ logger: true });
app.register(formbody);

app.get('/healthz', async (request, reply) => {
  reply.send({ status: 'ok', message: `Server is running` });
});

app.all('/incoming-call', async (request, reply) => {
  const host = request.headers['host'];
  const wsUrl = `wss://${host}/media-stream`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
<Say>Hi, you have called Deine Tür. I am AI Assistent Dory. How can we help?</Say>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`;
  reply.type('text/xml').send(twiml);
});

registerWsBridge(app);

// PATCH /model
app.patch('/model', async (request, reply) => {
  const { model } = request.body as { model: string };
  if (!['gpt-4o-realtime-preview-2024-10-01', 'gpt-4o-mini-realtime-preview-2024-10-01'].includes(model)) {
    return reply.code(400).send({ error: 'Invalid model' });
  }
  setModel(model)
  reply.send({ status: 'ok', model: currentModel });
});

// PATCH /voice
app.patch('/voice', async (request, reply) => {
  const { voice } = request.body as { voice: voiceType };
  if (!['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'].includes(voice)) {
    return reply.code(400).send({ error: 'Invalid voice' });
  }
  setVoice(voice)
  reply.send({ status: 'ok', voice: currentVoice });
});

// PATCH /websearch
app.patch('/websearch', async (request, reply) => {
  const { enabled } = request.body as { enabled: boolean };
  if (typeof enabled !== 'boolean') {
    return reply.code(400).send({ error: 'enabled must be boolean' });
  }
  setWebSearch(enabled);
  reply.send({ status: 'ok', webSearchEnabled });
});

app.listen({ port: PORT, host: '0.0.0.0' }, (err, address) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  app.log.info(`Server listening at ${address}`);
});


