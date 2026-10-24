/**
 * A model of the tag's display, faithful enough to preview what the firmware
 * draws: an ST7032i in 2-line mode, 16 visible columns over 40 columns of DDRAM,
 * with a display shift and eight CGRAM characters.
 *
 * The off-screen columns and the shift matter: the effects in
 * firmware/tagsu_effects.c scroll text in by writing past column 15 and then
 * shifting the display, and the animated logos write at column 35 and rely on
 * the address counter wrapping from the end of line 2 to the start of line 1.
 */

import { glyphRows } from './font5x8.js';
import { codeToChar } from './charmap.js';

export const COLUMNS = 16;
export const LINE_LENGTH = 40;
export const CHAR_WIDTH = 5;
export const CHAR_HEIGHT = 8;
export const CGRAM_CHARS = 8;

export class Lcd {
  constructor() {
    this.lines = [new Uint8Array(LINE_LENGTH), new Uint8Array(LINE_LENGTH)];
    this.cgram = Array.from({ length: CGRAM_CHARS }, () => new Uint8Array(CHAR_HEIGHT));
    this.reset();
  }

  reset() {
    this.lines[0].fill(0x20);
    this.lines[1].fill(0x20);
    this.shift = 0;
    this.doubleHeight = false;
    this.backlight = true;
    this.line = 0;
    this.column = 0;
  }

  /** lcd_clearhome() */
  clearHome() {
    this.lines[0].fill(0x20);
    this.lines[1].fill(0x20);
    this.shift = 0;
    this.line = 0;
    this.column = 0;
  }

  /** lcd_goto(col, row); col may address the off-screen columns up to 39. */
  goto(column, line) {
    this.line = line & 1;
    this.column = column % LINE_LENGTH;
  }

  /**
   * lcd_data(value). The address counter auto-increments, wrapping from the end
   * of line 1 to the start of line 2 and from the end of line 2 back to the
   * start of line 1, which is what makes the fly-in logo animation work.
   */
  data(value) {
    this.lines[this.line][this.column] = value & 0xff;
    if (++this.column === LINE_LENGTH) {
      this.column = 0;
      this.line = this.line === 0 ? 1 : 0;
    }
  }

  /** lcd_print_p(): a run of characters from the current position. */
  print(values) {
    for (const value of values) this.data(value);
  }

  /** lcd_scroll(dir): 0 shifts the display left, 1 shifts it right. */
  scroll(direction) {
    this.shift =
      (this.shift + (direction ? -1 : 1) + LINE_LENGTH) % LINE_LENGTH;
  }

  /** lcd_lines(n): 1 means one line of double-height characters. */
  setLines(count) {
    this.doubleHeight = count === 1;
  }

  /** lcd_createfont(index, rows): eight rows of five pixels. */
  createFont(index, rows) {
    const target = this.cgram[index & 7];
    for (let i = 0; i < CHAR_HEIGHT; i++) target[i] = rows[i] & 0x1f;
  }

  /** The character code displayed at a visible position. */
  codeAt(line, column) {
    return this.lines[line][(this.shift + column) % LINE_LENGTH];
  }

  /**
   * The 8 pixel rows for a code, or null if we have no glyph for it. Codes
   * 0x00-0x07 come from CGRAM, everything else from the display's character ROM
   * (which we approximate with jartza's ST7032 font).
   */
  rowsFor(code) {
    if (code < CGRAM_CHARS) return this.cgram[code];
    const char = codeToChar(code);
    if (char === null) return null;
    return glyphRows(char.codePointAt(0));
  }
}

const COLOURS = {
  on: { lit: '#f4f8ff', dim: '#6c7f9e' },
  off: { lit: '#2f6ae0', dim: '#243b63' },
  background: { lit: '#2158cf', dim: '#1d2b47' },
};

/** Smallest scale still legible as a dot matrix. */
const MIN_SCALE = 2;

/**
 * Draw an Lcd onto a canvas as discrete dots.
 *
 * Grid: 16 cells of 5 dots with a one-dot gap between them, two rows of 8 dots
 * with a one-dot gap between the rows.
 *
 * `scale` is the dot size we would like. Sixteen columns is 99 dots wide, so at
 * scale 4 that is already 396 px and at scale 8 it is 792 px — wider than a
 * phone. The scale is therefore reduced to whatever fits the space the canvas
 * has, and stays a whole number so the dot grid never lands between pixels.
 */
export function drawLcd(canvas, lcd, { scale = 4, gap = 1 } = {}) {
  const dotsWide = COLUMNS * CHAR_WIDTH + (COLUMNS - 1) * gap;
  const dotsHigh = 2 * CHAR_HEIGHT + gap;
  const pad = 2;

  const available = canvas.parentElement ? canvas.parentElement.clientWidth : 0;
  if (available > 0) {
    const fits = Math.floor(available / (dotsWide + pad * 2));
    scale = Math.max(MIN_SCALE, Math.min(scale, fits));
  }

  const ratio = window.devicePixelRatio || 1;
  const width = (dotsWide + pad * 2) * scale;
  const height = (dotsHigh + pad * 2) * scale;

  if (canvas.width !== Math.round(width * ratio)) {
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
  }
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  const ctx = canvas.getContext('2d');
  ctx.setTransform(ratio * scale, 0, 0, ratio * scale, 0, 0);
  const lit = lcd.backlight;
  ctx.fillStyle = lit ? COLOURS.background.lit : COLOURS.background.dim;
  ctx.fillRect(0, 0, dotsWide + pad * 2, dotsHigh + pad * 2);

  const dot = (x, y, on) => {
    ctx.fillStyle = on
      ? lit
        ? COLOURS.on.lit
        : COLOURS.on.dim
      : lit
        ? COLOURS.off.lit
        : COLOURS.off.dim;
    // A hair under a full dot, so the matrix stays visible at small scales.
    ctx.fillRect(pad + x, pad + y, 0.86, 0.86);
  };

  for (let column = 0; column < COLUMNS; column++) {
    const x0 = column * (CHAR_WIDTH + gap);

    if (lcd.doubleHeight) {
      // One line of double-height characters.
      //
      // The controller has its own double-height ROM font, which we approximate
      // by stretching the 5x8 glyph. The custom characters are not available in
      // this mode, which is why a screen cannot carry both a logo and double
      // height, so codes 0x00-0x07 render blank here.
      const code = lcd.codeAt(0, column);
      let tall = null;
      if (code >= CGRAM_CHARS) {
        const rows = lcd.rowsFor(code);
        if (rows) {
          tall = [];
          for (const row of rows) tall.push(row, row);
        }
      }
      for (let y = 0; y < 2 * CHAR_HEIGHT; y++) {
        const row = tall ? tall[y] : 0;
        const screenY = y < CHAR_HEIGHT ? y : y + gap;
        for (let x = 0; x < CHAR_WIDTH; x++) {
          dot(x0 + x, screenY, Boolean(row & (1 << (CHAR_WIDTH - 1 - x))));
        }
      }
      continue;
    }

    for (let line = 0; line < 2; line++) {
      const rows = lcd.rowsFor(lcd.codeAt(line, column));
      const y0 = line * (CHAR_HEIGHT + gap);
      for (let y = 0; y < CHAR_HEIGHT; y++) {
        const row = rows ? rows[y] : 0;
        for (let x = 0; x < CHAR_WIDTH; x++) {
          dot(x0 + x, y0 + y, Boolean(row & (1 << (CHAR_WIDTH - 1 - x))));
        }
      }
    }
  }
}

/** Natural pixel size of a display drawn at a given scale. */
export function lcdSize(scale = 4, gap = 1) {
  const pad = 2;
  return {
    width: (COLUMNS * CHAR_WIDTH + (COLUMNS - 1) * gap + pad * 2) * scale,
    height: (2 * CHAR_HEIGHT + gap + pad * 2) * scale,
  };
}
