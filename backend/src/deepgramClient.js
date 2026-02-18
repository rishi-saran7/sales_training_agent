const WebSocket = require('ws');

// Deepgram realtime WebSocket client for streaming PCM16 audio and receiving transcripts.
// Docs: https://developers.deepgram.com/docs/streaming#websockets

const DEEPGRAM_URL = 'wss://api.deepgram.com/v1/listen';

class DeepgramClient {
  constructor(apiKey, onEvent) {
    this.apiKey = apiKey;
    this.onEvent = onEvent; // (eventType, payload)
    this.ws = null;
    this.connected = false;
  }

  async connect() {
    return new Promise((resolve, reject) => {
      const params = new URLSearchParams({
        encoding: 'linear16',
        sample_rate: '16000',
        channels: '1',
        interim_results: 'true',
        smart_format: 'true',
        model: 'nova-2',
        punctuate: 'true',
        filler_words: 'true',    // Keep "um", "uh", etc. in the transcript for hesitation detection.
        utterance_end_ms: '1500',  // Deepgram waits 1.5s of silence before emitting UtteranceEnd.
        endpointing: '500',       // 500ms of silence within an utterance to finalise the sentence.
      });

      console.log('[deepgram] Connecting to realtime endpoint...');
      this.ws = new WebSocket(`${DEEPGRAM_URL}?${params.toString()}`, {
        headers: {
          Authorization: `Token ${this.apiKey}`,
        },
      });

      this.ws.on('open', () => {
        this.connected = true;
        console.log('[deepgram] Connected');
        resolve();
      });

      this.ws.on('message', (data) => {
        this._handleMessage(data);
      });

      this.ws.on('error', (err) => {
        console.error('[deepgram] WebSocket error:', err);
        this.connected = false;
        reject(err);
      });

      this.ws.on('close', () => {
        console.log('[deepgram] Closed');
        this.connected = false;
      });
    });
  }

  _handleMessage(data) {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch (err) {
      console.warn('[deepgram] Failed to parse message', err);
      return;
    }

    if (message.type !== 'Results') {
      this._handleMetaMessage(message);
      return;
    }
    const channel = message.channel || {};
    const alt = (channel.alternatives && channel.alternatives[0]) || {};
    const transcript = (alt.transcript || '').trim();
    if (!transcript) return; // ignore empty

    // Extract average word-level confidence if available.
    let avgConfidence = null;
    const words = alt.words;
    if (Array.isArray(words) && words.length > 0) {
      let confSum = 0;
      let confCount = 0;
      for (const w of words) {
        if (typeof w.confidence === 'number') {
          confSum += w.confidence;
          confCount++;
        }
      }
      if (confCount > 0) {
        avgConfidence = confSum / confCount;
      }
    }

    const isFinal = Boolean(message.is_final);
    if (isFinal) {
      console.log(`[deepgram] Final transcript: "${transcript}"`);
      this.onEvent('stt.final', { text: transcript, confidence: avgConfidence });
    } else {
      this.onEvent('stt.partial', { text: transcript });
    }
  }

  /**
   * Handle non-Results messages (e.g. UtteranceEnd).
   * Called from the main _handleMessage after the Results check.
   */
  _handleMetaMessage(message) {
    if (message.type === 'UtteranceEnd') {
      console.log('[deepgram] UtteranceEnd detected');
      this.onEvent('stt.utterance_end', {});
    }
  }

  sendAudio(buffer) {
    if (!this.connected || !this.ws) return;
    // Deepgram expects raw audio bytes, not base64.
    this.ws.send(buffer);
  }

  close() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }
}

module.exports = { DeepgramClient };
