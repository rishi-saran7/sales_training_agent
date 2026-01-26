const https = require('https');

// Deepgram TTS REST endpoint for generating speech from text.
// Docs: https://developers.deepgram.com/docs/text-to-speech

const DEEPGRAM_TTS_URL = 'api.deepgram.com';
const DEEPGRAM_TTS_PATH = '/v1/speak';

class TtsClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
  }

  async generateSpeech(text, options = {}) {
    if (!text || typeof text !== 'string') {
      throw new Error('TTS requires valid text input');
    }

    const model = options.model || 'aura-asteria-en'; // Natural-sounding female voice
    const encoding = options.encoding || 'linear16'; // PCM16 for browser Web Audio API
    const sampleRate = options.sampleRate || 16000;
    const container = options.container || 'none'; // Raw audio bytes

    return new Promise((resolve, reject) => {
      const queryParams = new URLSearchParams({
        model,
        encoding,
        sample_rate: sampleRate,
        container,
      });

      const requestOptions = {
        hostname: DEEPGRAM_TTS_URL,
        path: `${DEEPGRAM_TTS_PATH}?${queryParams.toString()}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Token ${this.apiKey}`,
        },
      };

      console.log(`[tts] Generating speech for text: "${text.slice(0, 60)}${text.length > 60 ? '...' : ''}"`);

      const req = https.request(requestOptions, (res) => {
        if (res.statusCode !== 200) {
          let errorBody = '';
          res.on('data', (chunk) => {
            errorBody += chunk.toString();
          });
          res.on('end', () => {
            reject(new Error(`TTS request failed (${res.statusCode}): ${errorBody}`));
          });
          return;
        }

        const chunks = [];
        let totalBytes = 0;

        res.on('data', (chunk) => {
          chunks.push(chunk);
          totalBytes += chunk.length;
        });

        res.on('end', () => {
          const audioBuffer = Buffer.concat(chunks);
          console.log(`[tts] Generated ${totalBytes} bytes of audio`);
          resolve(audioBuffer);
        });

        res.on('error', (err) => {
          reject(err);
        });
      });

      req.on('error', (err) => {
        reject(err);
      });

      req.write(JSON.stringify({ text }));
      req.end();
    });
  }
}

module.exports = { TtsClient };
