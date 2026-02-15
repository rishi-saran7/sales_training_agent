const { WebSocketServer } = require('ws');
const { randomUUID } = require('crypto');
const { DeepgramClient } = require('./deepgramClient');
const { LlmClient } = require('./llmClient');
const { TtsClient } = require('./ttsClient');
const { supabase } = require('./lib/supabase');

const SILENCE_TIMEOUT_MS = 3000; // Wait 3 seconds after last speech to trigger LLM response.
const COACH_HINT_COOLDOWN_MS = 10000;
const COACHING_SYSTEM_PROMPT =
  'You are a live sales coach.\n' +
  'Provide a short, actionable suggestion (1 sentence max).\n' +
  'Only suggest improvements.\n' +
  'If no suggestion is needed, return null.';

// Message types keep the contract explicit and easy to extend later.
const MESSAGE_TYPES = {
  AGENT_CONNECTED: 'agent_connected',
  AUTH: 'auth',
  PING: 'ping',
  PONG: 'pong',
  SCENARIO_SELECT: 'scenario.select',
  USER_AUDIO_START: 'user.audio.start',
  USER_AUDIO_CHUNK: 'user.audio.chunk',
  USER_AUDIO_END: 'user.audio.end',
  USER_INTERRUPT: 'user.interrupt',
  AGENT_AUDIO_START: 'agent.audio.start',
  AGENT_AUDIO_CHUNK: 'agent.audio.chunk',
  AGENT_AUDIO_END: 'agent.audio.end',
  AGENT_INTERRUPT: 'agent.interrupt',
  STT_PARTIAL: 'stt.partial',
  STT_FINAL: 'stt.final',
  AGENT_TEXT: 'agent.text',
  COACH_HINT: 'coach.hint',
  CALL_END: 'call.end',
  CALL_RESET: 'call.reset',
  CALL_FEEDBACK: 'call.feedback',
};

const BASE_CUSTOMER_PROMPT =
  'You are a realistic customer in a sales training simulation.\n' +
  'You are the CUSTOMER. The trainee is the salesperson.\n' +
  'Never act like the agent or support rep. Do not say things like "How can I help you?" or "I can assist you."\n' +
  'Never pitch, offer services, or describe products as if they are yours.\n' +
  'If the trainee is vague (e.g., "services"), ask what they mean and request specifics.\n' +
  'IMPORTANT: Do NOT make assumptions about vague or unclear statements.\n' +
  'When the salesperson is unclear, vague, or rambling, respond with:\n' +
  '- "I didn\'t catch that. Can you repeat?"\n' +
  '- "I\'m not sure what you mean. Can you be more specific?"\n' +
  '- "Sorry, can you clarify what you\'re offering?"\n' +
  '- "I need you to be clearer about..."\n' +
  'If you need details, ask as a customer (e.g., "What does that include?", "How much does it cost?", "What is the timeline?").\n' +
  'Ask direct follow-up questions when information is missing.\n' +
  'Challenge vague pitches by asking for concrete details.\n' +
  'Your goal is to train the salesperson to communicate clearly and specifically.';

const SCENARIOS = [
  {
    id: 'price_sensitive_small_business',
    name: 'Price-Sensitive Small Business',
    description: 'Owner/operator focused on cost, quick ROI, and limited budget.',
    systemPrompt:
      BASE_CUSTOMER_PROMPT +
      '\nYou are a small business owner focused on keeping costs low and seeing quick ROI.\n' +
      'You are price-sensitive, ask about discounts, and push back on premium tiers.\n' +
      'FIRST RESPONSE MUST reference budget sensitivity and ask for pricing or discounts.',
  },
  {
    id: 'enterprise_procurement_officer',
    name: 'Enterprise Procurement Officer',
    description: 'Procurement lead focused on compliance, vendor risk, and contracts.',
    systemPrompt:
      BASE_CUSTOMER_PROMPT +
      '\nYou are an enterprise procurement officer evaluating vendors.\n' +
      'You care about compliance, SLAs, security, and procurement process details.\n' +
      'FIRST RESPONSE MUST ask about compliance, security, and procurement process requirements.',
  },
  {
    id: 'angry_existing_customer',
    name: 'Angry Existing Customer',
    description: 'Upset customer with a recent issue and low patience.',
    systemPrompt:
      BASE_CUSTOMER_PROMPT +
      '\nYou are an existing customer who is angry about a recent issue.\n' +
      'You are impatient, want accountability, and need a clear resolution plan.\n' +
      'FIRST RESPONSE MUST start with a complaint and urgency about the unresolved issue.',
  },
  {
    id: 'cold_uninterested_prospect',
    name: 'Cold Uninterested Prospect',
    description: 'Busy prospect with low interest and short attention span.',
    systemPrompt:
      BASE_CUSTOMER_PROMPT +
      '\nYou are a cold prospect with low interest and limited time.\n' +
      'You ask why this matters and try to end the call quickly unless it is compelling.\n' +
      'FIRST RESPONSE MUST signal low interest and time pressure.',
  },
];

const ROLE_COMPLIANCE_SUFFIX =
  '\nROLE COMPLIANCE (STRICT): You are the CUSTOMER. The trainee is the salesperson.\n' +
  'Do not act like an agent or support rep. Never say you can help, assist, resolve, or handle their issue.\n' +
  'Always respond as the customer with customer needs, concerns, and questions.';

const SCENARIO_MAP = SCENARIOS.reduce((acc, scenario) => {
  acc[scenario.id] = {
    ...scenario,
    systemPrompt: `${scenario.systemPrompt}${ROLE_COMPLIANCE_SUFFIX}`,
  };
  return acc;
}, {});

// TODO: Add scenario difficulty levels.
// TODO: Add industry-specific scripts.
// TODO: Support trainer-created custom scenarios.

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
    let conversation = [];
    let accumulatedTranscript = '';
    let silenceTimer = null;
    let callStartTime = Date.now();
    let sessionId = null;
    let scenarioLocked = false;
    let activeScenario = SCENARIO_MAP.price_sensitive_small_business;
    let llmInFlight = false;
    let pendingTranscript = '';
    let interrupted = false; // Barge-in flag: when true, stop sending agent audio chunks.
    let agentSpeakingState = false; // Track whether agent TTS is in progress.
    let ttsSessionId = 0; // Increment to invalidate in-flight chunk send loops.
    let interruptNotified = false; // Ensure we only notify interrupt once per utterance.
    let callEnded = false;
    let coachHintSentForTurn = false;
    let lastCoachHintAt = 0;
    let currentUserId = null;

    function resetConversationForScenario(scenario) {
      conversation = [
        {
          role: 'system',
          content: scenario.systemPrompt,
        },
      ];
      accumulatedTranscript = '';
    }

    function startCallWithScenario(scenario) {
      activeScenario = scenario;
      scenarioLocked = true;
      callEnded = false;
      coachHintSentForTurn = false;
      callStartTime = Date.now();
      sessionId = randomUUID();
      resetConversationForScenario(scenario);
      console.log(`[scenario] Call started under scenario: ${scenario.name}`);
    }

    // TODO: Add advanced scoring engine to enrich hint quality.
    // TODO: Add hint personalization based on trainee profile.
    // TODO: Tune hint frequency by difficulty level.
    async function generateCoachHint(latestText) {
      if (callEnded) return;
      if (!latestText) return;
      if (coachHintSentForTurn) return;

      const now = Date.now();
      if (now - lastCoachHintAt < COACH_HINT_COOLDOWN_MS) {
        console.log('[coach] Hint skipped (cooldown)');
        coachHintSentForTurn = true;
        return;
      }

      coachHintSentForTurn = true;
      lastCoachHintAt = now;

      const recentMessages = conversation
        .filter((msg) => msg.role !== 'system')
        .slice(-4)
        .map((msg) => `${msg.role === 'user' ? 'Trainee' : 'Customer'}: ${msg.content}`)
        .join('\n');

      const contextBlock = recentMessages || 'No prior messages.';
      const scenarioLabel = activeScenario ? activeScenario.name : 'Unknown';
      const coachPrompt =
        `Scenario: ${scenarioLabel}\n` +
        `Recent conversation:\n${contextBlock}\n\n` +
        `Latest trainee statement: "${latestText}"\n` +
        'Return one short suggestion or null.';

      try {
        const hintText = await llmClient.generate([
          { role: 'system', content: COACHING_SYSTEM_PROMPT },
          { role: 'user', content: coachPrompt },
        ]);

        const cleaned = (hintText || '').trim();
        if (!cleaned || /^null$/i.test(cleaned) || /^none$/i.test(cleaned)) {
          console.log('[coach] Hint skipped (none)');
          return;
        }

        ws.send(
          JSON.stringify({
            type: MESSAGE_TYPES.COACH_HINT,
            text: cleaned,
          })
        );
        console.log('[coach] Coaching hint generated');
      } catch (err) {
        console.log('[coach] Hint skipped (error)');
      }
    }

    resetConversationForScenario(activeScenario);

    async function handleFinalTranscript(transcriptText) {
      if (callEnded) return;
      const text = (transcriptText || '').trim();
      if (!text) return;

      conversation.push({ role: 'user', content: text });
      const turnCount = Math.floor((conversation.length - 1) / 2);
      console.log(`[llm] Turn ${turnCount} user transcript: "${text}"`);

      try {
        const responseText = await llmClient.generate(conversation);
        if (callEnded) return;
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
          if (callEnded) return;
          interrupted = false; // Reset barge-in flag before starting new utterance.
          interruptNotified = false;
          agentSpeakingState = true;
          const currentTtsSession = ++ttsSessionId;
          let ttsStarted = false;

          const audioBuffer = await ttsClient.generateSpeech(safeResponse, {
            encoding: 'linear16',
            sampleRate: 16000,
          });

          if (!audioBuffer || audioBuffer.length === 0) {
            console.warn('[tts] Generated empty audio buffer; skipping playback');
            agentSpeakingState = false;
            return;
          }

          ws.send(JSON.stringify({ type: MESSAGE_TYPES.AGENT_AUDIO_START }));
          ttsStarted = true;

          // Split audio into chunks for streaming-like experience.
          // Check interrupted flag before sending each chunk for barge-in support.
          const chunkSize = 4096; // ~256ms chunks at 16kHz PCM16
          let offset = 0;
          let chunkCount = 0;
          while (offset < audioBuffer.length) {
            // Barge-in: stop sending chunks immediately if user interrupted.
            if (callEnded || interrupted || currentTtsSession !== ttsSessionId) {
              console.log(`[tts] Barge-in: cancelled remaining ${Math.ceil((audioBuffer.length - offset) / chunkSize)} chunks`);
              break;
            }
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
            // Yield to event loop so user.interrupt can be processed immediately.
            await new Promise((resolve) => setTimeout(resolve, 0));
          }

          agentSpeakingState = false;
          if (callEnded || interrupted || currentTtsSession !== ttsSessionId) {
            // Notify frontend that agent speech was interrupted.
            if (!interruptNotified) {
              ws.send(JSON.stringify({ type: MESSAGE_TYPES.AGENT_INTERRUPT }));
              interruptNotified = true;
            }
            console.log(`[tts] Agent speech interrupted after ${chunkCount} chunks`);
          } else if (ttsStarted) {
            ws.send(JSON.stringify({ type: MESSAGE_TYPES.AGENT_AUDIO_END }));
            console.log(`[tts] Sent ${chunkCount} audio chunks`);
          }
        } catch (ttsErr) {
          console.error('[tts] Failed to generate speech:', ttsErr.message || ttsErr);
          agentSpeakingState = false;
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
      } finally {
        llmInFlight = false;
        if (!callEnded && pendingTranscript) {
          const nextTranscript = pendingTranscript;
          pendingTranscript = '';
          // Process queued transcript after current turn finishes.
          setTimeout(() => {
            queueTranscript(nextTranscript);
          }, 0);
        }
      }
    }

    function queueTranscript(text) {
      const cleaned = (text || '').trim();
      if (!cleaned) return;
      if (llmInFlight) {
        pendingTranscript = pendingTranscript ? `${pendingTranscript} ${cleaned}` : cleaned;
        return;
      }
      llmInFlight = true;
      handleFinalTranscript(cleaned);
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

      const feedbackPrompt =
        'You are a sales coach evaluating a sales training call.\n' +
        'Analyze the trainee\'s performance objectively and constructively.\n' +
        `\nScenario: ${activeScenario ? activeScenario.name : 'Unknown'}\n\n` +
        `Call transcript:\n${transcript}\n\n` +
        'Provide feedback in STRICT JSON format with this structure:\n' +
        '{\n' +
        '  "overall_score": <number 0-10>,\n' +
        '  "strengths": [<string>],\n' +
        '  "weaknesses": [<string>],\n' +
        '  "objection_handling": <number 0-10>,\n' +
        '  "communication_clarity": <number 0-10>,\n' +
        '  "confidence": <number 0-10>,\n' +
        '  "missed_opportunities": [<string>],\n' +
        '  "actionable_suggestions": [<string>]\n' +
        '}\n\n' +
        'Return ONLY valid JSON. Do not include any explanatory text.';

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

        if (supabase && sessionId && currentUserId) {
          supabase
            .from('call_sessions')
            .insert({
              session_id: sessionId,
              user_id: currentUserId,
              scenario: activeScenario ? activeScenario.name : 'Unknown',
              call_duration: callDurationMs,
              transcript,
              feedback: feedbackData,
            })
            .then(({ error }) => {
              if (error) {
                console.error('[supabase] Failed to save session:', error.message || error);
                return;
              }
              console.log('[supabase] Session saved successfully');
            })
            .catch((error) => {
              console.error('[supabase] Failed to save session:', error.message || error);
            });
        } else if (!currentUserId) {
          console.log('[supabase] Session not saved (unauthenticated user)');
        }
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
      currentUserId = null;
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
        case MESSAGE_TYPES.AUTH: {
          if (!supabase) {
            console.warn('[auth] Supabase not configured');
            break;
          }
          const token = typeof parsed.token === 'string' ? parsed.token : null;
          if (!token) {
            console.warn('[auth] Missing token');
            break;
          }
          supabase.auth
            .getUser(token)
            .then(({ data, error }) => {
              if (error || !data?.user) {
                console.warn('[auth] Invalid token');
                return;
              }
              currentUserId = data.user.id;
              console.log('[auth] User authenticated for session');
            })
            .catch(() => {
              console.warn('[auth] Token verification failed');
            });
          break;
        }
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
        case MESSAGE_TYPES.SCENARIO_SELECT: {
          if (scenarioLocked) {
            console.log('[scenario] Selection ignored; scenario already locked for this session');
            break;
          }
          const scenarioId = typeof parsed.scenarioId === 'string' ? parsed.scenarioId : null;
          const scenario = scenarioId && SCENARIO_MAP[scenarioId];
          if (!scenario) {
            console.warn('[scenario] Unknown scenario selection; using default');
            break;
          }
          activeScenario = scenario;
          resetConversationForScenario(scenario);
          console.log(`[scenario] Scenario selected: ${scenario.name}`);
          break;
        }
        case MESSAGE_TYPES.USER_AUDIO_START: {
          if (!scenarioLocked) {
            startCallWithScenario(activeScenario);
          }
          coachHintSentForTurn = false;
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
                  generateCoachHint(accumulatedTranscript);
                }
                // Clear previous timer and start new 3-second countdown.
                if (silenceTimer) clearTimeout(silenceTimer);
                silenceTimer = setTimeout(() => {
                  silenceTimer = null;
                  if (accumulatedTranscript) {
                    const toSend = accumulatedTranscript;
                    accumulatedTranscript = '';
                    queueTranscript(toSend);
                    coachHintSentForTurn = false;
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
            queueTranscript(toSend);
            coachHintSentForTurn = false;
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
        case MESSAGE_TYPES.USER_INTERRUPT: {
          // Barge-in: user is speaking while agent is playing audio.
          interrupted = true;
          ttsSessionId += 1; // Invalidate any in-flight TTS chunk loop.
          agentSpeakingState = false;
          console.log('[barge-in] Interruption detected');
          console.log('[barge-in] Agent speech cancelled');

          // Always notify frontend to stop playback immediately.
          if (!interruptNotified) {
            ws.send(JSON.stringify({ type: MESSAGE_TYPES.AGENT_INTERRUPT }));
            interruptNotified = true;
          }
          break;
        }
        case MESSAGE_TYPES.AGENT_TEXT: {
          // Should not be sent from client; log unexpected inbound traffic.
          console.log('[ws] Unexpected agent.text from client');
          break;
        }
        case MESSAGE_TYPES.CALL_END: {
          console.log('[ws] Call end received, generating feedback...');
          callEnded = true;
          interrupted = true;
          ttsSessionId += 1;
          agentSpeakingState = false;
          if (!interruptNotified) {
            ws.send(JSON.stringify({ type: MESSAGE_TYPES.AGENT_INTERRUPT }));
            interruptNotified = true;
          }
          if (deepgramClient) {
            deepgramClient.close();
            deepgramClient = null;
          }
          if (silenceTimer) {
            clearTimeout(silenceTimer);
            silenceTimer = null;
          }
          generateCallFeedback();
          break;
        }
        case MESSAGE_TYPES.CALL_RESET: {
          console.log('[ws] Call reset received, clearing session state');
          callEnded = false;
          scenarioLocked = false;
          activeScenario = SCENARIO_MAP.price_sensitive_small_business;
          resetConversationForScenario(activeScenario);
          sessionId = null;
          coachHintSentForTurn = false;
          lastCoachHintAt = 0;
          accumulatedTranscript = '';
          pendingTranscript = '';
          llmInFlight = false;
          interrupted = false;
          ttsSessionId += 1;
          agentSpeakingState = false;
          interruptNotified = false;
          callStartTime = Date.now();
          if (deepgramClient) {
            deepgramClient.close();
            deepgramClient = null;
          }
          if (silenceTimer) {
            clearTimeout(silenceTimer);
            silenceTimer = null;
          }
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
