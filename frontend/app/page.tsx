"use client";

import { useEffect, useRef, useState } from "react";

type ConnectionStatus = "connecting" | "connected" | "disconnected";

type MicStatus = "idle" | "recording" | "error";

// Message types keep the browser <-> server contract explicit.
const MESSAGE_TYPES = {
  AGENT_CONNECTED: "agent_connected",
  PING: "ping",
  PONG: "pong",
  USER_AUDIO_START: "user.audio.start",
  USER_AUDIO_CHUNK: "user.audio.chunk",
  USER_AUDIO_END: "user.audio.end",
  AGENT_AUDIO_START: "agent.audio.start",
  AGENT_AUDIO_CHUNK: "agent.audio.chunk",
  AGENT_AUDIO_END: "agent.audio.end",
  AGENT_INTERRUPT: "agent.interrupt",
  STT_PARTIAL: "stt.partial",
  STT_FINAL: "stt.final",
  AGENT_TEXT: "agent.text",
  CALL_END: "call.end",
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

type AgentMessage =
  | { type: typeof MESSAGE_TYPES.AGENT_CONNECTED; message: string }
  | { type: typeof MESSAGE_TYPES.PING; timestamp: number }
  | { type: typeof MESSAGE_TYPES.PONG; timestamp?: number }
  | { type: typeof MESSAGE_TYPES.USER_AUDIO_START }
  | { type: typeof MESSAGE_TYPES.USER_AUDIO_CHUNK }
  | { type: typeof MESSAGE_TYPES.USER_AUDIO_END }
  | { type: typeof MESSAGE_TYPES.AGENT_AUDIO_START }
  | { type: typeof MESSAGE_TYPES.AGENT_AUDIO_CHUNK; payload: string; format: string; sampleRate: number }
  | { type: typeof MESSAGE_TYPES.AGENT_AUDIO_END }
  | { type: typeof MESSAGE_TYPES.AGENT_INTERRUPT }
  | { type: typeof MESSAGE_TYPES.STT_PARTIAL; text: string }
  | { type: typeof MESSAGE_TYPES.STT_FINAL; text: string }
  | { type: typeof MESSAGE_TYPES.AGENT_TEXT; text: string }
  | { type: typeof MESSAGE_TYPES.CALL_FEEDBACK; payload: FeedbackPayload; callDurationMs: number; turnCount: number }
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
const TARGET_SAMPLE_RATE = 16000;
const CHUNK_DURATION_MS = 32; // 20–40 ms target; 32 ms is a balanced middle.

type RecordingHandles = {
  audioContext: AudioContext;
  mediaStream: MediaStream;
  sourceNode: MediaStreamAudioSourceNode;
  workletNode: AudioWorkletNode;
  silentGain: GainNode;
};

export default function HomePage() {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [latency, setLatency] = useState<number | null>(null);
  const [micStatus, setMicStatus] = useState<MicStatus>("idle");
  const [partialTranscript, setPartialTranscript] = useState<string>("");
  const [conversation, setConversation] = useState<ChatMessage[]>([]);
  const [agentSpeaking, setAgentSpeaking] = useState<boolean>(false);
  const [callEnded, setCallEnded] = useState<boolean>(false);
  const [feedback, setFeedback] = useState<FeedbackPayload | null>(null);
  const [callMetrics, setCallMetrics] = useState<{ duration: number; turns: number } | null>(null);

  const recordingRef = useRef<RecordingHandles | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioQueueRef = useRef<AudioBuffer[]>([]);
  const isPlayingRef = useRef<boolean>(false);

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

  // Play audio chunks from queue sequentially.
  async function playAudioQueue() {
    if (isPlayingRef.current || audioQueueRef.current.length === 0) return;
    isPlayingRef.current = true;

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
      source.start();

      // Wait for this chunk to finish before playing next.
      await new Promise<void>((resolve) => {
        source.onended = () => {
          console.log("[audio] Chunk finished");
          resolve();
        };
      });
    }

    console.log("[audio] All chunks played");
    isPlayingRef.current = false;
    setAgentSpeaking(false);
  }

  useEffect(() => {
    // Establish the live WebSocket link to the backend agent gateway.
    const socket = new WebSocket(WS_URL);
    socketRef.current = socket;

    socket.onopen = () => {
      setStatus("connected");
    };

    socket.onclose = () => {
      setStatus("disconnected");
    };

    socket.onerror = (event) => {
      console.error("WebSocket encountered an error", event);
      setStatus("disconnected");
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
          audioQueueRef.current = [];
          console.log("Agent audio start received");
          break;
        }
        case MESSAGE_TYPES.AGENT_AUDIO_CHUNK: {
          if (typeof parsed.payload === "string" && typeof parsed.sampleRate === "number") {
            try {
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
          // Playback will finish naturally; agentSpeaking will be cleared after queue empties.
          break;
        }
        case MESSAGE_TYPES.AGENT_INTERRUPT: {
          // TODO: Stop playback when agent interrupt arrives (barge-in support).
          console.log("Agent interrupt placeholder received");
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
          if (typeof parsed.text === "string") {
            const text = parsed.text; // Narrow type for reuse without unknown complaints.
            setPartialTranscript("");
            setConversation((prev) => [...prev, { speaker: "you", text }]);
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
        case MESSAGE_TYPES.CALL_FEEDBACK: {
          if (parsed.payload && typeof parsed.payload === "object") {
            setFeedback(parsed.payload as FeedbackPayload);
            setCallMetrics({
              duration: typeof parsed.callDurationMs === "number" ? parsed.callDurationMs : 0,
              turns: typeof parsed.turnCount === "number" ? parsed.turnCount : 0,
            });
            setCallEnded(true);
            console.log("Call feedback received", parsed.payload);
          }
          break;
        }
        default: {
          console.log("Message from agent:", event.data);
        }
      }
    };

    return () => {
      // Ensure we stop any active recording when the component unmounts.
      stopRecording();
      socket.close();
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

  async function startRecording() {
    if (micStatus === "recording") return;
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) {
      console.warn("Socket not ready; cannot start recording");
      return;
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

  function endCall() {
    if (callEnded) return;
    // Stop any active recording.
    if (micStatus === "recording") {
      stopRecording();
    }
    // Request feedback from backend.
    socketRef.current?.send(JSON.stringify({ type: MESSAGE_TYPES.CALL_END }));
    console.log("End call requested");
  }

  function resetCall() {
    setCallEnded(false);
    setFeedback(null);
    setCallMetrics(null);
    setConversation([]);
    setPartialTranscript("");
    setAgentSpeaking(false);
    console.log("Call reset");
  }

  const statusLabel = (() => {
    if (status === "connected") return "Connected to agent";
    if (status === "disconnected") return "Connection lost";
    return "Connecting...";
  })();

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
        {latency !== null && (
          <p style={{ margin: "0.5rem 0 0", fontSize: "0.95rem", opacity: 0.9 }}>
            Latency: ~{latency} ms
          </p>
        )}
        <div style={{ marginTop: "1.5rem", display: "flex", gap: "0.75rem" }}>
          <button
            onClick={startRecording}
            disabled={micStatus === "recording" || status !== "connected" || agentSpeaking}
            style={{
              padding: "0.75rem 1.2rem",
              borderRadius: "10px",
              border: "1px solid rgba(255,255,255,0.2)",
              background: micStatus === "recording" || agentSpeaking ? "#4b5563" : "#1f6feb",
              color: "white",
              cursor: micStatus === "recording" || status !== "connected" || agentSpeaking ? "not-allowed" : "pointer",
              fontWeight: 600,
            }}
          >
            Start Speaking
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
      </div>
      )}
    </main>
  );
}
