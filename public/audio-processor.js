class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.targetSampleRate = options.processorOptions?.targetSampleRate || 24000;
  }

  process(inputs) {
    const channelData = inputs[0]?.[0];
    if (!channelData || channelData.length === 0) {
      return true;
    }

    const downsampled = this.downsample(channelData, sampleRate, this.targetSampleRate);
    if (!downsampled.length) {
      return true;
    }

    const pcm16 = new Int16Array(downsampled.length);
    for (let i = 0; i < downsampled.length; i += 1) {
      const sample = Math.max(-1, Math.min(1, downsampled[i]));
      pcm16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }

    this.port.postMessage(pcm16.buffer, [pcm16.buffer]);
    return true;
  }

  downsample(input, inputRate, outputRate) {
    if (inputRate === outputRate) {
      return input;
    }

    const ratio = inputRate / outputRate;
    const outputLength = Math.max(1, Math.round(input.length / ratio));
    const output = new Float32Array(outputLength);

    let outputIndex = 0;
    let inputIndex = 0;

    while (outputIndex < outputLength) {
      const nextInputIndex = Math.round((outputIndex + 1) * ratio);
      let sum = 0;
      let count = 0;

      for (let i = inputIndex; i < nextInputIndex && i < input.length; i += 1) {
        sum += input[i];
        count += 1;
      }

      output[outputIndex] = count > 0 ? sum / count : input[inputIndex] || 0;
      outputIndex += 1;
      inputIndex = nextInputIndex;
    }

    return output;
  }
}

registerProcessor("pcm-capture-processor", PcmCaptureProcessor);

