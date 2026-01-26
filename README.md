# Sales Voice Agent

Foundation setup for the real-time sales training voice agent.

## What is included
- Backend: Express HTTP server on port 3001 with WebSocket (ws) attached and CORS enabled.
- Frontend: Next.js App Router page that connects to the WebSocket and shows connection status.
- Health check: `GET /health` on the backend for quick verification.
- Lightweight ping/pong between frontend and backend to keep the connection warm and log round-trip time.
- Audio pipeline design (see AUDIO_PIPELINE.md) with placeholder message types; no audio implemented yet.
 - User mic capture and streaming (frontend → backend only): AudioWorklet-based PCM16 chunks sent over WebSocket.

## Prerequisites
- Node.js 18+
- Two terminals (one for backend, one for frontend)

## Setup and run
1. **Backend**
   ```bash
   cd backend
   npm install
   npm run dev
   ```
   - Expected logs: `[http] Listening on http://localhost:3001` and `[ws] Client connected...` when the frontend loads.

2. **Frontend**
   ```bash
   cd frontend
   npm install
   npm run dev
   ```
   - Open http://localhost:3000 in the browser.
   - The page should move from "Connecting..." to "Connected to agent" once the WebSocket handshake completes.

## Notes
- The backend sends a simple `agent_connected` JSON message on each WebSocket connection.
- Future work (not implemented here): audio capture, speech-to-text, AI responses, reconnection/backoff strategies.
