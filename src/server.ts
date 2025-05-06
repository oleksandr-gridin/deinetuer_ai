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

app.all('/incoming-call', (req, reply) => {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${req.headers.host}/media-stream" />
  </Connect>
</Response>`;
  reply.type('text/xml').send(twiml);
});

app.setErrorHandler((err, _req, reply) => {
  console.error('UNCAUGHT FASTIFY ERROR:', err);
  reply.code(500).send();
});

registerWsBridge(app);

app.listen({ port: PORT, host: '0.0.0.0' }, err => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`Server listening on ${PORT}`);
});
