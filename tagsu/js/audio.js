/**
 * Playing a transfer out of the headphone jack, and writing it to a .wav.
 *
 * The old site generated a 44100 Hz wav on a server, squeezed it through LAME
 * and handed the mp3 to a Flash player. Both steps work against the receiver: it
 * decodes by timing edges, mp3 rounds the square wave's edges off, and every
 * resample between 44100 and the sound card's real rate adds jitter to the pulse
 * widths. So we generate samples at a rate the output device runs natively and
 * hand them straight to Web Audio.
 *
 * Two mechanisms get us onto a rate with good timing headroom without ever
 * resampling:
 *
 *   - Ask for the rate outright. new AudioContext({ sampleRate }) makes the
 *     browser open the device at that rate, and CoreAudio and friends will
 *     usually switch an idle output device rather than resample.
 *   - Failing that, divide. Emitting every sample twice at 48000 Hz is
 *     bit-identical to generating at 24000 Hz.
 */
import {
  DEFAULT_RATE,
  deliveryPlan,
  encodeFloat32,
  encodeUint8,
  rateIsUsable,
  TESTED_BEST_RATE,
} from './modem.js';

/**
 * Sample rate for downloaded .wav files.
 *
 * A player may well resample this to whatever its output device runs at, but
 * resampling preserves wall-clock timing: a 32 kHz file played back at 48 kHz
 * still presents the receiver with 66-tick sync pulses. It only costs some edge
 * sharpness. So the file gets the rate with the best timing rather than the rate
 * most likely to play untouched.
 */
export const DOWNLOAD_RATE = TESTED_BEST_RATE;

export class Player {
  constructor() {
    this.context = null;
    this.source = null;
    this.requestedRate = null;
  }

  /**
   * Open the output device, preferably at `targetRate`. Must be called from a
   * user gesture: Safari and Chrome refuse to start an AudioContext otherwise,
   * and iOS leaves a fresh one suspended.
   *
   * A context's rate is fixed once created, so changing the target recreates it.
   */
  async prepare(targetRate = DEFAULT_RATE) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) throw new Error('This browser has no Web Audio support.');

    if (this.context && this.requestedRate !== targetRate) {
      this.stop();
      await this.context.close().catch(() => {});
      this.context = null;
    }

    if (!this.context) {
      try {
        this.context = new Ctor({ sampleRate: targetRate, latencyHint: 'playback' });
      } catch {
        // Some browsers reject an explicit rate; take whatever the device runs.
        this.context = new Ctor({ latencyHint: 'playback' });
      }
      this.requestedRate = targetRate;
    }
    if (this.context.state === 'suspended') {
      // Outside a user gesture this is refused; play() resumes it again later.
      await this.context.resume().catch(() => {});
    }

    return {
      requested: targetRate,
      hardwareRate: this.context.sampleRate,
      exact: this.context.sampleRate === targetRate,
    };
  }

  get hardwareRate() {
    return this.context ? this.context.sampleRate : null;
  }

  /**
   * How a requested rate will actually be delivered on the open device, as
   * { rate, repeat, exact }, or null if the device can do nothing usable.
   */
  plan(targetRate = DEFAULT_RATE) {
    return this.context ? deliveryPlan(this.context.sampleRate, targetRate) : null;
  }

  /**
   * Play a payload. `repeat` comes from one of the speeds() entries and emits
   * each generated sample that many times, landing on an exact lower rate.
   */
  async play(payload, repeat = 1) {
    if (!this.context) await this.prepare();
    if (this.context.state === 'suspended') await this.context.resume();
    const context = this.context;
    const rate = context.sampleRate / repeat;
    if (!rateIsUsable(rate)) {
      throw new Error(
        `This device runs its audio at ${context.sampleRate} Hz, which leaves no usable transfer rate.`,
      );
    }

    this.stop();
    const samples = encodeFloat32(payload, rate, repeat);
    // Two identical channels: a mono cable picks up only one of them and we have
    // no way of knowing which.
    const buffer = context.createBuffer(2, samples.length, context.sampleRate);
    buffer.copyToChannel(samples, 0);
    buffer.copyToChannel(samples, 1);

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    this.source = source;

    const finished = new Promise((resolve) => {
      source.onended = () => {
        if (this.source === source) this.source = null;
        resolve();
      };
    });
    source.start();
    return { finished, seconds: buffer.duration, rate };
  }

  stop() {
    if (!this.source) return;
    try {
      this.source.onended = null;
      this.source.stop();
    } catch {
      // Already finished.
    }
    this.source = null;
  }

  get playing() {
    return this.source !== null;
  }
}

/** Wrap 8-bit unsigned samples in a WAV container. */
export function wavBlob(payload, rate = DOWNLOAD_RATE) {
  const samples = encodeUint8(payload, rate);
  const header = 44;
  const out = new ArrayBuffer(header + samples.length);
  const view = new DataView(out);
  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, header - 8 + samples.length, true);
  ascii(8, 'WAVEfmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate, true); // byte rate
  view.setUint16(32, 1, true); // block align
  view.setUint16(34, 8, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, samples.length, true);
  new Uint8Array(out, header).set(samples);
  return new Blob([out], { type: 'audio/wav' });
}

/** Trigger a download of a Blob. */
export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
