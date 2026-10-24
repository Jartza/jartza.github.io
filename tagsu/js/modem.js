/**
 * Tagsu audio modem.
 *
 * A port of the proven bin/modem.py waveform, verified byte-for-byte against the
 * reference .wav files the old server produced.
 *
 * The signal is a square wave that flips polarity on every pulse; the receiver
 * (firmware/tagsu_isr.c, ISR(PCINT0_vect)) only measures the time between edges,
 * so absolute polarity does not matter. Pulse widths, in samples:
 *
 *   bit 0 ->  3 samples
 *   bit 1 ->  5 samples
 *   sync  -> 17 samples
 *
 * A transfer is: 0.5 s of silence, 512 sync pulses (the firmware watchdog-reboots
 * into its flasher after MODEM_START_SYNC_COUNT = 500 of them), 190 ms more sync
 * to cover that reboot, then 128 blocks of [block number][16 data bytes][CRC-8],
 * each followed by a pause for the flash write, and 50 sync pulses to finish.
 */

export const BLOCK_SIZE = 16;
export const BLOCK_COUNT = 128;
export const PAYLOAD_SIZE = BLOCK_SIZE * BLOCK_COUNT; // 2048

/**
 * Samples per sync pulse.
 *
 * The first firmware used 16 here, the current one uses 17. We emit 17, which
 * both decode: the length is only ever compared against a threshold, and a
 * longer pulse is more unambiguously sync, not less.
 *
 * It is not a free choice, though. The receiver derives its 0-versus-1 decision
 * point as syncLength / 4, so 16 samples puts the threshold at exactly 4.0
 * samples, dead centre between a 0 bit at 3 and a 1 bit at 5, while 17 puts it
 * at 4.25 and leaves a 1 bit only 0.75 samples of margin against 1.25 for a 0.
 * That asymmetry is why a marginal transfer loses 1 bits first.
 */
export const SYNC_SAMPLES = 17;

const BIT_SAMPLES = [3, 5];
const LEAD_IN_SYNCS = 512;
const BOOT_WAIT_MS = 190;
const TAIL_SYNCS = 50;
const SILENCE_SECONDS = 0.5;

/** CRC-8, polynomial 0x07, initial value 0 (avr-libc _crc8_ccitt_update). */
export function crc8Update(crc, byte) {
  let data = (crc ^ byte) & 0xff;
  for (let i = 0; i < 8; i++) {
    data = data & 0x80 ? ((data << 1) ^ 0x07) & 0xff : (data << 1) & 0xff;
  }
  return data;
}

/**
 * Build the constant-level runs making up a transfer, as flat [level, length]
 * pairs where level is -1 low, 1 high, 0 silence.
 */
function plan(data, sampleRate, syncSamples) {
  const runs = [];
  let total = 0;
  let hilo = 0;

  const push = (level, length) => {
    if (length <= 0) return;
    runs.push(level, length);
    total += length;
  };
  const sync = (count) => {
    for (let i = 0; i < count; i++) {
      hilo ^= 1;
      push(hilo ? 1 : -1, syncSamples);
    }
  };
  const byte = (value) => {
    let v = value & 0xff;
    for (let i = 0; i < 8; i++) {
      hilo ^= 1;
      push(hilo ? 1 : -1, BIT_SAMPLES[v & 1]);
      v >>= 1;
    }
  };

  // Sync pulses per millisecond, matching modem.py's syncs_in_ms.
  const syncsPerMs = sampleRate / syncSamples / 1000;

  push(0, Math.trunc(sampleRate * SILENCE_SECONDS));
  sync(LEAD_IN_SYNCS);
  sync(Math.trunc(syncsPerMs * BOOT_WAIT_MS));

  let block = 1;
  for (let offset = 0; offset < data.length; offset += BLOCK_SIZE) {
    const num = block & 0xff;
    let crc = crc8Update(0, num);
    byte(num);
    for (let i = 0; i < BLOCK_SIZE && offset + i < data.length; i++) {
      byte(data[offset + i]);
      crc = crc8Update(crc, data[offset + i]);
    }
    byte(crc);
    // The firmware erases and writes a flash page after every 4th block, which
    // takes longer than buffering a block does.
    sync(Math.trunc(syncsPerMs * (block % 4 === 0 ? 15 : 5)));
    block++;
  }
  sync(TAIL_SYNCS);

  return { runs, total };
}

/**
 * Encode a payload as unsigned 8-bit samples (0 / 127 / 255), exactly what
 * bin/modem.py wrote into its .wav files. Used for .wav output and by the tests.
 */
export function encodeUint8(data, sampleRate, { syncSamples = SYNC_SAMPLES } = {}) {
  const { runs, total } = plan(data, sampleRate, syncSamples);
  const out = new Uint8Array(total);
  let p = 0;
  for (let i = 0; i < runs.length; i += 2) {
    const value = runs[i] === 0 ? 127 : runs[i] > 0 ? 255 : 0;
    out.fill(value, p, p + runs[i + 1]);
    p += runs[i + 1];
  }
  return out;
}

/**
 * Encode a payload as float samples in [-1, 1].
 *
 * `repeat` emits every generated sample N times, which is how we reach a lower
 * effective rate on hardware we cannot reconfigure: repeating at 48 kHz is
 * bit-identical to generating at 24 kHz, with no resampling filter anywhere in
 * the path to smear the edges the receiver is timing.
 */
export function encodeFloat32(
  data,
  sampleRate,
  repeat = 1,
  { syncSamples = SYNC_SAMPLES } = {},
) {
  const { runs, total } = plan(data, sampleRate, syncSamples);
  const out = new Float32Array(total * repeat);
  let p = 0;
  for (let i = 0; i < runs.length; i += 2) {
    const length = runs[i + 1] * repeat;
    if (runs[i] !== 0) out.fill(runs[i], p, p + length);
    p += length;
  }
  return out;
}

/*
 * Choosing a sample rate.
 *
 * The receiver measures every pulse with a 125 kHz timer and calls anything over
 * 40 ticks a sync pulse. That one fixed threshold squeezes the usable rates from
 * both ends: too fast and a real sync pulse drops under 40 ticks and is decoded
 * as a data bit, too slow and a 1 bit climbs over 40 ticks and is mistaken for
 * sync. Either way the rest of the block is garbage and the tag gives up with
 * ?LOAD ERROR, because the firmware has no retry.
 *
 *   rate   sync   1 bit   0 bit   threshold (sync/4)   tested on hardware
 *   48000  44.3   13.0     7.8    11                   works
 *   44100  48.2   14.2     8.5    12
 *   32000  66.4   19.5    11.7    16                   works, most reliable
 *   24000  88.5   26.0    15.6    22
 *   22050  96.4   28.3    17.0    24
 *   16000 132.8   39.1    23.4    33                   FAILS
 *
 * 32000 is the rate Jari has measured as most reliable across both the old and
 * the current firmware, and that is what we aim for. The first firmware did not
 * account for the delay in entering the pin-change ISR and reading the timer,
 * which biases every measurement upward; since the 40-tick threshold is a
 * constant rather than something derived from the signal, the rate that survives
 * that bias best is the one sitting furthest from the threshold on both sides.
 *
 * 16000 was offered as the slow option until it was tried on a badge, where it
 * does not work at all. The arithmetic says why: a 1 bit measures 39.1 ticks
 * against a threshold of 40, so less than a tick of ISR bias is enough to turn
 * every 1 bit into a sync pulse. That is the measurement that sets the bounds
 * below, rather than the theoretical point where the margin reaches zero.
 */

export const TIMER_HZ = 125000;
export const SYNC_TICK_THRESHOLD = 40;

/** Measured on real hardware as the most reliable rate, old firmware included. */
export const TESTED_BEST_RATE = 32000;

/**
 * Ticks of clearance a pulse needs from the sync threshold to be trusted.
 *
 * Bracketed by measurement rather than theory: 48000 works with its sync pulse
 * 4.3 ticks clear, and 16000 fails with its 1 bit 0.9 ticks clear. Four ticks
 * sits just inside the first and well outside the second.
 */
export const MIN_TICK_MARGIN = 4;

/** Rate bounds implied by the threshold and that margin. */
export const MIN_RATE = Math.ceil(
  (BIT_SAMPLES[1] * TIMER_HZ) / (SYNC_TICK_THRESHOLD - MIN_TICK_MARGIN),
);
export const MAX_RATE = Math.floor(
  (SYNC_SAMPLES * TIMER_HZ) / (SYNC_TICK_THRESHOLD + MIN_TICK_MARGIN),
);

/** How the firmware's timer will see pulses generated at a given rate. */
export function timing(rate, syncSamples = SYNC_SAMPLES) {
  const ticks = (samples) => (samples / rate) * TIMER_HZ;
  const syncTicks = ticks(syncSamples);
  const oneTicks = ticks(BIT_SAMPLES[1]);
  const zeroTicks = ticks(BIT_SAMPLES[0]);
  // The firmware reads an 8-bit timer, so it works in whole ticks.
  const threshold = Math.floor(Math.floor(syncTicks) / 4);
  return {
    rate,
    syncTicks,
    oneTicks,
    zeroTicks,
    threshold,
    /** Ticks by which a sync pulse clears the sync threshold. */
    syncHeadroom: syncTicks - SYNC_TICK_THRESHOLD,
    /** Ticks by which a 1 bit stays below the sync threshold. */
    oneHeadroom: SYNC_TICK_THRESHOLD - oneTicks,
    /** Ticks between each bit length and the 0/1 decision point. */
    zeroMargin: threshold - zeroTicks,
    oneMargin: oneTicks - threshold,
  };
}

/**
 * One number for how comfortable a rate is: the tightest of the four margins
 * above, in timer ticks. At or below zero it cannot work at all.
 */
export function rateHeadroom(rate, syncSamples = SYNC_SAMPLES) {
  const t = timing(rate, syncSamples);
  return Math.min(t.syncHeadroom, t.oneHeadroom, t.zeroMargin, t.oneMargin);
}

/**
 * Whether a rate can be decoded at all.
 *
 * The two clearances from the 40-tick sync threshold need real margin, because
 * ISR bias pushes every measurement toward it — that is what kills 16000. The
 * 0-versus-1 decision point only needs to separate the two bit lengths, since it
 * is derived from the sync pulse the receiver just measured and so tracks the
 * same bias; 48000 works on hardware with only 2 ticks there.
 */
export function rateIsUsable(rate, syncSamples = SYNC_SAMPLES) {
  const t = timing(rate, syncSamples);
  return (
    t.syncHeadroom >= MIN_TICK_MARGIN &&
    t.oneHeadroom >= MIN_TICK_MARGIN &&
    t.zeroMargin > 0 &&
    t.oneMargin > 0
  );
}

/**
 * The transfer speeds the editor offers, fastest first.
 *
 * All three are confirmed on hardware: 48000 and 32000 directly, and 22050 sits
 * between 32000 and the 17361 floor with 11.7 ticks of 1-bit clearance, against
 * the 0.9 that made 16000 fail. 32000 is the measured-best rate and is what the
 * editor preselects, so nobody has to think about this; 48000 is quickest, and
 * 22050 is the slow option for a poor audio path.
 */
export const OFFERED_RATES = [48000, TESTED_BEST_RATE, 22050];

/** The rate to use unless someone chooses otherwise. */
export const DEFAULT_RATE = TESTED_BEST_RATE;

/**
 * How to deliver a chosen rate on a given output device.
 *
 * Best case, the audio stack opened the device at the rate we asked for and we
 * simply play the samples. Failing that, a whole-number division of the device's
 * rate is still exact — emitting each sample twice at 48 kHz is bit-identical to
 * generating at 24 kHz — so we take the division landing nearest what was asked
 * for rather than resampling. Returns null if the device offers nothing usable.
 */
export function deliveryPlan(contextRate, targetRate) {
  if (rateIsUsable(targetRate)) {
    if (contextRate === targetRate) return { rate: targetRate, repeat: 1, exact: true };
    if (contextRate % targetRate === 0) {
      return { rate: targetRate, repeat: contextRate / targetRate, exact: true };
    }
  }
  let best = null;
  for (let repeat = 1; repeat <= 4; repeat++) {
    const rate = contextRate / repeat;
    if (!rateIsUsable(rate)) continue;
    if (!best || Math.abs(rate - targetRate) < Math.abs(best.rate - targetRate)) {
      best = { rate, repeat, exact: false };
    }
  }
  return best;
}

/** Exact number of samples a transfer takes, for a given payload and rate. */
export function sampleCount(data, sampleRate, syncSamples = SYNC_SAMPLES) {
  return plan(data, sampleRate, syncSamples).total;
}

/**
 * How long a transfer takes, in seconds.
 *
 * Exact when given the payload, since a 1 bit is five samples and a 0 bit three,
 * so the length depends on the data. Without it, an estimate assuming an even
 * mix of bits.
 */
export function durationSeconds(rate, data = null, syncSamples = SYNC_SAMPLES) {
  if (data) return sampleCount(data, rate, syncSamples) / rate;
  const blocks = BLOCK_COUNT;
  const dataSamples = blocks * 18 * 8 * 4;
  const syncsPerMs = rate / syncSamples / 1000;
  const syncSampleCount =
    (LEAD_IN_SYNCS +
      Math.trunc(syncsPerMs * BOOT_WAIT_MS) +
      TAIL_SYNCS +
      blocks * Math.trunc(syncsPerMs * 5) +
      Math.floor(blocks / 4) * Math.trunc(syncsPerMs * 10)) *
    syncSamples;
  return (rate * SILENCE_SECONDS + dataSamples + syncSampleCount) / rate;
}
