require('dotenv').config();

const express = require('express');
const http = require('http');
const cors = require('cors');
const { setupWebsocket } = require('./websocket');

// Use a fixed port so the frontend knows where to connect during local development.
const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;

const app = express();

// Allow the Next.js dev server to reach this API. Adjust origins when deploying.
app.use(cors({ origin: 'http://localhost:3000' }));

// Lightweight health check so we can quickly verify the HTTP layer is alive.
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

const server = http.createServer(app);

// Attach the WebSocket server to the same HTTP server so both share port 3001.
setupWebsocket(server);

server.listen(PORT, () => {
  console.log(`[http] Listening on http://localhost:${PORT}`);
});
