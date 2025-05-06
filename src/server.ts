import fastify from 'fastify';
import formbody from '@fastify/formbody';
import websocket from '@fastify/websocket';
import { registerWsBridge } from './wsBridge';
import { PORT } from './config';

const app = fastify({ logger: false });

(async () => {
  await app.register(formbody);
  await app.register(websocket);
})();

app.get('/healthz', () => ({ status: 'alive' }));
app.get('/', () => ({ message: 'running' }));

// Twilio entry-point ------------------------------------------
app.all('/incoming-call', (req, reply) => {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <!-- убрали voice="alloy", пользуемся дефолтным голосом Twilio -->
  <Say>Hi, you have called Bart's Automotive Centre.</Say>
  <Connect>
    <Stream url="wss://${req.headers.host}/media-stream" />
  </Connect>
</Response>`;
  reply.type('text/xml').send(twiml);
});

// WebSocket bridge --------------------------------------------
registerWsBridge(app);

// start --------------------------------------------------------
app.listen({ port: PORT, host: '0.0.0.0' }, err => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`Server listening on ${PORT}`);
});
