const { WebSocketServer } = require('ws');
const { DeepgramClient } = require('./deepgramClient');
const { LlmClient } = require('./llmClient');
const { TtsClient } = require('./ttsClient');

const SILENCE_TIMEOUT_MS = 2000; // Wait 2 seconds after last speech to trigger LLM response.

// Message types keep the contract explicit and easy to extend later.
const MESSAGE_TYPES = {
  AGENT_CONNECTED: 'agent_connected',
  PING: 'ping',
  PONG: 'pong',
  USER_AUDIO_START: 'user.audio.start',
  USER_AUDIO_CHUNK: 'user.audio.chunk',
  USER_AUDIO_END: 'user.audio.end',
  AGENT_AUDIO_START: 'agent.audio.start',
  AGENT_AUDIO_CHUNK: 'agent.audio.chunk',
  AGENT_AUDIO_END: 'agent.audio.end',
  AGENT_INTERRUPT: 'agent.interrupt',
  STT_PARTIAL: 'stt.partial',
  STT_FINAL: 'stt.final',
  AGENT_TEXT: 'agent.text',
  CALL_END: 'call.end',
  CALL_FEEDBACK: 'call.feedback',
};

const CUSTOMER_PERSONA_PROMPT =
  'You are a realistic customer in a sales training simulation.\n' +
  'You are skeptical, price-conscious, and time-limited.\n' +
  'IMPORTANT: Do NOT make assumptions about vague or unclear statements.\n' +
  'When the salesperson is unclear, vague, or rambling, respond with:\n' +
  '- "I didn\'t catch that. Can you repeat?"\n' +
  '- "I\'m not sure what you mean. Can you be more specific?"\n' +
  '- "Sorry, can you clarify what you\'re offering?"\n' +
  '- "I need you to be clearer about..."\n' +
  'Ask direct follow-up questions when information is missing.\n' +
  'Challenge vague pitches by asking for concrete details.\n' +
  'Your goal is to train the salesperson to communicate clearly and specifically.';

// Track basic stream state per connection so we can log duration and sizes.
function createStreamState() {
  return {
    active: false,
    sampleRate: null,
    totalSamples: 0,
    startedAt: null,
  };
}

// Simple helper to avoid crashing on malformed JSON payloads.
function safeParseJson(data) {
  try {
    return JSON.parse(data);
  } catch (error) {
    return null;
  }
}

function setupWebsocket(server) {
  // Share the existing HTTP server so we only manage a single port.
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws, req) => {
    const clientAddress = req.socket.remoteAddress;
    console.log(`[ws] Client connected${clientAddress ? ` from ${clientAddress}` : ''}`);

    const streamState = createStreamState();
    let deepgramClient = null;
    const llmClient = new LlmClient();
    const ttsClient = new TtsClient(process.env.DEEPGRAM_API_KEY || '');
    const conversation = [
      {
        role: 'system',
        content: CUSTOMER_PERSONA_PROMPT,
      },
    ];
    let accumulatedTranscript = '';
    let silenceTimer = null;
    let callStartTime = Date.now();

    async function handleFinalTranscript(transcriptText) {
      const text = (transcriptText || '').trim();
      if (!text) return;

      conversation.push({ role: 'user', content: text });
      const turnCount = Math.floor((conversation.length - 1) / 2);
      console.log(`[llm] Turn ${turnCount} user transcript: "${text}"`);

      try {
        const responseText = await llmClient.generate(conversation);
        const safeResponse = responseText || '...';
        conversation.push({ role: 'assistant', content: safeResponse });
        console.log(`[llm] Turn ${turnCount} customer reply: "${safeResponse}"`);

        ws.send(
          JSON.stringify({
            type: MESSAGE_TYPES.AGENT_TEXT,
            text: safeResponse,
          })
        );

        // TODO: Stream LLM tokens directly to TTS for lower latency once streaming is enabled.
        // Generate TTS audio for the agent response.
        try {
          console.log('[tts] Starting speech generation...');
          ws.send(JSON.stringify({ type: MESSAGE_TYPES.AGENT_AUDIO_START }));

          const audioBuffer = await ttsClient.generateSpeech(safeResponse, {
            encoding: 'linear16',
            sampleRate: 16000,
          });

          // Split audio into chunks for streaming-like experience.
          const chunkSize = 4096; // ~256ms chunks at 16kHz PCM16
          let offset = 0;
          let chunkCount = 0;
          while (offset < audioBuffer.length) {
            const chunk = audioBuffer.slice(offset, offset + chunkSize);
            ws.send(
              JSON.stringify({
                type: MESSAGE_TYPES.AGENT_AUDIO_CHUNK,
                payload: chunk.toString('base64'),
                format: 'pcm16',
                sampleRate: 16000,
              })
            );
            offset += chunkSize;
            chunkCount++;
          }

          ws.send(JSON.stringify({ type: MESSAGE_TYPES.AGENT_AUDIO_END }));
          console.log(`[tts] Sent ${chunkCount} audio chunks`);
        } catch (ttsErr) {
          console.error('[tts] Failed to generate speech:', ttsErr.message || ttsErr);
          ws.send(JSON.stringify({ type: MESSAGE_TYPES.AGENT_AUDIO_END }));
        }
      } catch (err) {
        console.error('[llm] Failed to generate response:', err.message || err);
        ws.send(
          JSON.stringify({
            type: MESSAGE_TYPES.AGENT_TEXT,
            text: 'The customer is temporarily unavailable. Please try again.',
          })
        );
      }
    }
    // TODO: Add end-of-call feedback summarization once call termination flow exists.

    async function generateCallFeedback() {
      const callDurationMs = Date.now() - callStartTime;
      const callDurationMin = Math.round(callDurationMs / 60000);
      const turnCount = Math.floor((conversation.length - 1) / 2);

      console.log(`[feedback] Generating feedback for ${turnCount} turns, ${callDurationMin} min call`);

      // Extract conversation transcript for analysis.
      const transcriptLines = [];
      for (let i = 1; i < conversation.length; i++) {
        const msg = conversation[i];
        const speaker = msg.role === 'user' ? 'Trainee' : 'Customer';
        transcriptLines.push(`${speaker}: ${msg.content}`);
      }
      const transcript = transcriptLines.join('\n');

      const feedbackPrompt = `You are a sales coach evaluating a sales training call.
Analyze the trainee's performance objectively and constructively.

Call transcript:
${transcript}

Provide feedback in STRICT JSON format with this structure:
{
  "overall_score": <number 0-10>,
  "strengths": [<string>],
  "weaknesses": [<string>],
  "objection_handling": <number 0-10>,
  "communication_clarity": <number 0-10>,
  "confidence": <number 0-10>,
  "missed_opportunities": [<string>],
  "actionable_suggestions": [<string>]
}

Return ONLY valid JSON. Do not include any explanatory text.`;

      try {
        const feedbackText = await llmClient.generate([
          { role: 'system', content: feedbackPrompt },
        ]);

        // Parse and validate JSON.
        let feedbackData;
        try {
          feedbackData = JSON.parse(feedbackText);
        } catch (parseErr) {
          console.error('[feedback] Failed to parse LLM JSON response:', parseErr);
          throw new Error('LLM returned invalid JSON');
        }

        // Validate required fields.
        const requiredFields = [
          'overall_score',
          'strengths',
          'weaknesses',
          'objection_handling',
          'communication_clarity',
          'confidence',
          'missed_opportunities',
          'actionable_suggestions',
        ];
        for (const field of requiredFields) {
          if (!(field in feedbackData)) {
            throw new Error(`Missing required field: ${field}`);
          }
        }

        console.log('[feedback] Successfully generated feedback');
        console.log(`[feedback] Overall score: ${feedbackData.overall_score}/10`);

        ws.send(
          JSON.stringify({
            type: MESSAGE_TYPES.CALL_FEEDBACK,
            payload: feedbackData,
            callDurationMs,
            turnCount,
          })
        );
      } catch (err) {
        console.error('[feedback] Failed to generate feedback:', err.message || err);
        ws.send(
          JSON.stringify({
            type: MESSAGE_TYPES.CALL_FEEDBACK,
            payload: {
              overall_score: 0,
              strengths: [],
              weaknesses: ['Unable to generate feedback due to technical error.'],
              objection_handling: 0,
              communication_clarity: 0,
              confidence: 0,
              missed_opportunities: [],
              actionable_suggestions: ['Please try ending the call again.'],
            },
            callDurationMs,
            turnCount,
            error: true,
          })
        );
      }
    }
    // TODO: Persist feedback to database for analytics and historical tracking.
    // TODO: Add trainer dashboard to compare trainee performance over time.

    // Initial handshake letting the frontend know the agent endpoint is live.
    ws.send(
      JSON.stringify({
        type: MESSAGE_TYPES.AGENT_CONNECTED,
        message: 'Agent connection established',
      })
    );

    // Send a periodic ping so the client can reply with a pong and we can measure latency.
    const pingIntervalMs = 5000; // Chosen for low load while keeping the link warm.
    const intervalId = setInterval(() => {
      const timestamp = Date.now();
      ws.send(
        JSON.stringify({
          type: MESSAGE_TYPES.PING,
          timestamp,
        })
      );
    }, pingIntervalMs);

    ws.on('close', () => {
      clearInterval(intervalId);
      // Ensure Deepgram session is cleaned up when the client disconnects.
      if (deepgramClient) {
        deepgramClient.close();
        deepgramClient = null;
      }
      console.log(`[ws] Client disconnected${clientAddress ? ` from ${clientAddress}` : ''}`);
    });

    // TODO: In later phases, route incoming trainee audio/text to AI logic.
    ws.on('message', (data) => {
      const parsed = safeParseJson(data);
      if (!parsed || typeof parsed.type !== 'string') {
        console.warn('[ws] Ignoring malformed message');
        return;
      }

      switch (parsed.type) {
        case MESSAGE_TYPES.PONG: {
          // Compute round-trip latency using the original ping timestamp from the client.
          if (typeof parsed.timestamp === 'number') {
            const latencyMs = Date.now() - parsed.timestamp;
            console.log(`[ws] Pong received. RTT ~${latencyMs} ms`);
          } else {
            console.log('[ws] Pong received (no timestamp provided)');
          }
          break;
        }
        case MESSAGE_TYPES.USER_AUDIO_START: {
          streamState.active = true;
          streamState.sampleRate = typeof parsed.sampleRate === 'number' ? parsed.sampleRate : null;
          streamState.totalSamples = 0;
          streamState.startedAt = Date.now();
          console.log('[ws] User audio start received');

          // Establish Deepgram realtime session for this turn.
          const apiKey = process.env.DEEPGRAM_API_KEY;
          if (!apiKey) {
            console.error('[ws] DEEPGRAM_API_KEY not set; cannot start Deepgram session');
            ws.send(
              JSON.stringify({
                type: 'error',
                message: 'DEEPGRAM_API_KEY not configured',
              })
            );
            break;
          }

          // Clean any previous session for safety.
          if (deepgramClient) {
            deepgramClient.close();
            deepgramClient = null;
          }

          deepgramClient = new DeepgramClient(apiKey, (eventType, data) => {
            switch (eventType) {
              case 'stt.partial': {
                ws.send(
                  JSON.stringify({
                    type: MESSAGE_TYPES.STT_PARTIAL,
                    text: data.text,
                  })
                );
                break;
              }
              case 'stt.final': {
                ws.send(
                  JSON.stringify({
                    type: MESSAGE_TYPES.STT_FINAL,
                    text: data.text,
                  })
                );
                // Accumulate transcript and reset silence timer.
                const cleaned = (data.text || '').trim();
                if (cleaned) {
                  accumulatedTranscript = accumulatedTranscript ? `${accumulatedTranscript} ${cleaned}` : cleaned;
                }
                // Clear previous timer and start new 2-second countdown.
                if (silenceTimer) clearTimeout(silenceTimer);
                silenceTimer = setTimeout(() => {
                  silenceTimer = null;
                  if (accumulatedTranscript) {
                    const toSend = accumulatedTranscript;
                    accumulatedTranscript = '';
                    handleFinalTranscript(toSend);
                  }
                }, SILENCE_TIMEOUT_MS);
                break;
              }
              default:
                break;
            }
          });

          deepgramClient
            .connect()
            .then(() => {
              console.log('[ws] Deepgram streaming started');
            })
            .catch((err) => {
              console.error('[ws] Failed to connect to Deepgram:', err);
              ws.send(
                JSON.stringify({
                  type: 'error',
                  message: 'Failed to connect to Deepgram',
                })
              );
            });
          break;
        }
        case MESSAGE_TYPES.USER_AUDIO_CHUNK: {
          if (!streamState.active) {
            console.warn('[ws] Received audio chunk while no stream is active');
            break;
          }

          if (typeof parsed.payload !== 'string' || parsed.payload.length === 0) {
            console.warn('[ws] Audio chunk missing payload');
            break;
          }

          try {
            const buffer = Buffer.from(parsed.payload, 'base64');
            const bytes = buffer.length;
            const samples = Math.floor(bytes / 2); // PCM16 = 2 bytes per sample
            streamState.totalSamples += samples;
            const chunkDurationMs = streamState.sampleRate
              ? Math.round((samples / streamState.sampleRate) * 1000)
              : 'unknown';

            console.log(`[ws] Audio chunk received: ${bytes} bytes (~${chunkDurationMs} ms)`);

            // Forward audio to Deepgram for transcription.
            if (deepgramClient && deepgramClient.connected) {
              deepgramClient.sendAudio(buffer);
            }
          } catch (err) {
            console.warn('[ws] Failed to decode audio chunk payload');
          }
          break;
        }
        case MESSAGE_TYPES.USER_AUDIO_END: {
          if (!streamState.active) {
            console.warn('[ws] Received audio end while no stream is active');
            break;
          }

          const elapsedMs = streamState.startedAt ? Date.now() - streamState.startedAt : 0;
          const approxDurationMs = streamState.sampleRate
            ? Math.round((streamState.totalSamples / streamState.sampleRate) * 1000)
            : null;

          console.log(
            `[ws] User audio end received. Approx stream duration: ${
              approxDurationMs !== null ? `${approxDurationMs} ms` : 'unknown'
            } (wall clock ${elapsedMs} ms)`
          );

          // Close Deepgram stream after user finishes speaking.
          if (deepgramClient && deepgramClient.connected) {
            deepgramClient.close();
            deepgramClient = null;
          }

          // Clear silence timer and flush accumulated transcript immediately.
          if (silenceTimer) {
            clearTimeout(silenceTimer);
            silenceTimer = null;
          }
          if (accumulatedTranscript) {
            const toSend = accumulatedTranscript;
            accumulatedTranscript = '';
            handleFinalTranscript(toSend);
          }

          // Reset state for the next turn.
          const reset = createStreamState();
          streamState.active = reset.active;
          streamState.sampleRate = reset.sampleRate;
          streamState.totalSamples = reset.totalSamples;
          streamState.startedAt = reset.startedAt;
          break;
        }
        case MESSAGE_TYPES.AGENT_AUDIO_CHUNK: {
          // TODO: This will originate from TTS output; for now just log.
          console.log('[ws] Agent audio chunk received (placeholder)');
          break;
        }
        case MESSAGE_TYPES.AGENT_AUDIO_END: {
          console.log('[ws] Agent audio end received (placeholder)');
          break;
        }
        case MESSAGE_TYPES.AGENT_INTERRUPT: {
          // TODO: Trigger barge-in behavior to halt agent TTS playback.
          console.log('[ws] Agent interrupt received (placeholder)');
          break;
        }
        case MESSAGE_TYPES.AGENT_TEXT: {
          // Should not be sent from client; log unexpected inbound traffic.
          console.log('[ws] Unexpected agent.text from client');
          break;
        }
        case MESSAGE_TYPES.CALL_END: {
          console.log('[ws] Call end received, generating feedback...');
          generateCallFeedback();
          break;
        }
        default: {
          console.log(`[ws] Received message: ${data}`);
        }
      }
    });
  });

  return wss;
}

module.exports = { setupWebsocket, MESSAGE_TYPES };
