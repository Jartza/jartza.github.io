/**
 * Tagsu character map: Unicode text -> display character codes.
 *
 * The display is an ST7032i, so its character generator ROM lives in the display
 * controller rather than in the firmware, and this repository never recorded
 * which ROM variant it is. The table below was read off a real badge with a
 * camera by the infr/tagsu project (MIT licensed, https://github.com/infr/tagsu,
 * written up at https://kimsalmi.com/posts/2026/tagsu/), and it checks out
 * against three independent pieces of evidence from this side:
 *
 *   - All six codes the original editor translated land exactly where it put
 *     them: ä 0x84, å 0x86, Ä 0x8E, Å 0x8F, ö 0x94, Ö 0x99.
 *   - 0xFB and 0xFC are « and », which is what firmware/tagsu_menus.c draws
 *     either side of the selected menu item. Nothing else would make sense
 *     there, and the CP437 guess this table replaced had √ and ⁿ.
 *   - 0xA0-0xDF is the HD44780 A00 katakana block, unchanged.
 *
 * Two surprises worth knowing, both normal for this family of controller:
 * 0x5C shows ¥ rather than a backslash, and 0x7E/0x7F are → and ←.
 */

import { GLYPHS } from './font5x8.js';

/** Verified from this repository: the firmware, or the original editor. */
export const CONFIRMED = 'confirmed';
/** Read off a real display by infr/tagsu, cross-checked but not re-verified. */
export const REPORTED = 'reported';

export const CONFIDENCE_ORDER = [CONFIRMED, REPORTED];

/** Codes 0x00-0x07 are the CGRAM characters a logo is uploaded into. */
export const LOGO_CODES = [0, 1, 2, 4, 5, 6];

const FIRST_CODE = 0x20;

// One character per code, starting at 0x20. Codes 0x08-0x1F hold symbols the
// editor has no use for and are left out.
const ROM =
  " !\"#$%&'()*+,-./0123456789:;<=>?" + // 0x20
  "@ABCDEFGHIJKLMNOPQRSTUVWXYZ[¥]^_" + // 0x40
  "`abcdefghijklmnopqrstuvwxyz{|}→←" + // 0x60
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜñÑªº¿" + // 0x80
  "　。「」、・ヲァィゥェォャュョッーアイウエオカキクケコサシスセソ" + // 0xA0
  "タチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン゛゜" + // 0xC0
  "áíóú¢£￥₧ƒ¡ÃãÕõØø˙¨°ˋ´½¼×÷≤≥«»≠√¯"; // 0xE0

/** The six the original editor translated, which is where this all started. */
const SCANDIC = new Set([0x84, 0x86, 0x8e, 0x8f, 0x94, 0x99]);

function confidenceFor(code, char) {
  if (SCANDIC.has(code)) return CONFIRMED;
  // The firmware prints ASCII straight to the display and it comes out right,
  // so anything that maps to itself in that range is settled. 0x5C and the two
  // arrows fail this test on purpose: they are not the ASCII character.
  if (code <= 0x7f && char === String.fromCharCode(code)) return CONFIRMED;
  return REPORTED;
}

function drawable(char) {
  return Object.prototype.hasOwnProperty.call(GLYPHS, char.codePointAt(0));
}

/**
 * code -> { char, confidence }, built once at load.
 *
 * Codes whose character is missing from the display font are left out: we could
 * not show them in the preview, so the editor must not let anyone type them.
 */
export const TABLE = (() => {
  const table = new Map();
  for (let i = 0; i < ROM.length; i++) {
    const code = FIRST_CODE + i;
    const char = ROM[i];
    if (!drawable(char)) continue;
    table.set(code, { char, confidence: confidenceFor(code, char) });
  }
  return table;
})();

/** char -> code, preferring the most trusted code if a char appears twice. */
const BY_CHAR = (() => {
  const byChar = new Map();
  for (const [code, entry] of TABLE) {
    const existing = byChar.get(entry.char);
    if (
      !existing ||
      CONFIDENCE_ORDER.indexOf(entry.confidence) <
        CONFIDENCE_ORDER.indexOf(TABLE.get(existing).confidence)
    ) {
      byChar.set(entry.char, code);
    }
  }
  return byChar;
})();

function allows(level, confidence) {
  return CONFIDENCE_ORDER.indexOf(confidence) <= CONFIDENCE_ORDER.indexOf(level);
}

/** The display code for a character, or null if it cannot be shown. */
export function charToCode(ch, level = REPORTED) {
  const code = BY_CHAR.get(ch);
  if (code === undefined) return null;
  return allows(level, TABLE.get(code).confidence) ? code : null;
}

/** The character a display code shows, or null. */
export function codeToChar(code) {
  const entry = TABLE.get(code);
  return entry ? entry.char : null;
}

export function confidenceOf(code) {
  const entry = TABLE.get(code);
  return entry ? entry.confidence : null;
}

/** Every character typable at a given trust level, in code order. */
export function usableChars(level = REPORTED) {
  const out = [];
  for (const [code, entry] of [...TABLE].sort((a, b) => a[0] - b[0])) {
    if (allows(level, entry.confidence)) out.push({ code, ...entry });
  }
  return out;
}

/** Drop every character the tag cannot show. Used to filter typing and paste. */
export function filterText(text, level = REPORTED) {
  let out = '';
  for (const ch of text) if (charToCode(ch, level) !== null) out += ch;
  return out;
}

/**
 * Encode text to display codes. Characters that cannot be shown become 0x20 and
 * are reported in `rejected`, so the caller can complain rather than ship
 * something the tag will render as noise.
 */
export function encodeText(text, level = REPORTED) {
  const bytes = [];
  const rejected = [];
  let index = 0;
  for (const ch of text) {
    const code = charToCode(ch, level);
    if (code === null) {
      rejected.push({ index, char: ch });
      bytes.push(0x20);
    } else {
      bytes.push(code);
    }
    index++;
  }
  return { bytes, rejected };
}
