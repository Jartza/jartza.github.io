/**
 * Build the 2048-byte image the firmware expects in the top of its flash.
 *
 * Layout, from firmware/tagsu_data.c (flash addresses, and the offsets they map
 * to inside the 2048-byte transfer):
 *
 *   0x1800  texts      42 * 32 bytes = 1344   offset    0
 *   0x1D40  sequences  42 *  6 bytes =  252   offset 1344
 *           (unused gap up to the font)
 *   0x1EC0  font      160 * uint16   =  320   offset 1728
 *
 * We pad the sequence area out to 64 slots, which is what the old editor did:
 * 42 * 32 + 64 * 6 = 1728, exactly the font offset, so the padding fills the gap
 * the firmware leaves between the sequence array and the font. 0xFF in the first
 * byte of a sequence terminates the list (tagsu_loop in tagsu_mainloop.c).
 */

import { encodeText } from './charmap.js';

export const MAX_SCREENS = 42;
export const TEXT_LENGTH = 32;
export const ROW_LENGTH = 16;
export const SEQUENCE_SLOTS = 64;
export const SEQUENCE_SIZE = 6;
export const FONT_OFFSET = MAX_SCREENS * TEXT_LENGTH + SEQUENCE_SLOTS * SEQUENCE_SIZE;
export const FONT_BYTES = 320;
export const BYTES_PER_LOGO = 32;
export const MAX_CUSTOM_LOGOS = FONT_BYTES / BYTES_PER_LOGO; // 10
export const PAYLOAD_SIZE = FONT_OFFSET + FONT_BYTES; // 2048

/** A logo covers three characters, i.e. 15 of the 16 columns' worth of pixels. */
export const LOGO_COLUMNS = 3;
export const LOGO_WIDTH = 15;
export const LOGO_HEIGHT = 16;

export const ALIGN_LEFT = 0;
export const ALIGN_CENTER = 1;
export const ALIGN_RIGHT = 2;

/**
 * Seconds a new screen is shown for.
 *
 * A screen holds 32 characters, which is a couple of seconds' reading, and the
 * badge is something people glance at while it cycles. The old editor defaulted
 * to 8 seconds, which is a long time to stand in front of someone's chest.
 */
export const DEFAULT_DELAY = 5;

const FLAG_DOUBLE = 0x80;
const FLAG_BUILTIN_LOGO = 0x40;
const FLAG_CUSTOM_LOGO = 0x80;

/** Transitions that drive the CGRAM themselves, so they cannot share a logo. */
export function transitionUsesCgram(code) {
  const effect = code & 0x7f;
  return effect === 8 || effect === 16 || (effect >= 32 && effect <= 36);
}

/** How many columns of text fit on a row, given whether the screen has a logo. */
export function rowCapacity(screen) {
  return ROW_LENGTH - (screen.logo ? LOGO_COLUMNS : 0);
}

export function newScreen() {
  return {
    id: crypto.randomUUID(),
    text1: '',
    text2: '',
    align1: ALIGN_LEFT,
    align2: ALIGN_LEFT,
    double: false,
    delay: DEFAULT_DELAY,
    in: 0,
    out: 0,
    logo: null,
  };
}

function alignOffset(align, length, capacity) {
  if (align === ALIGN_CENTER) return Math.floor(capacity / 2 - length / 2);
  if (align === ALIGN_RIGHT) return capacity - length;
  return 0;
}

/**
 * Lay one screen out into 32 display codes: row 1 then row 2.
 *
 * The old editor padded each row only up to its nominal width, so adding a logo
 * to a screen that already had 16 characters of text pushed row 1 into row 2's
 * bytes and the logo then overwrote whatever landed underneath. Here the text is
 * clamped to the row capacity and the caller is told about it.
 */
export function layoutScreen(screen, level) {
  // The character set probe in charset.html needs to send raw codes that the
  // character map does not claim to know yet, so it supplies them directly.
  if (screen.codes) return { codes: Array.from(screen.codes), problems: [] };

  const capacity = rowCapacity(screen);
  const leftLogo = screen.logo && screen.logo.position === 'left';
  const codes = new Array(TEXT_LENGTH).fill(0x20);
  const problems = [];

  const rows = [
    { text: screen.text1, align: screen.align1, base: 0, field: 'text1' },
    { text: screen.text2, align: screen.align2, base: ROW_LENGTH, field: 'text2' },
  ];

  for (const row of rows) {
    // Double height only shows row 1, but row 2 is still transferred.
    const { bytes, rejected } = encodeText(row.text, level);
    if (rejected.length) {
      problems.push({
        field: row.field,
        kind: 'unsupported-characters',
        chars: [...new Set(rejected.map((r) => r.char))],
      });
    }
    let text = bytes;
    if (text.length > capacity) {
      text = text.slice(0, capacity);
      problems.push({ field: row.field, kind: 'too-long', capacity });
    }
    const offset =
      (leftLogo ? LOGO_COLUMNS : 0) + alignOffset(row.align, text.length, capacity);
    for (let i = 0; i < text.length; i++) {
      const column = offset + i;
      if (column >= 0 && column < ROW_LENGTH) codes[row.base + column] = text[i];
    }
  }

  // Overwrite the logo's columns with the CGRAM characters. generate_logo()
  // builds characters 0,1,2 from the top half and 4,5,6 from the bottom half.
  if (screen.logo) {
    const start = leftLogo ? 0 : ROW_LENGTH - LOGO_COLUMNS;
    for (let i = 0; i < LOGO_COLUMNS; i++) {
      codes[start + i] = i;
      codes[ROW_LENGTH + start + i] = 4 + i;
    }
  }

  return { codes, problems };
}

function sameRows(a, b) {
  return a.length === b.length && a.every((row, i) => row === b[i]);
}

/** Collect the distinct custom logos the screens use, in first-use order. */
function collectCustomLogos(screens) {
  const logos = [];
  const indexFor = new Map();
  for (const screen of screens) {
    const logo = screen.logo;
    if (!logo || logo.builtinIndex !== null) continue;
    let index = logos.findIndex((rows) => sameRows(rows, logo.rows));
    if (index < 0) {
      index = logos.length;
      logos.push(logo.rows);
    }
    indexFor.set(screen, index);
  }
  return { logos, indexFor };
}

/**
 * Check a set of screens without building anything. Returns a list of problems;
 * an empty list means build() will produce a valid payload.
 */
export function validate(screens, level) {
  const problems = [];
  if (screens.length === 0) problems.push({ kind: 'no-screens' });
  if (screens.length > MAX_SCREENS) {
    problems.push({ kind: 'too-many-screens', max: MAX_SCREENS });
  }

  screens.forEach((screen, index) => {
    const add = (problem) => problems.push({ screen: index, ...problem });
    for (const problem of layoutScreen(screen, level).problems) add(problem);

    // A logo is uploaded into the display's eight custom characters, and those
    // are not available in double-height mode, so the two cannot be combined.
    if (screen.double && screen.logo) add({ kind: 'double-height-logo' });

    const delay = Number(screen.delay);
    if (!Number.isInteger(delay) || delay < 1 || delay > 255) {
      add({ kind: 'bad-delay', value: screen.delay });
    }
    for (const field of ['in', 'out']) {
      const code = Number(screen[field]);
      if (!Number.isInteger(code) || code < 0 || code > 255) {
        add({ kind: 'bad-transition', field, value: screen[field] });
      } else if ((screen.logo || screen.double) && transitionUsesCgram(code)) {
        // transition_in() in firmware/tagsu_effects.c calls generate_logo() for
        // these, which overwrites the characters a logo lives in. They also lay
        // their animation out across both lines, which a double-height screen
        // does not have. The editor greys these options out, but an old save
        // could still carry the combination.
        add({ kind: 'transition-needs-cgram', field, value: code });
      }
    }
  });

  const { logos } = collectCustomLogos(screens);
  if (logos.length > MAX_CUSTOM_LOGOS) {
    // The old editor let this through and silently produced a short payload,
    // which made the transfer fail at the last block with ?LOAD ERROR.
    problems.push({
      kind: 'too-many-logos',
      used: logos.length,
      max: MAX_CUSTOM_LOGOS,
    });
  }
  return problems;
}

/**
 * Build the payload. Throws if the screens do not validate, so a bad payload can
 * never reach the tag.
 */
export function build(screens, level) {
  const problems = validate(screens, level);
  if (problems.length) {
    const error = new Error('Screens do not form a valid payload');
    error.problems = problems;
    throw error;
  }

  const bytes = new Uint8Array(PAYLOAD_SIZE).fill(0xff);
  const { logos, indexFor } = collectCustomLogos(screens);

  screens.forEach((screen, index) => {
    const { codes } = layoutScreen(screen, level);
    bytes.set(codes, index * TEXT_LENGTH);

    const logo = screen.logo;
    const builtin = logo && logo.builtinIndex !== null;
    const sequence = index * SEQUENCE_SIZE + MAX_SCREENS * TEXT_LENGTH;
    bytes[sequence + 0] = index | (screen.double ? FLAG_DOUBLE : 0);
    bytes[sequence + 1] = Number(screen.delay);
    bytes[sequence + 2] = Number(screen.in);
    bytes[sequence + 3] = Number(screen.out);
    bytes[sequence + 4] = !logo ? 0 : builtin ? logo.builtinIndex : indexFor.get(screen);
    bytes[sequence + 5] = !logo ? 0 : builtin ? FLAG_BUILTIN_LOGO : FLAG_CUSTOM_LOGO;
  });

  logos.forEach((rows, index) => {
    let p = FONT_OFFSET + index * BYTES_PER_LOGO;
    for (const row of rows) {
      bytes[p++] = row & 0xff;
      bytes[p++] = (row >> 8) & 0xff;
    }
  });

  if (bytes.length !== PAYLOAD_SIZE) {
    throw new Error(`payload is ${bytes.length} bytes, expected ${PAYLOAD_SIZE}`);
  }
  return bytes;
}

/** Human-readable text for a validation problem. */
export function describeProblem(problem) {
  const where = problem.screen === undefined ? '' : `Screen ${problem.screen + 1}: `;
  const row = problem.field === 'text2' ? 'row 2' : 'row 1';
  switch (problem.kind) {
    case 'no-screens':
      return 'Add at least one screen.';
    case 'too-many-screens':
      return `Too many screens, the tag holds ${problem.max}.`;
    case 'too-long':
      return `${where}${row} is longer than the ${problem.capacity} characters that fit.`;
    case 'unsupported-characters':
      return `${where}${row} uses characters the tag cannot show: ${problem.chars.join(' ')}`;
    case 'bad-delay':
      return `${where}delay must be a whole number of seconds from 1 to 255.`;
    case 'bad-transition':
      return `${where}${problem.field} transition is not a valid effect.`;
    case 'double-height-logo':
      return `${where}a logo uses the display's custom characters, which double height cannot show. Drop one of the two.`;
    case 'transition-needs-cgram':
      return `${where}the ${problem.field} effect animates its own graphics, so it needs the whole screen: no logo, and not double height.`;
    case 'too-many-logos':
      return `${problem.used} different custom logos, but the tag only stores ${problem.max}.`;
    default:
      return `${where}${problem.kind}`;
  }
}
