"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabaseClient";

type ConnectionStatus = "connecting" | "connected" | "disconnected";

type MicStatus = "idle" | "recording" | "error";

// Message types keep the browser <-> server contract explicit.
const MESSAGE_TYPES = {
  AGENT_CONNECTED: "agent_connected",
  AUTH: "auth",
  DIFFICULTY_ASSIGNED: "difficulty.assigned",
  DIFFICULTY_MODE: "difficulty.mode",
  PING: "ping",
  PONG: "pong",
  SCENARIO_SELECT: "scenario.select",
  USER_AUDIO_START: "user.audio.start",
  USER_AUDIO_CHUNK: "user.audio.chunk",
  USER_AUDIO_END: "user.audio.end",
  USER_INTERRUPT: "user.interrupt",
  AGENT_AUDIO_START: "agent.audio.start",
  AGENT_AUDIO_CHUNK: "agent.audio.chunk",
  AGENT_AUDIO_END: "agent.audio.end",
  AGENT_INTERRUPT: "agent.interrupt",
  STT_PARTIAL: "stt.partial",
  STT_FINAL: "stt.final",
  AGENT_TEXT: "agent.text",
  COACH_HINT: "coach.hint",
  CALL_END: "call.end",
  CALL_RESET: "call.reset",
  CALL_FEEDBACK: "call.feedback",
} as const;

type Speaker = "you" | "customer";
type ChatMessage = { speaker: Speaker; text: string };

type FeedbackPayload = {
  overall_score: number;
  strengths: string[];
  weaknesses: string[];
  objection_handling: number;
  communication_clarity: number;
  confidence: number;
  missed_opportunities: string[];
  actionable_suggestions: string[];
};

type PastSession = {
  id: number | string;
  scenario: string;
  call_duration: number;
  overall_score: number | string | null;
  created_at: string;
};

type SessionConversationMetrics = {
  talk_ratio: number;
  user_word_count: number;
  agent_word_count: number;
  user_turn_count: number;
  agent_turn_count: number;
  user_questions_asked: number;
  customer_questions_asked: number;
  filler_word_count: number;
  filler_word_rate: number;
  avg_turn_length: number;
  longest_monologue: number;
  interruption_count: number;
  avg_response_latency_ms: number | null;
  user_words_per_minute: number;
  engagement_score: number;
  objection_detected: boolean;
  customer_raised_objection: boolean;
  pricing_discussed: boolean;
  customer_raised_pricing: boolean;
  competitor_mentioned: boolean;
  customer_mentioned_competitor: boolean;
  closing_attempted: boolean;
  rapport_building_phrases: number;
};

type SessionAudioMetrics = {
  speaking_duration_ms: number;
  silence_duration_ms: number;
  avg_pause_ms: number;
  speaking_rate_wpm: number;
  pace_label: string;
  hesitation_count: number;
  hesitation_rate: number;
  avg_stt_confidence: number | null;
  avg_response_latency_ms: number | null;
  interruption_count: number;
  confidence_score: number;
  vocal_clarity_score: number;
  energy_score: number;
  segment_count: number;
};

type AgentMessage =
  | { type: typeof MESSAGE_TYPES.AGENT_CONNECTED; message: string }
  | { type: typeof MESSAGE_TYPES.DIFFICULTY_ASSIGNED; level?: string; averages?: Record<string, number | null>; autoEnabled?: boolean }
  | { type: typeof MESSAGE_TYPES.PING; timestamp: number }
  | { type: typeof MESSAGE_TYPES.PONG; timestamp?: number }
  | { type: typeof MESSAGE_TYPES.USER_AUDIO_START }
  | { type: typeof MESSAGE_TYPES.USER_AUDIO_CHUNK }
  | { type: typeof MESSAGE_TYPES.USER_AUDIO_END }
  | { type: typeof MESSAGE_TYPES.USER_INTERRUPT }
  | { type: typeof MESSAGE_TYPES.AGENT_AUDIO_START }
  | { type: typeof MESSAGE_TYPES.AGENT_AUDIO_CHUNK; payload: string; format: string; sampleRate: number }
  | { type: typeof MESSAGE_TYPES.AGENT_AUDIO_END }
  | { type: typeof MESSAGE_TYPES.AGENT_INTERRUPT }
  | { type: typeof MESSAGE_TYPES.STT_PARTIAL; text: string }
  | { type: typeof MESSAGE_TYPES.STT_FINAL; text: string }
  | { type: typeof MESSAGE_TYPES.AGENT_TEXT; text: string }
  | { type: typeof MESSAGE_TYPES.COACH_HINT; text: string }
  | { type: typeof MESSAGE_TYPES.CALL_FEEDBACK; payload: FeedbackPayload; conversationMetrics?: SessionConversationMetrics | null; audioMetrics?: SessionAudioMetrics | null; callDurationMs: number; turnCount: number }
  | { type: string; [key: string]: unknown };

function safeParse(raw: string): AgentMessage | null {
  try {
    return JSON.parse(raw);
  } catch (error) {
    return null;
  }
}

// Shared constant so the WebSocket client points at the backend dev server.
const WS_URL = "ws://localhost:3001";
const API_BASE = "http://localhost:3001";
const TARGET_SAMPLE_RATE = 16000;
const CHUNK_DURATION_MS = 32; // 20–40 ms target; 32 ms is a balanced middle.

type RecordingHandles = {
  audioContext: AudioContext;
  mediaStream: MediaStream;
  sourceNode: MediaStreamAudioSourceNode;
  workletNode: AudioWorkletNode;
  silentGain: GainNode;
};

const SCENARIOS = [
  {
    id: "price_sensitive_small_business",
    name: "Price-Sensitive Small Business",
    description: "Owner focused on cost, quick ROI, and limited budget.",
  },
  {
    id: "enterprise_procurement_officer",
    name: "Enterprise Procurement Officer",
    description: "Procurement lead focused on compliance and contracts.",
  },
  {
    id: "angry_existing_customer",
    name: "Angry Existing Customer",
    description: "Upset customer with a recent issue and low patience.",
  },
  {
    id: "cold_uninterested_prospect",
    name: "Cold Uninterested Prospect",
    description: "Busy prospect with low interest and short attention span.",
  },
];

type StartRecordingOptions = {
  allowImmediateInterrupt?: boolean;
  reason?: "manual" | "auto";
};

export default function HomePage() {
  const router = useRouter();
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [latency, setLatency] = useState<number | null>(null);
  const [micStatus, setMicStatus] = useState<MicStatus>("idle");
  const [partialTranscript, setPartialTranscript] = useState<string>("");
  const [conversation, setConversation] = useState<ChatMessage[]>([]);
  const [agentSpeaking, setAgentSpeaking] = useState<boolean>(false);
  const [callEnded, setCallEnded] = useState<boolean>(false);
  const [feedback, setFeedback] = useState<FeedbackPayload | null>(null);
  const [callMetrics, setCallMetrics] = useState<{ duration: number; turns: number } | null>(null);
  const [sessionMetrics, setSessionMetrics] = useState<SessionConversationMetrics | null>(null);
  const [sessionAudioMetrics, setSessionAudioMetrics] = useState<SessionAudioMetrics | null>(null);
  const [latestSessionId, setLatestSessionId] = useState<string | number | null>(null);
  const [scenarioId, setScenarioId] = useState<string>(SCENARIOS[0]?.id || "");
  const [scenarioLocked, setScenarioLocked] = useState<boolean>(false);
  const [pastSessions, setPastSessions] = useState<PastSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState<boolean>(false);
  const [sessionsError, setSessionsError] = useState<string>("");
  const [sessionsVisible, setSessionsVisible] = useState<boolean>(false);
  const [audioEnabled, setAudioEnabled] = useState<boolean>(false);
  const [coachHint, setCoachHint] = useState<string>("");
  const [coachHintVisible, setCoachHintVisible] = useState<boolean>(false);
  const [coachHintsEnabled, setCoachHintsEnabled] = useState<boolean>(true);
  const [authLoading, setAuthLoading] = useState<boolean>(true);
  const [roleChecking, setRoleChecking] = useState<boolean>(true);
  const [authToken, setAuthToken] = useState<string>("");
  const [authEmail, setAuthEmail] = useState<string>("");
  const [trainerEmail, setTrainerEmail] = useState<string>("");
  const [organizationName, setOrganizationName] = useState<string>("");
  const [difficultyLevel, setDifficultyLevel] = useState<string>("");

  // Complaint modal state
  const [showComplaintModal, setShowComplaintModal] = useState(false);
  const [complaintSubject, setComplaintSubject] = useState("");
  const [complaintMessage, setComplaintMessage] = useState("");
  const [complaintSending, setComplaintSending] = useState(false);
  const [complaintSuccess, setComplaintSuccess] = useState("");
  const [complaintError, setComplaintError] = useState("");
  const [autoDifficultyEnabled, setAutoDifficultyEnabled] = useState<boolean>(true);

  // ── Error / reconnection banner state ──────────────────────────────────────
  const [errorBanner, setErrorBanner] = useState<string>("");
  const [successBanner, setSuccessBanner] = useState<string>("");
  const reconnectAttemptRef = useRef<number>(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const MAX_RECONNECT_ATTEMPTS = 8;
  const BASE_RECONNECT_DELAY_MS = 1000; // exponential back-off base

  const recordingRef = useRef<RecordingHandles | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioQueueRef = useRef<AudioBuffer[]>([]);
  const isPlayingRef = useRef<boolean>(false);
  const currentSourceRef = useRef<AudioBufferSourceNode | null>(null); // Ref to currently playing source for barge-in stop.
  const agentSpeakingRef = useRef<boolean>(false); // Ref mirror of agentSpeaking for use inside worklet callback.
  const ignoreAgentAudioRef = useRef<boolean>(false); // Ignore incoming agent audio after barge-in.
  const bargeInCooldownRef = useRef<boolean>(false); // Prevent repeated interrupt spam per utterance.
  const bargeInHitCountRef = useRef<number>(0); // Count consecutive frames over threshold.
  const bargeInTriggeredRef = useRef<boolean>(false); // Track if barge-in actually fired for this utterance.
  const bargeInEnableAtRef = useRef<number>(0); // Timestamp after which barge-in is allowed for this utterance.
  const coachHintTimerRef = useRef<number | null>(null);
  const coachHintsEnabledRef = useRef<boolean>(true);
  const autoDifficultyEnabledRef = useRef<boolean>(true);
  const authTokenRef = useRef<string>("");

  useEffect(() => {
    let active = true;

    async function redirectIfRole() {
      if (authLoading) return;
      if (!authToken) {
        if (active) setRoleChecking(false);
        return;
      }

      try {
        const adminResponse = await fetch(`${API_BASE}/api/admin/me`, {
          headers: { Authorization: `Bearer ${authToken}` },
        });
        if (active && adminResponse.ok) {
          router.replace("/admin");
          return;
        }

        const orgResponse = await fetch(`${API_BASE}/api/org/me`, {
          headers: { Authorization: `Bearer ${authToken}` },
        });
        if (active && orgResponse.ok) {
          const payload = await orgResponse.json();
          if (payload?.role === "trainer") {
            router.replace("/analytics");
            return;
          }
        }
      } catch (err) {
        console.error("Failed to check role status", err);
      } finally {
        if (active) setRoleChecking(false);
      }
    }

    redirectIfRole();

    return () => {
      active = false;
    };
  }, [authLoading, authToken, router]);

  // TODO: Adaptive interruption thresholds — adjust BARGE_IN_ENERGY_THRESHOLD based on ambient noise levels.
  const BARGE_IN_ENERGY_THRESHOLD = 0.035; // RMS energy threshold to detect user speech during agent playback.
  const BARGE_IN_HITS_REQUIRED = 4; // Require consecutive frames over threshold to trigger barge-in.
  const BARGE_IN_GRACE_MS = 500; // Short grace window to avoid false triggers on agent start.

  function isAgentAudioActive() {
    return agentSpeakingRef.current || isPlayingRef.current || audioQueueRef.current.length > 0;
  }

  const activeScenario = SCENARIOS.find((scenario) => scenario.id === scenarioId) || SCENARIOS[0];

  // Helper to decode base64 audio to PCM16 samples.
  function base64ToFloat32Array(base64: string, sampleRate: number): Float32Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    // Convert PCM16 (int16) to Float32 for Web Audio API.
    const samples = new Int16Array(bytes.buffer);
    const floats = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      floats[i] = samples[i] / 32768.0;
    }
    return floats;
  }

  // Stop all agent audio playback immediately (barge-in).
  function stopAgentPlayback() {
    // Stop currently playing audio source.
    if (currentSourceRef.current) {
      try {
        currentSourceRef.current.onended = null; // Prevent resolve callback.
        currentSourceRef.current.stop();
      } catch (_) { /* already stopped */ }
      currentSourceRef.current = null;
    }
    // Clear queued buffers.
    audioQueueRef.current = [];
    isPlayingRef.current = false;
    setAgentSpeaking(false);
    agentSpeakingRef.current = false;
    ignoreAgentAudioRef.current = true;
    console.log("[barge-in] Agent audio playback stopped");
  }

  // Play audio chunks from queue sequentially.
  async function playAudioQueue() {
    if (isPlayingRef.current || audioQueueRef.current.length === 0) return;
    isPlayingRef.current = true;
    agentSpeakingRef.current = true;

    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext();
    }

    // Ensure audio context is running.
    if (audioContextRef.current.state === "suspended") {
      await audioContextRef.current.resume();
    }

    console.log(`[audio] Playing ${audioQueueRef.current.length} audio buffers`);

    while (audioQueueRef.current.length > 0) {
      const buffer = audioQueueRef.current.shift();
      if (!buffer) continue;

      console.log(`[audio] Playing buffer: ${buffer.duration.toFixed(2)}s, ${buffer.length} samples`);

      const source = audioContextRef.current.createBufferSource();
      source.buffer = buffer;
      source.connect(audioContextRef.current.destination);
      currentSourceRef.current = source; // Track for barge-in stop.
      source.start();

      // Wait for this chunk to finish before playing next.
      await new Promise<void>((resolve) => {
        source.onended = () => {
          console.log("[audio] Chunk finished");
          if (currentSourceRef.current === source) {
            currentSourceRef.current = null;
          }
          resolve();
        };
      });
    }

    console.log("[audio] All chunks played");
    isPlayingRef.current = false;
    setAgentSpeaking(false);
    agentSpeakingRef.current = false;
  }

  useEffect(() => {
    coachHintsEnabledRef.current = coachHintsEnabled;
  }, [coachHintsEnabled]);

  useEffect(() => {
    autoDifficultyEnabledRef.current = autoDifficultyEnabled;
  }, [autoDifficultyEnabled]);

  function sendAuthToken(token: string) {
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) return;
    socketRef.current.send(
      JSON.stringify({
        type: MESSAGE_TYPES.AUTH,
        token,
      })
    );
  }

  function sendDifficultyMode(enabled: boolean) {
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) return;
    socketRef.current.send(
      JSON.stringify({
        type: MESSAGE_TYPES.DIFFICULTY_MODE,
        enabled,
      })
    );
  }

  useEffect(() => {
    let active = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      const session = data.session;
      if (!session) {
        setAuthLoading(false);
        setAuthToken("");
        setTrainerEmail("");
        setOrganizationName("");
        router.push("/login");
        return;
      }
      authTokenRef.current = session.access_token;
      setAuthToken(session.access_token);
      setAuthEmail(session.user.email || "");
      setTrainerEmail("");
      setOrganizationName("");
      sendAuthToken(session.access_token);
      setAuthLoading(false);
    });

    const { data: authListener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session) {
        authTokenRef.current = "";
        setAuthToken("");
        setTrainerEmail("");
        setOrganizationName("");
        setAuthLoading(false);
        router.push("/login");
        return;
      }
      authTokenRef.current = session.access_token;
      setAuthToken(session.access_token);
      setAuthEmail(session.user.email || "");
      setTrainerEmail("");
      setOrganizationName("");
      sendAuthToken(session.access_token);
      setAuthLoading(false);
    });

    return () => {
      active = false;
      authListener?.subscription.unsubscribe();
    };
  }, [router]);

  useEffect(() => {
    let active = true;

    async function loadTrainerInfo() {
      if (authLoading || !authToken) return;
      try {
        const response = await fetch(`${API_BASE}/api/org/trainer`, {
          headers: { Authorization: `Bearer ${authToken}` },
        });
        if (!response.ok) return;
        const payload = await response.json();
        if (active) {
          setTrainerEmail(payload?.trainerEmail || "");
          setOrganizationName(payload?.organizationName || "");
        }
      } catch (err) {
        console.error("Failed to load trainer info", err);
      }
    }

    loadTrainerInfo();

    return () => {
      active = false;
    };
  }, [authLoading, authToken]);

  useEffect(() => {
    let unmounted = false;

    function connectWebSocket() {
      if (unmounted) return;
      const socket = new WebSocket(WS_URL);
      socketRef.current = socket;
      setStatus("connecting");

      socket.onopen = () => {
        if (unmounted) { socket.close(); return; }
        setStatus("connected");
        setErrorBanner("");
        setSuccessBanner("Connected to server");
        setTimeout(() => setSuccessBanner(""), 2000);
        reconnectAttemptRef.current = 0;
        if (authTokenRef.current) {
          sendAuthToken(authTokenRef.current);
        }
        sendDifficultyMode(autoDifficultyEnabledRef.current);
      };

      socket.onclose = () => {
        if (unmounted) return;
        setStatus("disconnected");
        scheduleReconnect();
      };

      socket.onerror = () => {
        if (unmounted) return;
        setStatus("disconnected");
        // onclose will fire after onerror — reconnect scheduled there.
      };

      socket.onmessage = (event) => {
      const parsed: AgentMessage | null = safeParse(event.data);
      if (!parsed) {
        console.warn("Ignoring malformed message from agent");
        return;
      }

      switch (parsed.type) {
        case MESSAGE_TYPES.AGENT_CONNECTED: {
          console.log("Agent connected message received");
          break;
        }
        case MESSAGE_TYPES.DIFFICULTY_ASSIGNED: {
          if (typeof parsed.level === "string") {
            setDifficultyLevel(parsed.level);
          }
          if (typeof parsed.autoEnabled === "boolean") {
            setAutoDifficultyEnabled(parsed.autoEnabled);
          }
          break;
        }
        case MESSAGE_TYPES.PING: {
          // Respond immediately so the server can measure round-trip time.
          socket.send(
            JSON.stringify({
              type: MESSAGE_TYPES.PONG,
              timestamp: parsed.timestamp,
            })
          );
          if (typeof parsed.timestamp === "number") {
            setLatency(Date.now() - parsed.timestamp);
          }
          break;
        }
        case MESSAGE_TYPES.PONG: {
          // Optional: if the server ever echoes a pong, show latency.
          if (typeof parsed.timestamp === "number") {
            setLatency(Date.now() - parsed.timestamp);
          }
          break;
        }
        case MESSAGE_TYPES.USER_AUDIO_START: {
          // TODO: When mic capture is added, send start to server before streaming chunks.
          console.log("User audio start placeholder received");
          break;
        }
        case MESSAGE_TYPES.USER_AUDIO_CHUNK: {
          // TODO: Forward actual mic PCM chunks in later phase.
          console.log("User audio chunk placeholder received");
          break;
        }
        case MESSAGE_TYPES.USER_AUDIO_END: {
          // TODO: Signal end of user utterance once capture stops.
          console.log("User audio end placeholder received");
          break;
        }
        case MESSAGE_TYPES.AGENT_AUDIO_START: {
          setAgentSpeaking(true);
          agentSpeakingRef.current = true;
          ensurePlaybackContextReady();
          ignoreAgentAudioRef.current = false;
          bargeInCooldownRef.current = false;
          bargeInHitCountRef.current = 0;
          bargeInTriggeredRef.current = false;
          bargeInEnableAtRef.current = Date.now() + BARGE_IN_GRACE_MS;
          audioQueueRef.current = [];
          console.log("Agent audio start received");
          if (micStatus !== "recording") {
            console.log("[barge-in] Mic idle; automatic barge-in requires mic recording");
          }
          break;
        }
        case MESSAGE_TYPES.AGENT_AUDIO_CHUNK: {
          if (ignoreAgentAudioRef.current) {
            // Ignore any late-arriving chunks after barge-in.
            break;
          }
          if (typeof parsed.payload === "string" && typeof parsed.sampleRate === "number") {
            try {
              ensurePlaybackContextReady();
              console.log(`[audio] Received chunk: ${parsed.payload.length} chars, ${parsed.sampleRate}Hz`);
              const floats = base64ToFloat32Array(parsed.payload, parsed.sampleRate);
              console.log(`[audio] Decoded ${floats.length} samples`);
              if (!audioContextRef.current) {
                audioContextRef.current = new AudioContext();
              }
              const buffer = audioContextRef.current.createBuffer(1, floats.length, parsed.sampleRate);
              buffer.copyToChannel(floats as Float32Array<ArrayBuffer>, 0);
              audioQueueRef.current.push(buffer);
              console.log(`[audio] Buffer added to queue. Queue length: ${audioQueueRef.current.length}`);
              // Start playback if not already playing.
              if (!isPlayingRef.current) {
                playAudioQueue();
              }
            } catch (err) {
              console.error("Failed to decode agent audio chunk:", err);
            }
          }
          break;
        }
        case MESSAGE_TYPES.AGENT_AUDIO_END: {
          console.log("Agent audio end received");
          // Playback may still continue from buffered chunks; keep agentSpeakingRef true until queue drains.
          if (!isPlayingRef.current && audioQueueRef.current.length === 0) {
            setAgentSpeaking(false);
            agentSpeakingRef.current = false;
          }
          break;
        }
        case MESSAGE_TYPES.AGENT_INTERRUPT: {
          // Barge-in: backend confirmed interruption — stop all playback immediately.
          console.log("[barge-in] Agent interrupt received — stopping playback");
          bargeInTriggeredRef.current = true;
          stopAgentPlayback();
          break;
        }
        case MESSAGE_TYPES.STT_PARTIAL: {
          // Update live transcript as user speaks.
          if (typeof parsed.text === "string") {
            setPartialTranscript(parsed.text);
          }
          break;
        }
        case MESSAGE_TYPES.STT_FINAL: {
          // Finalize the user transcript.
          // Append to the existing "you" bubble if the user is still speaking
          // (i.e. the last message is already from "you"), so a single
          // continuous utterance doesn't split into many boxes.
          if (typeof parsed.text === "string") {
            const text = parsed.text;
            setPartialTranscript("");
            setConversation((prev) => {
              if (prev.length > 0 && prev[prev.length - 1].speaker === "you") {
                const updated = [...prev];
                updated[updated.length - 1] = {
                  ...updated[updated.length - 1],
                  text: `${updated[updated.length - 1].text} ${text}`,
                };
                return updated;
              }
              return [...prev, { speaker: "you", text }];
            });
            console.log("Final transcript:", text);
          }
          break;
        }
        case MESSAGE_TYPES.AGENT_TEXT: {
          if (typeof parsed.text === "string") {
            const text = parsed.text;
            setConversation((prev) => [...prev, { speaker: "customer", text }]);
          }
          break;
        }
        case MESSAGE_TYPES.COACH_HINT: {
          if (coachHintsEnabledRef.current && typeof parsed.text === "string") {
            showCoachHint(parsed.text);
          }
          break;
        }
        case MESSAGE_TYPES.CALL_FEEDBACK: {
          if (parsed.payload && typeof parsed.payload === "object") {
            setFeedback(parsed.payload as FeedbackPayload);
            setCallMetrics({
              duration: typeof parsed.callDurationMs === "number" ? parsed.callDurationMs : 0,
              turns: typeof parsed.turnCount === "number" ? parsed.turnCount : 0,
            });
            if (parsed.conversationMetrics && typeof parsed.conversationMetrics === "object") {
              setSessionMetrics(parsed.conversationMetrics as SessionConversationMetrics);
            }
            if (parsed.audioMetrics && typeof parsed.audioMetrics === "object") {
              setSessionAudioMetrics(parsed.audioMetrics as SessionAudioMetrics);
            }
            setCallEnded(true);
            clearCoachHint();
            setLatestSessionId(null);
            fetchLatestSessionId();
            console.log("Call feedback received", parsed.payload);
          }
          break;
        }
        default: {
          console.log("Message from agent:", event.data);
        }
      }
    };
    } // end connectWebSocket

    function scheduleReconnect() {
      if (unmounted) return;
      const attempt = reconnectAttemptRef.current;
      if (attempt >= MAX_RECONNECT_ATTEMPTS) {
        setErrorBanner("Connection lost. Please refresh the page.");
        return;
      }
      const delay = Math.min(BASE_RECONNECT_DELAY_MS * 2 ** attempt, 30000);
      reconnectAttemptRef.current = attempt + 1;
      setErrorBanner(`Connection lost — reconnecting in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${MAX_RECONNECT_ATTEMPTS})...`);
      reconnectTimerRef.current = setTimeout(() => {
        if (!unmounted) connectWebSocket();
      }, delay);
    }

    connectWebSocket();

    return () => {
      unmounted = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      // Ensure we stop any active recording when the component unmounts.
      stopRecording();
      socketRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Basic base64 helper for binary payloads over JSON WebSocket messages.
  function bufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 1) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  function clearCoachHint() {
    setCoachHintVisible(false);
    setCoachHint("");
    if (coachHintTimerRef.current) {
      window.clearTimeout(coachHintTimerRef.current);
      coachHintTimerRef.current = null;
    }
  }

  function showCoachHint(text: string) {
    if (!coachHintsEnabled) return;
    setCoachHint(text);
    setCoachHintVisible(true);
    if (coachHintTimerRef.current) {
      window.clearTimeout(coachHintTimerRef.current);
    }
    coachHintTimerRef.current = window.setTimeout(() => {
      setCoachHintVisible(false);
    }, 8000);
  }

  function ensurePlaybackContextReady() {
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext();
    }
    if (audioContextRef.current.state === "suspended") {
      audioContextRef.current.resume().catch(() => {
        console.warn("[audio] Failed to resume playback context");
      });
    }
  }

  function toggleCoachHints() {
    setCoachHintsEnabled((prev) => {
      const next = !prev;
      if (!next) {
        clearCoachHint();
      }
      return next;
    });
  }

  async function handleLogout() {
    await supabase.auth.signOut();
    router.push("/login");
  }

  async function enableAudio() {
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext();
    }
    if (audioContextRef.current.state === "suspended") {
      await audioContextRef.current.resume();
    }
    setAudioEnabled(true);
    console.log("[audio] Playback AudioContext enabled");
  }

  function formatDuration(durationMs: number) {
    const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
  }

  async function loadPastSessions() {
    if (sessionsLoading) return;
    setSessionsLoading(true);
    setSessionsError("");

    if (!authTokenRef.current) {
      router.push("/login");
      return;
    }

    try {
      const response = await fetch("http://localhost:3001/api/sessions", {
        headers: {
          Authorization: `Bearer ${authTokenRef.current}`,
        },
      });
      if (!response.ok) {
        throw new Error(`Request failed with ${response.status}`);
      }
      const data = await response.json();
      const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
      setPastSessions(sessions);
      setSessionsVisible(true);
    } catch (err) {
      console.error("Failed to load sessions", err);
      setSessionsError("Failed to load sessions");
    } finally {
      setSessionsLoading(false);
    }
  }

  async function fetchLatestSessionId() {
    if (!authTokenRef.current) return;

    try {
      const response = await fetch("http://localhost:3001/api/sessions", {
        headers: {
          Authorization: `Bearer ${authTokenRef.current}`,
        },
      });
      if (!response.ok) {
        throw new Error(`Request failed with ${response.status}`);
      }
      const data = await response.json();
      const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
      if (sessions.length > 0) {
        setLatestSessionId(sessions[0].id);
      }
    } catch (err) {
      console.error("Failed to fetch latest session", err);
    }
  }

  async function downloadReport(sessionId: string | number) {
    if (!authTokenRef.current) {
      router.push("/login");
      return;
    }

    try {
      const response = await fetch(`http://localhost:3001/api/report/${sessionId}`, {
        headers: {
          Authorization: `Bearer ${authTokenRef.current}`,
        },
      });
      if (!response.ok) {
        throw new Error(`Request failed with ${response.status}`);
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `performance-report-${sessionId}.pdf`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Failed to download report", err);
      setSessionsError("Failed to download report");
    }
  }

  async function startRecording(options: StartRecordingOptions = {}) {
    const { allowImmediateInterrupt = true } = options;
    if (micStatus === "recording") return;
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) {
      setErrorBanner("Not connected to the server. Reconnecting...");
      return;
    }

    await enableAudio();

    if (!scenarioLocked && activeScenario) {
      socketRef.current.send(
        JSON.stringify({
          type: MESSAGE_TYPES.SCENARIO_SELECT,
          scenarioId: activeScenario.id,
        })
      );
      setScenarioLocked(true);
    }

    // Barge-in: if agent is speaking when user starts recording, interrupt immediately.
    if (allowImmediateInterrupt && agentSpeaking) {
      console.log("[barge-in] User started recording while agent speaking — interrupting");
      bargeInTriggeredRef.current = true;
      stopAgentPlayback();
      socketRef.current.send(
        JSON.stringify({ type: MESSAGE_TYPES.USER_INTERRUPT })
      );
    }

    // Resume audio context on user interaction to ensure browser allows playback.
    if (audioContextRef.current && audioContextRef.current.state === "suspended") {
      await audioContextRef.current.resume();
      console.log("[audio] AudioContext resumed");
    }

    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // Use AudioWorklet for low-latency processing; it stays on the audio rendering thread.
      const audioContext = new AudioContext();
      await audioContext.audioWorklet.addModule("/audio-worklet.js");

      const sourceNode = audioContext.createMediaStreamSource(mediaStream);
      const workletNode = new AudioWorkletNode(audioContext, "pcm-worklet", {
        processorOptions: {
          targetSampleRate: TARGET_SAMPLE_RATE,
          chunkDurationMs: CHUNK_DURATION_MS,
        },
      });

      // Keep the graph alive without playing audio back to the user.
      const silentGain = audioContext.createGain();
      silentGain.gain.value = 0;
      sourceNode.connect(workletNode).connect(silentGain).connect(audioContext.destination);

      workletNode.port.onmessage = (event) => {
        if (event.data?.type === "chunk" && event.data?.payload instanceof ArrayBuffer) {
          // Barge-in detection: compute RMS energy of audio chunk to detect user speech.
          // TODO: Partial sentence recovery — save interrupted agent text for context.
          if (
            isAgentAudioActive() &&
            !bargeInCooldownRef.current &&
            Date.now() >= bargeInEnableAtRef.current
          ) {
            const pcm16 = new Int16Array(event.data.payload);
            let sumSquares = 0;
            for (let i = 0; i < pcm16.length; i++) {
              const normalized = pcm16[i] / 32768.0;
              sumSquares += normalized * normalized;
            }
            const rms = Math.sqrt(sumSquares / pcm16.length);

            if (rms > BARGE_IN_ENERGY_THRESHOLD) {
              bargeInHitCountRef.current += 1;
              if (bargeInHitCountRef.current >= BARGE_IN_HITS_REQUIRED) {
                console.log(`[barge-in] Speech detected (RMS: ${rms.toFixed(4)}), interrupting agent`);
                bargeInTriggeredRef.current = true;
                stopAgentPlayback();
                socketRef.current?.send(
                  JSON.stringify({ type: MESSAGE_TYPES.USER_INTERRUPT })
                );
                bargeInCooldownRef.current = true;
              }
            } else {
              bargeInHitCountRef.current = 0;
            }
          }

          const base64Audio = bufferToBase64(event.data.payload);
          socketRef.current?.send(
            JSON.stringify({
              type: MESSAGE_TYPES.USER_AUDIO_CHUNK,
              payload: base64Audio,
              format: "pcm16",
              sampleRate: TARGET_SAMPLE_RATE,
            })
          );
        }
      };

      // Notify backend that a user utterance is beginning.
      if (authTokenRef.current) {
        sendAuthToken(authTokenRef.current);
      }
      socketRef.current.send(
        JSON.stringify({
          type: MESSAGE_TYPES.USER_AUDIO_START,
          format: "pcm16",
          sampleRate: TARGET_SAMPLE_RATE,
        })
      );

      recordingRef.current = { audioContext, mediaStream, sourceNode, workletNode, silentGain };
      setMicStatus("recording");
      setPartialTranscript(""); // Clear previous partial transcript when starting new recording.
    } catch (error) {
      console.error("Unable to start microphone capture", error);
      setMicStatus("error");
      setErrorBanner("Microphone access failed. Please check your browser permissions and try again.");
    }
  }

  async function stopRecording() {
    if (micStatus !== "recording") return;

    const handles = recordingRef.current;
    if (handles) {
      // Flush any remaining buffered samples in the worklet.
      handles.workletNode.port.postMessage({ type: "flush" });

      handles.mediaStream.getTracks().forEach((track) => track.stop());
      handles.workletNode.disconnect();
      handles.sourceNode.disconnect();
      handles.silentGain.disconnect();
      await handles.audioContext.close();
      recordingRef.current = null;
    }

    socketRef.current?.send(
      JSON.stringify({
        type: MESSAGE_TYPES.USER_AUDIO_END,
        format: "pcm16",
        sampleRate: TARGET_SAMPLE_RATE,
      })
    );

    setPartialTranscript(""); // Clear partial transcript when stopping recording.
    setMicStatus("idle");
  }

  function handleSpeakButton() {
    if (status !== "connected") return;
    if (agentSpeaking) {
      console.log("[barge-in] Manual interrupt requested");
      bargeInTriggeredRef.current = true;
      stopAgentPlayback();
      socketRef.current?.send(
        JSON.stringify({ type: MESSAGE_TYPES.USER_INTERRUPT })
      );
      return;
    }
    startRecording({ allowImmediateInterrupt: true, reason: "manual" });
  }

  function endCall() {
    if (callEnded) return;
    // Stop any active recording.
    if (micStatus === "recording") {
      stopRecording();
    }
    stopAgentPlayback();
    if (authTokenRef.current) {
      sendAuthToken(authTokenRef.current);
    }
    // Request feedback from backend.
    socketRef.current?.send(JSON.stringify({ type: MESSAGE_TYPES.CALL_END }));
    console.log("End call requested");
  }

  function resetCall() {
    stopAgentPlayback();
    setCallEnded(false);
    setFeedback(null);
    setCallMetrics(null);
    setSessionMetrics(null);
    setSessionAudioMetrics(null);
    setConversation([]);
    setPartialTranscript("");
    setAgentSpeaking(false);
    setScenarioLocked(false);
    clearCoachHint();
    socketRef.current?.send(JSON.stringify({ type: MESSAGE_TYPES.CALL_RESET }));
    console.log("Call reset");
  }

  function toggleAutoDifficulty() {
    setAutoDifficultyEnabled((prev) => {
      const next = !prev;
      sendDifficultyMode(next);
      return next;
    });
  }

  const statusLabel = (() => {
    if (status === "connected") return "Connected to agent";
    if (status === "disconnected") return "Connection lost";
    return "Connecting...";
  })();

  if (authLoading || roleChecking) {
    return (
      <main
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(135deg, #0c1b33, #0f2740)",
          color: "#e8eef5",
          fontFamily: "'IBM Plex Sans', system-ui, -apple-system, sans-serif",
        }}
      >
        Loading...
      </main>
    );
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "linear-gradient(135deg, #0c1b33, #0f2740)",
        color: "#e8eef5",
        fontFamily: "'IBM Plex Sans', system-ui, -apple-system, sans-serif",
        flexDirection: "column",
      }}
    >
      {/* ── Success Banner ── */}
      {successBanner && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            zIndex: 10000,
            background: "linear-gradient(90deg, #22c55e, #16a34a)",
            color: "#fff",
            padding: "10px 20px",
            textAlign: "center",
            fontSize: "0.9rem",
            fontWeight: 600,
            letterSpacing: "0.02em",
            boxShadow: "0 2px 12px rgba(0,0,0,0.2)",
          }}
        >
          {successBanner}
        </div>
      )}
      {/* ── Error / Reconnection Banner ── */}
      {errorBanner && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            zIndex: 9999,
            background: "linear-gradient(90deg, #b91c1c, #dc2626)",
            color: "#fff",
            padding: "10px 20px",
            textAlign: "center",
            fontSize: "0.9rem",
            fontWeight: 600,
            letterSpacing: "0.02em",
            boxShadow: "0 2px 12px rgba(0,0,0,0.4)",
          }}
        >
          {errorBanner}
          {reconnectAttemptRef.current >= MAX_RECONNECT_ATTEMPTS && (
            <button
              onClick={() => { reconnectAttemptRef.current = 0; setErrorBanner(""); window.location.reload(); }}
              style={{
                marginLeft: "16px",
                padding: "4px 14px",
                borderRadius: "6px",
                border: "1px solid rgba(255,255,255,0.5)",
                background: "transparent",
                color: "#fff",
                cursor: "pointer",
                fontWeight: 600,
                fontSize: "0.85rem",
              }}
            >
              Reload
            </button>
          )}
        </div>
      )}
      {callEnded && feedback ? (
        // Feedback Screen
        <div
          style={{
            padding: "2.5rem 3rem",
            background: "rgba(255, 255, 255, 0.04)",
            borderRadius: "18px",
            boxShadow: "0 15px 40px rgba(0, 0, 0, 0.35)",
            backdropFilter: "blur(6px)",
            border: "1px solid rgba(255, 255, 255, 0.08)",
            maxWidth: "700px",
            width: "100%",
          }}
        >
          <h1 style={{ margin: 0, fontSize: "2rem", fontWeight: 600, marginBottom: "1rem" }}>
            Call Feedback
          </h1>
          <div style={{ marginBottom: "1.5rem", opacity: 0.8, fontSize: "0.9rem" }}>
            <p style={{ margin: 0 }}>Duration: {Math.round((callMetrics?.duration || 0) / 60000)} min</p>
            <p style={{ margin: "0.25rem 0 0" }}>Turns: {callMetrics?.turns || 0}</p>
          </div>

          <div
            style={{
              padding: "1.5rem",
              background: "rgba(31, 111, 235, 0.15)",
              borderRadius: "12px",
              marginBottom: "1.5rem",
              textAlign: "center",
            }}
          >
            <p style={{ margin: 0, fontSize: "0.9rem", opacity: 0.8 }}>Overall Score</p>
            <p style={{ margin: "0.5rem 0 0", fontSize: "3rem", fontWeight: 700 }}>
              {feedback.overall_score}/10
            </p>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "1rem", marginBottom: "1.5rem" }}>
            <div style={{ padding: "1rem", background: "rgba(255,255,255,0.05)", borderRadius: "10px" }}>
              <p style={{ margin: 0, fontSize: "0.85rem", opacity: 0.7 }}>Objection Handling</p>
              <p style={{ margin: "0.5rem 0 0", fontSize: "1.5rem", fontWeight: 600 }}>
                {feedback.objection_handling}/10
              </p>
            </div>
            <div style={{ padding: "1rem", background: "rgba(255,255,255,0.05)", borderRadius: "10px" }}>
              <p style={{ margin: 0, fontSize: "0.85rem", opacity: 0.7 }}>Clarity</p>
              <p style={{ margin: "0.5rem 0 0", fontSize: "1.5rem", fontWeight: 600 }}>
                {feedback.communication_clarity}/10
              </p>
            </div>
            <div style={{ padding: "1rem", background: "rgba(255,255,255,0.05)", borderRadius: "10px" }}>
              <p style={{ margin: 0, fontSize: "0.85rem", opacity: 0.7 }}>Confidence</p>
              <p style={{ margin: "0.5rem 0 0", fontSize: "1.5rem", fontWeight: 600 }}>
                {feedback.confidence}/10
              </p>
            </div>
          </div>

          {/* Conversation Intelligence Metrics */}
          {sessionMetrics && (
            <div style={{ marginBottom: "1.5rem" }}>
              <h3 style={{ margin: "0 0 0.75rem", fontSize: "1.2rem", color: "#a78bfa" }}>Conversation Intelligence</h3>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0.75rem", marginBottom: "1rem" }}>
                <div style={{ padding: "0.75rem", background: "rgba(167,139,250,0.1)", borderRadius: "10px" }}>
                  <p style={{ margin: 0, fontSize: "0.75rem", opacity: 0.6 }}>Talk Ratio</p>
                  <p style={{ margin: "0.3rem 0 0", fontSize: "1.3rem", fontWeight: 700 }}>{(sessionMetrics.talk_ratio * 100).toFixed(0)}%</p>
                </div>
                <div style={{ padding: "0.75rem", background: "rgba(167,139,250,0.1)", borderRadius: "10px" }}>
                  <p style={{ margin: 0, fontSize: "0.75rem", opacity: 0.6 }}>Engagement</p>
                  <p style={{ margin: "0.3rem 0 0", fontSize: "1.3rem", fontWeight: 700 }}>{sessionMetrics.engagement_score}/10</p>
                </div>
                <div style={{ padding: "0.75rem", background: "rgba(167,139,250,0.1)", borderRadius: "10px" }}>
                  <p style={{ margin: 0, fontSize: "0.75rem", opacity: 0.6 }}>Questions</p>
                  <p style={{ margin: "0.3rem 0 0", fontSize: "1.3rem", fontWeight: 700 }}>{sessionMetrics.user_questions_asked}</p>
                </div>
                <div style={{ padding: "0.75rem", background: "rgba(167,139,250,0.1)", borderRadius: "10px" }}>
                  <p style={{ margin: 0, fontSize: "0.75rem", opacity: 0.6 }}>Filler Words</p>
                  <p style={{ margin: "0.3rem 0 0", fontSize: "1.3rem", fontWeight: 700 }}>{sessionMetrics.filler_word_count}</p>
                  <p style={{ margin: 0, fontSize: "0.65rem", opacity: 0.5 }}>{sessionMetrics.filler_word_rate}% of words</p>
                </div>
                <div style={{ padding: "0.75rem", background: "rgba(167,139,250,0.1)", borderRadius: "10px" }}>
                  <p style={{ margin: 0, fontSize: "0.75rem", opacity: 0.6 }}>Interruptions</p>
                  <p style={{ margin: "0.3rem 0 0", fontSize: "1.3rem", fontWeight: 700 }}>{sessionMetrics.interruption_count}</p>
                </div>
                <div style={{ padding: "0.75rem", background: "rgba(167,139,250,0.1)", borderRadius: "10px" }}>
                  <p style={{ margin: 0, fontSize: "0.75rem", opacity: 0.6 }}>Pace</p>
                  <p style={{ margin: "0.3rem 0 0", fontSize: "1.3rem", fontWeight: 700 }}>{sessionMetrics.user_words_per_minute} wpm</p>
                </div>
              </div>
              {/* Topic Tags */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
                {sessionMetrics.customer_raised_objection && (
                  <span style={{ padding: "0.3rem 0.65rem", borderRadius: "999px", background: "rgba(239,68,68,0.2)", fontSize: "0.75rem", border: "1px solid rgba(239,68,68,0.3)" }}>Objections Raised</span>
                )}
                {sessionMetrics.pricing_discussed && (
                  <span style={{ padding: "0.3rem 0.65rem", borderRadius: "999px", background: "rgba(34,211,238,0.2)", fontSize: "0.75rem", border: "1px solid rgba(34,211,238,0.3)" }}>Pricing Discussed</span>
                )}
                {sessionMetrics.competitor_mentioned && (
                  <span style={{ padding: "0.3rem 0.65rem", borderRadius: "999px", background: "rgba(251,191,36,0.2)", fontSize: "0.75rem", border: "1px solid rgba(251,191,36,0.3)" }}>Competitors Mentioned</span>
                )}
                {sessionMetrics.closing_attempted && (
                  <span style={{ padding: "0.3rem 0.65rem", borderRadius: "999px", background: "rgba(16,185,129,0.2)", fontSize: "0.75rem", border: "1px solid rgba(16,185,129,0.3)" }}>Closing Attempted</span>
                )}
                {sessionMetrics.rapport_building_phrases > 0 && (
                  <span style={{ padding: "0.3rem 0.65rem", borderRadius: "999px", background: "rgba(167,139,250,0.2)", fontSize: "0.75rem", border: "1px solid rgba(167,139,250,0.3)" }}>Rapport: {sessionMetrics.rapport_building_phrases} phrases</span>
                )}
              </div>
            </div>
          )}

          {/* Voice Intelligence Metrics */}
          {sessionAudioMetrics && (
            <div style={{ marginBottom: "1.5rem" }}>
              <h3 style={{ margin: "0 0 0.75rem", fontSize: "1.2rem", color: "#22d3ee" }}>Voice Intelligence</h3>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0.75rem", marginBottom: "1rem" }}>
                <div style={{ padding: "0.75rem", background: "rgba(34,211,238,0.1)", borderRadius: "10px" }}>
                  <p style={{ margin: 0, fontSize: "0.75rem", opacity: 0.6 }}>Confidence</p>
                  <p style={{ margin: "0.3rem 0 0", fontSize: "1.3rem", fontWeight: 700 }}>{sessionAudioMetrics.confidence_score}/10</p>
                </div>
                <div style={{ padding: "0.75rem", background: "rgba(34,211,238,0.1)", borderRadius: "10px" }}>
                  <p style={{ margin: 0, fontSize: "0.75rem", opacity: 0.6 }}>Vocal Clarity</p>
                  <p style={{ margin: "0.3rem 0 0", fontSize: "1.3rem", fontWeight: 700 }}>{sessionAudioMetrics.vocal_clarity_score}/10</p>
                </div>
                <div style={{ padding: "0.75rem", background: "rgba(34,211,238,0.1)", borderRadius: "10px" }}>
                  <p style={{ margin: 0, fontSize: "0.75rem", opacity: 0.6 }}>Energy</p>
                  <p style={{ margin: "0.3rem 0 0", fontSize: "1.3rem", fontWeight: 700 }}>{sessionAudioMetrics.energy_score}/10</p>
                </div>
                <div style={{ padding: "0.75rem", background: "rgba(34,211,238,0.1)", borderRadius: "10px" }}>
                  <p style={{ margin: 0, fontSize: "0.75rem", opacity: 0.6 }}>Speaking Rate</p>
                  <p style={{ margin: "0.3rem 0 0", fontSize: "1.3rem", fontWeight: 700 }}>{sessionAudioMetrics.speaking_rate_wpm} wpm</p>
                  <p style={{ margin: 0, fontSize: "0.65rem", opacity: 0.5 }}>{sessionAudioMetrics.pace_label}</p>
                </div>
                <div style={{ padding: "0.75rem", background: "rgba(34,211,238,0.1)", borderRadius: "10px" }}>
                  <p style={{ margin: 0, fontSize: "0.75rem", opacity: 0.6 }}>Hesitations</p>
                  <p style={{ margin: "0.3rem 0 0", fontSize: "1.3rem", fontWeight: 700 }}>{sessionAudioMetrics.hesitation_count}</p>
                  <p style={{ margin: 0, fontSize: "0.65rem", opacity: 0.5 }}>{sessionAudioMetrics.hesitation_rate}% of words</p>
                </div>
                <div style={{ padding: "0.75rem", background: "rgba(34,211,238,0.1)", borderRadius: "10px" }}>
                  <p style={{ margin: 0, fontSize: "0.75rem", opacity: 0.6 }}>Silence</p>
                  <p style={{ margin: "0.3rem 0 0", fontSize: "1.3rem", fontWeight: 700 }}>{(sessionAudioMetrics.silence_duration_ms / 1000).toFixed(1)}s</p>
                  <p style={{ margin: 0, fontSize: "0.65rem", opacity: 0.5 }}>avg pause {(sessionAudioMetrics.avg_pause_ms / 1000).toFixed(1)}s</p>
                </div>
              </div>
              {sessionAudioMetrics.avg_stt_confidence != null && (
                <p style={{ margin: "0.25rem 0", fontSize: "0.8rem", opacity: 0.6 }}>STT Confidence: {(sessionAudioMetrics.avg_stt_confidence * 100).toFixed(0)}%</p>
              )}
            </div>
          )}

          {feedback.strengths.length > 0 && (
            <div style={{ marginBottom: "1.5rem" }}>
              <h3 style={{ margin: "0 0 0.75rem", fontSize: "1.2rem", color: "#10b981" }}>Strengths</h3>
              <ul style={{ margin: 0, paddingLeft: "1.5rem" }}>
                {feedback.strengths.map((item, idx) => (
                  <li key={idx} style={{ marginBottom: "0.5rem" }}>
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {feedback.weaknesses.length > 0 && (
            <div style={{ marginBottom: "1.5rem" }}>
              <h3 style={{ margin: "0 0 0.75rem", fontSize: "1.2rem", color: "#ef4444" }}>Areas for Improvement</h3>
              <ul style={{ margin: 0, paddingLeft: "1.5rem" }}>
                {feedback.weaknesses.map((item, idx) => (
                  <li key={idx} style={{ marginBottom: "0.5rem" }}>
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {feedback.missed_opportunities.length > 0 && (
            <div style={{ marginBottom: "1.5rem" }}>
              <h3 style={{ margin: "0 0 0.75rem", fontSize: "1.2rem", color: "#f59e0b" }}>Missed Opportunities</h3>
              <ul style={{ margin: 0, paddingLeft: "1.5rem" }}>
                {feedback.missed_opportunities.map((item, idx) => (
                  <li key={idx} style={{ marginBottom: "0.5rem" }}>
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {feedback.actionable_suggestions.length > 0 && (
            <div style={{ marginBottom: "1.5rem" }}>
              <h3 style={{ margin: "0 0 0.75rem", fontSize: "1.2rem", color: "#8b5cf6" }}>Actionable Suggestions</h3>
              <ul style={{ margin: 0, paddingLeft: "1.5rem" }}>
                {feedback.actionable_suggestions.map((item, idx) => (
                  <li key={idx} style={{ marginBottom: "0.5rem" }}>
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <button
            onClick={resetCall}
            style={{
              padding: "0.75rem 1.5rem",
              borderRadius: "10px",
              border: "1px solid rgba(255,255,255,0.2)",
              background: "#1f6feb",
              color: "white",
              cursor: "pointer",
              fontWeight: 600,
              width: "100%",
            }}
          >
            Start New Call
          </button>
          {latestSessionId && (
            <button
              onClick={() => downloadReport(latestSessionId)}
              style={{
                marginTop: "0.75rem",
                padding: "0.75rem 1.5rem",
                borderRadius: "10px",
                border: "1px solid rgba(255,255,255,0.2)",
                background: "rgba(14, 165, 233, 0.2)",
                color: "#e8eef5",
                cursor: "pointer",
                fontWeight: 600,
                width: "100%",
              }}
            >
              Download Report
            </button>
          )}
        </div>
      ) : (
        // Main Call Screen
        <div
        style={{
          padding: "2.5rem 3rem",
          background: "rgba(255, 255, 255, 0.04)",
          borderRadius: "18px",
          boxShadow: "0 15px 40px rgba(0, 0, 0, 0.35)",
          backdropFilter: "blur(6px)",
          border: "1px solid rgba(255, 255, 255, 0.08)",
        }}
      >
        <p style={{ margin: 0, fontSize: "0.95rem", letterSpacing: "0.04em" }}>
          Live training agent status
        </p>
        <h1 style={{ margin: "0.4rem 0 0", fontSize: "2rem", fontWeight: 600 }}>
          {statusLabel}
        </h1>
        {activeScenario && (
          <p style={{ margin: "0.5rem 0 0", fontSize: "0.95rem", opacity: 0.9 }}>
            Scenario: {activeScenario.name}
          </p>
        )}
        {latency !== null && (
          <p style={{ margin: "0.5rem 0 0", fontSize: "0.95rem", opacity: 0.9 }}>
            Latency: ~{latency} ms
          </p>
        )}
        <div style={{ marginTop: "0.75rem", display: "flex", gap: "0.75rem", flexWrap: "wrap", alignItems: "center" }}>
          <Link
            href="/analytics"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.4rem",
              padding: "0.45rem 0.85rem",
              borderRadius: "999px",
              border: "1px solid rgba(255,255,255,0.2)",
              background: "rgba(14, 165, 233, 0.15)",
              color: "#e8eef5",
              textDecoration: "none",
              fontSize: "0.85rem",
              fontWeight: 600,
            }}
          >
            View Analytics
          </Link>
          {!audioEnabled && (
            <button
              onClick={enableAudio}
              style={{
                padding: "0.45rem 0.85rem",
                borderRadius: "999px",
                border: "1px solid rgba(255,255,255,0.2)",
                background: "rgba(148, 163, 184, 0.15)",
                color: "#e8eef5",
                cursor: "pointer",
                fontSize: "0.85rem",
                fontWeight: 600,
              }}
            >
              Enable Audio
            </button>
          )}
          <button
            onClick={toggleCoachHints}
            style={{
              padding: "0.45rem 0.85rem",
              borderRadius: "999px",
              border: "1px solid rgba(255,255,255,0.2)",
              background: coachHintsEnabled ? "rgba(16, 185, 129, 0.2)" : "rgba(148, 163, 184, 0.15)",
              color: "#e8eef5",
              cursor: "pointer",
              fontSize: "0.85rem",
              fontWeight: 600,
            }}
          >
            {coachHintsEnabled ? "Coach Hints: On" : "Coach Hints: Off"}
          </button>
          <button
            onClick={handleLogout}
            style={{
              padding: "0.45rem 0.85rem",
              borderRadius: "999px",
              border: "1px solid rgba(255,255,255,0.2)",
              background: "rgba(239, 68, 68, 0.2)",
              color: "#e8eef5",
              cursor: "pointer",
              fontSize: "0.85rem",
              fontWeight: 600,
            }}
          >
            Log Out
          </button>
          {authEmail && (
            <span style={{ fontSize: "0.8rem", opacity: 0.75 }}>{authEmail}</span>
          )}
          {trainerEmail && (
            <span style={{ fontSize: "0.8rem", opacity: 0.7 }}>Trainer: {trainerEmail}</span>
          )}
          {organizationName && (
            <span style={{ fontSize: "0.8rem", opacity: 0.7 }}>Org: {organizationName}</span>
          )}
          <a
            href="/messages"
            style={{
              padding: "0.45rem 0.85rem",
              borderRadius: "999px",
              border: "1px solid rgba(14,165,233,0.3)",
              background: "rgba(14, 165, 233, 0.15)",
              color: "#93c5fd",
              textDecoration: "none",
              fontSize: "0.85rem",
              fontWeight: 600,
            }}
          >
            Messages
          </a>
          <button
            onClick={() => {
              setShowComplaintModal(true);
              setComplaintSubject("");
              setComplaintMessage("");
              setComplaintSuccess("");
              setComplaintError("");
            }}
            style={{
              padding: "0.45rem 0.85rem",
              borderRadius: "999px",
              border: "1px solid rgba(239,68,68,0.3)",
              background: "rgba(239, 68, 68, 0.2)",
              color: "#fca5a5",
              cursor: "pointer",
              fontSize: "0.85rem",
              fontWeight: 600,
            }}
          >
            Report Issue
          </button>
        </div>
        <div style={{ marginTop: "1rem", display: "flex", gap: "0.75rem", alignItems: "center" }}>
          <button
            onClick={loadPastSessions}
            disabled={sessionsLoading}
            style={{
              padding: "0.6rem 1rem",
              borderRadius: "10px",
              border: "1px solid rgba(255,255,255,0.2)",
              background: sessionsLoading ? "#4b5563" : "#0ea5e9",
              color: "white",
              cursor: sessionsLoading ? "not-allowed" : "pointer",
              fontWeight: 600,
            }}
          >
            {sessionsLoading ? "Loading Sessions..." : "View Past Sessions"}
          </button>
          {sessionsError && (
            <span style={{ fontSize: "0.85rem", color: "#fca5a5" }}>{sessionsError}</span>
          )}
        </div>
        <div style={{ marginTop: "0.75rem", display: "flex", gap: "0.75rem", alignItems: "center" }}>
          <div
            style={{
              padding: "0.4rem 0.75rem",
              borderRadius: "999px",
              border: "1px solid rgba(255,255,255,0.15)",
              background: "rgba(148, 163, 184, 0.15)",
              fontSize: "0.8rem",
              fontWeight: 600,
            }}
          >
            Difficulty: {difficultyLevel || "Pending"}
          </div>
          <button
            onClick={toggleAutoDifficulty}
            style={{
              padding: "0.4rem 0.75rem",
              borderRadius: "999px",
              border: "1px solid rgba(255,255,255,0.2)",
              background: autoDifficultyEnabled ? "rgba(16, 185, 129, 0.2)" : "rgba(148, 163, 184, 0.2)",
              color: "#e8eef5",
              cursor: "pointer",
              fontSize: "0.8rem",
              fontWeight: 600,
            }}
          >
            Auto Difficulty: {autoDifficultyEnabled ? "On" : "Off"}
          </button>
        </div>
        <div style={{ marginTop: "1rem" }}>
          <label style={{ display: "block", fontSize: "0.85rem", opacity: 0.8, marginBottom: "0.35rem" }}>
            Scenario Selection
          </label>
          <select
            value={scenarioId}
            onChange={(event) => setScenarioId(event.target.value)}
            disabled={scenarioLocked}
            style={{
              width: "100%",
              padding: "0.6rem 0.75rem",
              borderRadius: "8px",
              border: "1px solid rgba(255,255,255,0.2)",
              background: scenarioLocked ? "#1f2937" : "#0f1e36",
              color: "#e8eef5",
              cursor: scenarioLocked ? "not-allowed" : "pointer",
            }}
          >
            {SCENARIOS.map((scenario) => (
              <option key={scenario.id} value={scenario.id}>
                {scenario.name}
              </option>
            ))}
          </select>
          {activeScenario?.description && (
            <p style={{ margin: "0.5rem 0 0", fontSize: "0.85rem", opacity: 0.75 }}>
              {activeScenario.description}
            </p>
          )}
        </div>
        <div style={{ marginTop: "1.5rem", display: "flex", gap: "0.75rem" }}>
          <button
            onClick={handleSpeakButton}
            disabled={status !== "connected" || (micStatus === "recording" && !agentSpeaking)}
            style={{
              padding: "0.75rem 1.2rem",
              borderRadius: "10px",
              border: "1px solid rgba(255,255,255,0.2)",
              background: micStatus === "recording" ? "#4b5563" : "#1f6feb",
              color: "white",
              cursor: status !== "connected" || (micStatus === "recording" && !agentSpeaking) ? "not-allowed" : "pointer",
              fontWeight: 600,
            }}
          >
            {agentSpeaking ? "Interrupt & Speak" : "Start Speaking"}
          </button>
          <button
            onClick={stopRecording}
            disabled={micStatus !== "recording"}
            style={{
              padding: "0.75rem 1.2rem",
              borderRadius: "10px",
              border: "1px solid rgba(255,255,255,0.2)",
              background: micStatus === "recording" ? "#dc2626" : "#4b5563",
              color: "white",
              cursor: micStatus !== "recording" ? "not-allowed" : "pointer",
              fontWeight: 600,
            }}
          >
            Stop Speaking
          </button>
          <button
            onClick={endCall}
            disabled={callEnded || conversation.length === 0}
            style={{
              padding: "0.75rem 1.2rem",
              borderRadius: "10px",
              border: "1px solid rgba(255,255,255,0.2)",
              background: callEnded || conversation.length === 0 ? "#4b5563" : "#dc2626",
              color: "white",
              cursor: callEnded || conversation.length === 0 ? "not-allowed" : "pointer",
              fontWeight: 600,
            }}
          >
            End Call
          </button>
        </div>
        <p style={{ margin: "0.75rem 0 0", fontSize: "0.95rem", opacity: 0.95 }}>
          Mic status: {micStatus === "recording" ? "Recording" : micStatus === "error" ? "Error" : "Idle"}
        </p>
        {agentSpeaking && (
          <p style={{ margin: "0.5rem 0 0", fontSize: "0.95rem", opacity: 0.95, color: "#ec4899" }}>
            Customer speaking...
          </p>
        )}

        {/* Conversation timeline */}
        <div style={{ marginTop: "1.5rem", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          {conversation.map((message, idx) => {
            const isCustomer = message.speaker === "customer";
            return (
              <div
                key={`${message.speaker}-${idx}-${message.text.slice(0, 12)}`}
                style={{
                  padding: "0.85rem 1rem",
                  background: isCustomer ? "rgba(236, 72, 153, 0.12)" : "rgba(31, 111, 235, 0.12)",
                  border: isCustomer
                    ? "1px solid rgba(236, 72, 153, 0.25)"
                    : "1px solid rgba(31, 111, 235, 0.25)",
                  borderRadius: "10px",
                }}
              >
                <p style={{ margin: 0, fontSize: "0.85rem", opacity: 0.7, marginBottom: "0.35rem" }}>
                  {isCustomer ? "Customer" : "You"}
                </p>
                <p style={{ margin: 0, fontSize: "1rem", lineHeight: 1.5 }}>{message.text}</p>
              </div>
            );
          })}

          {partialTranscript && (
            <div
              style={{
                padding: "0.85rem 1rem",
                background: "rgba(31, 111, 235, 0.08)",
                border: "1px dashed rgba(31, 111, 235, 0.4)",
                borderRadius: "10px",
                fontStyle: "italic",
              }}
            >
              <p style={{ margin: 0, fontSize: "0.85rem", opacity: 0.7, marginBottom: "0.35rem" }}>
                Listening...
              </p>
              <p style={{ margin: 0, fontSize: "1rem", lineHeight: 1.5 }}>{partialTranscript}</p>
            </div>
          )}
        </div>

        {coachHintVisible && coachHint && (
          <div
            style={{
              position: "fixed",
              right: "2rem",
              bottom: "2rem",
              maxWidth: "320px",
              padding: "1rem 1.1rem",
              borderRadius: "14px",
              background: "rgba(15, 23, 42, 0.92)",
              border: "1px solid rgba(56, 189, 248, 0.4)",
              boxShadow: "0 12px 24px rgba(0, 0, 0, 0.35)",
              zIndex: 20,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <p style={{ margin: 0, fontSize: "0.85rem", letterSpacing: "0.08em", textTransform: "uppercase" }}>
                Coach Hint
              </p>
              <button
                onClick={clearCoachHint}
                style={{
                  border: "none",
                  background: "transparent",
                  color: "#94a3b8",
                  cursor: "pointer",
                  fontSize: "0.9rem",
                }}
                aria-label="Dismiss hint"
              >
                ×
              </button>
            </div>
            <p style={{ margin: "0.5rem 0 0", fontSize: "0.95rem", lineHeight: 1.5, color: "#e2e8f0" }}>
              {coachHint}
            </p>
          </div>
        )}

        {/* TODO: Add pagination for session history. */}
        {/* TODO: Add session detail view with transcript and feedback. */}
        {/* TODO: Add analytics dashboard for aggregate coaching metrics. */}
        {sessionsVisible && (
          <div style={{ marginTop: "1.75rem" }}>
            <h3 style={{ margin: "0 0 0.75rem", fontSize: "1.2rem" }}>Past Sessions</h3>
            {pastSessions.length === 0 ? (
              <p style={{ margin: 0, opacity: 0.75 }}>No sessions yet.</p>
            ) : (
              <div style={{ display: "grid", gap: "0.65rem" }}>
                {pastSessions.map((session) => (
                  <div
                    key={session.id}
                    style={{
                      padding: "0.85rem 1rem",
                      background: "rgba(255,255,255,0.05)",
                      borderRadius: "10px",
                      border: "1px solid rgba(255,255,255,0.08)",
                    }}
                  >
                    <p style={{ margin: 0, fontSize: "0.95rem", fontWeight: 600 }}>
                      {session.scenario}
                    </p>
                    <p style={{ margin: "0.35rem 0 0", fontSize: "0.85rem", opacity: 0.8 }}>
                      Overall Score: {session.overall_score ?? "N/A"}
                    </p>
                    <p style={{ margin: "0.25rem 0 0", fontSize: "0.85rem", opacity: 0.8 }}>
                      Duration: {formatDuration(Number(session.call_duration) || 0)}
                    </p>
                    <p style={{ margin: "0.25rem 0 0", fontSize: "0.85rem", opacity: 0.8 }}>
                      Date: {session.created_at ? new Date(session.created_at).toLocaleString() : "Unknown"}
                    </p>
                    <button
                      onClick={() => downloadReport(session.id)}
                      style={{
                        marginTop: "0.6rem",
                        padding: "0.4rem 0.75rem",
                        borderRadius: "8px",
                        border: "1px solid rgba(255,255,255,0.2)",
                        background: "rgba(14, 165, 233, 0.2)",
                        color: "#e8eef5",
                        cursor: "pointer",
                        fontSize: "0.8rem",
                        fontWeight: 600,
                      }}
                    >
                      Download Report
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      )}

      {/* Complaint Modal */}
      {showComplaintModal && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(0,0,0,0.6)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
          }}
          onClick={() => setShowComplaintModal(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "90%",
              maxWidth: "500px",
              padding: "2rem",
              borderRadius: "18px",
              background: "#0f172a",
              border: "1px solid rgba(239,68,68,0.25)",
              display: "flex",
              flexDirection: "column",
              gap: "1rem",
            }}
          >
            <h2 style={{ margin: 0, fontSize: "1.3rem", fontWeight: 700, color: "#fca5a5" }}>Report Issue to Admin</h2>
            <p style={{ margin: 0, fontSize: "0.85rem", opacity: 0.65 }}>This complaint will be sent directly to the administrator.</p>
            <input
              type="text"
              value={complaintSubject}
              onChange={(e) => setComplaintSubject(e.target.value)}
              placeholder="Subject"
              style={{
                padding: "0.6rem 0.9rem",
                borderRadius: "10px",
                border: "1px solid rgba(148,163,184,0.2)",
                background: "rgba(2,6,23,0.6)",
                color: "#e2e8f0",
                fontSize: "0.9rem",
                outline: "none",
              }}
            />
            <textarea
              value={complaintMessage}
              onChange={(e) => setComplaintMessage(e.target.value)}
              placeholder="Describe the issue..."
              rows={4}
              style={{
                padding: "0.6rem 0.9rem",
                borderRadius: "10px",
                border: "1px solid rgba(148,163,184,0.2)",
                background: "rgba(2,6,23,0.6)",
                color: "#e2e8f0",
                fontSize: "0.9rem",
                resize: "vertical",
                outline: "none",
              }}
            />
            {complaintError && <p style={{ margin: 0, color: "#fca5a5", fontSize: "0.85rem" }}>{complaintError}</p>}
            {complaintSuccess && <p style={{ margin: 0, color: "#86efac", fontSize: "0.85rem" }}>{complaintSuccess}</p>}
            <div style={{ display: "flex", gap: "0.75rem", justifyContent: "flex-end" }}>
              <button
                onClick={() => setShowComplaintModal(false)}
                style={{
                  padding: "0.5rem 1rem",
                  borderRadius: "10px",
                  border: "1px solid rgba(255,255,255,0.2)",
                  background: "transparent",
                  color: "#e2e8f0",
                  cursor: "pointer",
                  fontWeight: 600,
                }}
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  if (!complaintSubject.trim() || !complaintMessage.trim()) {
                    setComplaintError("Subject and message are required.");
                    return;
                  }
                  setComplaintSending(true);
                  setComplaintError("");
                  try {
                    const res = await fetch(`${API_BASE}/api/complaints`, {
                      method: "POST",
                      headers: {
                        Authorization: `Bearer ${authToken}`,
                        "Content-Type": "application/json",
                      },
                      body: JSON.stringify({ subject: complaintSubject.trim(), message: complaintMessage.trim() }),
                    });
                    if (!res.ok) throw new Error("Failed");
                    setComplaintSuccess("Complaint submitted successfully!");
                    setComplaintSubject("");
                    setComplaintMessage("");
                    setTimeout(() => setShowComplaintModal(false), 1500);
                  } catch {
                    setComplaintError("Failed to submit complaint. Please try again.");
                  } finally {
                    setComplaintSending(false);
                  }
                }}
                disabled={complaintSending}
                style={{
                  padding: "0.5rem 1rem",
                  borderRadius: "10px",
                  border: "none",
                  background: complaintSending ? "#374151" : "#ef4444",
                  color: "white",
                  cursor: complaintSending ? "not-allowed" : "pointer",
                  fontWeight: 600,
                }}
              >
                {complaintSending ? "Sending..." : "Submit Complaint"}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
