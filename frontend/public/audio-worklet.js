// AudioWorkletProcessor that slices incoming mic audio into ~chunkDurationMs frames,
// converts to PCM16 mono, and resamples to targetSampleRate (default 16 kHz).
class PCMWorklet extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.targetSampleRate = opts.targetSampleRate || 16000;
    this.chunkDurationMs = opts.chunkDurationMs || 32;
    this._buffer = [];

    // Allow the main thread to request a flush before shutdown.
    this.port.onmessage = (event) => {
      if (event.data && event.data.type === 'flush') {
        this._flushBuffer();
      }
    };
  }

  // Linear resample from the worklet's sampleRate to targetSampleRate.
  _resampleMono(float32Samples) {
    const inputRate = sampleRate;
    const outputRate = this.targetSampleRate;
    if (inputRate === outputRate) {
      return float32Samples;
    }

    const ratio = inputRate / outputRate;
    const outputLength = Math.floor(float32Samples.length / ratio);
    const output = new Float32Array(outputLength);

    for (let i = 0; i < outputLength; i += 1) {
      const sourceIndex = i * ratio;
      const lower = Math.floor(sourceIndex);
      const upper = Math.min(lower + 1, float32Samples.length - 1);
      const weight = sourceIndex - lower;
      output[i] = float32Samples[lower] * (1 - weight) + float32Samples[upper] * weight;
    }

    return output;
  }

  // Convert Float32 [-1, 1] samples to PCM16 little-endian bytes.
  _floatToPCM16(float32Samples) {
    const buffer = new ArrayBuffer(float32Samples.length * 2);
    const view = new DataView(buffer);
    for (let i = 0; i < float32Samples.length; i += 1) {
      const clamped = Math.max(-1, Math.min(1, float32Samples[i]));
      view.setInt16(i * 2, clamped * 0x7fff, true);
    }
    return buffer;
  }

  _flushBuffer() {
    if (this._buffer.length === 0) return;
    const concatenated = this._concat(this._buffer);
    this._buffer = [];

    const resampled = this._resampleMono(concatenated);
    const pcm16 = this._floatToPCM16(resampled);

    // Transfer the underlying ArrayBuffer to avoid copies.
    this.port.postMessage({ type: 'chunk', payload: pcm16, sampleRate: this.targetSampleRate }, [pcm16]);
  }

  _concat(chunks) {
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const result = new Float32Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0 || input[0].length === 0) {
      return true;
    }

    // Use mono channel (index 0).
    const channelData = input[0];
    if (!channelData) return true;

    // Accumulate until we reach the target chunk duration.
    this._buffer.push(new Float32Array(channelData));
    const framesNeeded = Math.floor((sampleRate * this.chunkDurationMs) / 1000);
    const bufferedFrames = this._buffer.reduce((sum, chunk) => sum + chunk.length, 0);

    if (bufferedFrames >= framesNeeded) {
      this._flushBuffer();
    }

    return true;
  }
}

registerProcessor('pcm-worklet', PCMWorklet);
