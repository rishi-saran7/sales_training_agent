# Real-Time Audio Pipeline (Design Only)

This document outlines how audio will move through the system in future phases. No audio is implemented yet.

## Message contract (WebSocket)
- `user.audio.start` — user begins speaking; future payload: capture format metadata and utterance id.
- `user.audio.chunk` — PCM audio slice from the user; future payload: sequence number, timestamp, raw/encoded bytes.
- `user.audio.end` — user stops speaking; future payload: final chunk marker and utterance id.
- `agent.audio.chunk` — agent TTS audio slice streaming back; future payload: sequence, timestamp, audio bytes.
- `agent.audio.end` — agent TTS stream finished for this turn; future payload: utterance id, optional markers.
- `agent.interrupt` — signal to stop current agent playback (barge-in support).

## Audio format assumptions (to be validated)
- PCM, 16-bit linear, mono, little endian.
- Sample rate: 16 kHz (common for telephony/STT). Keep consistent end-to-end.
- Chunks represent ~20–40 ms of audio; size depends on chosen encoding (raw PCM vs. compressed). Raw PCM at 16 kHz mono, 16-bit is 32 KB/s; a 20 ms chunk is ~640 bytes.

## Chunking strategy
- Time-based slicing at the edge (browser) before send: target 20–40 ms per chunk to balance latency and overhead.
- Each chunk should include: `utteranceId`, `sequence`, `timestamp`, and the audio payload (future field).
- Backpressure handling will be added later if socket congestion is observed.

## Turn-taking rules (future behavior)
- Only one party speaks at a time in steady state.
- When the user is speaking (`user.audio.*` active), agent TTS should pause/stop to allow barge-in.
- Agent replies (`agent.audio.*`) stream only after user turn completes or an interrupt is triggered.

## Barge-in behavior (future behavior)
- If the user starts talking while the agent is mid-reply, the frontend will send `agent.interrupt`.
- Backend will stop any active TTS stream and drop/flush remaining `agent.audio.chunk` messages for that utterance.
- STT/LLM pipeline should start handling the new user utterance immediately after interrupt.

## Processing pipeline (future integration points)
- **Frontend (browser)**
  - Mic capture (Web Audio/MediaStream) → slice into PCM chunks → send `user.audio.start`, then repeating `user.audio.chunk`, then `user.audio.end`.
  - Playback: receive `agent.audio.chunk` → enqueue to audio output; on `agent.audio.end`, flush/stop.
  - Barge-in: on user speech start, send `agent.interrupt` before streaming new user audio.
- **Backend (Node/Express/ws)**
  - Inbound `user.audio.*`: forward PCM to streaming STT provider; collect partial/final transcripts.
  - STT partials/finals → feed LLM for dialog decisions; generate agent text.
  - Agent text → streaming TTS → emit `agent.audio.chunk` and `agent.audio.end` back to the client.
  - On `agent.interrupt`: halt current TTS stream and notify playback to stop.

## What is explicitly NOT implemented yet
- Mic access, MediaRecorder/Web Audio usage, or any audio payloads.
- STT/LLM/TTS calls or buffering logic.
- Reconnection or backpressure handling.

## Next steps when implementing
1. Confirm audio format and end-to-end sample rate.
2. Add mic capture and chunking in the frontend; attach metadata (utterance id, sequence, timestamps).
3. Wire backend to streaming STT and stream TTS results back as `agent.audio.chunk`.
4. Implement barge-in: detect user speech during agent reply, send `agent.interrupt`, stop TTS playback.
