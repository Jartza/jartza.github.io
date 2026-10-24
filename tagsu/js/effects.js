/**
 * The tag's transition effects, ported from firmware/tagsu_effects.c so the
 * editor can show what a screen will actually do.
 *
 * The firmware paces animations with watchdog sleeps, so timing is nominal
 * rather than exact; zzz(n) here uses the watchdog's nominal periods. The
 * animation speed and blink count come from EEPROM and default to the values in
 * firmware/tagsu_eeprom.c.
 */

import { ANIM_LOGOS, BUILTIN_LOGOS, ROCKET } from './logos.js';

/** Nominal watchdog periods for zzz(0..9), in milliseconds. */
export const ZZZ_MS = [16, 32, 64, 128, 250, 500, 1000, 2000, 4000, 8000];

/** eeprom_defaults() in firmware/tagsu_eeprom.c. */
export const EE_DEFAULTS = { blinks: 4, animspeed: 2 };

export class Cancelled extends Error {}

const ALIEN_TOP = [1, 2, 1, 2, 1, 2, 1, 2];
const ALIEN_BOTTOM = [5, 6, 5, 6, 5, 6, 5, 6];
const LOGO_TOP = [1, 2, 3];
const LOGO_BOTTOM = [4, 5, 6, 7];
const SPACES = new Uint8Array(32).fill(0x20);

/**
 * A run context: paces the animation, redraws, and can be cancelled.
 * `speed` > 1 runs faster than the tag, for previewing.
 */
export function createContext({ onFrame = () => {}, signal = null, speed = 1, vars = EE_DEFAULTS } = {}) {
  const sleep = (ms) =>
    new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(new Cancelled());
      const timer = setTimeout(() => {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Cancelled());
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });

  return {
    vars,
    signal,
    async zzz(n) {
      onFrame();
      await sleep(Math.max(0, ZZZ_MS[n] / speed));
    },
    frame: onFrame,
    throwIfCancelled() {
      if (signal && signal.aborted) throw new Cancelled();
    },
  };
}

/**
 * generate_logo(): build the eight CGRAM characters from a 16-row logo.
 *
 * Characters 0-3 take the top eight rows and 4-7 the bottom eight, each
 * character picking a 5-pixel slice: bits 10-14, 5-9 and 0-4. x_off slides the
 * whole logo sideways by a pixel at a time and y_off rolls it vertically.
 */
export function generateLogo(lcd, rows, xOff = 0, yOff = 0) {
  const font = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 8; j++) {
      const line = rows[((i > 3 ? j + 8 : j) + yOff) & 0x0f] || 0;
      font[j] = ((line << (5 - xOff)) >>> ((3 - (i & 0x03)) * 5)) & 0x1f;
    }
    lcd.createFont(i, font);
  }
}

/** The 16 logo rows a screen uses, or null. */
export function logoRows(screen) {
  const logo = screen.logo;
  if (!logo) return null;
  if (logo.builtinIndex !== null) {
    const builtin = BUILTIN_LOGOS[logo.builtinIndex];
    return builtin ? builtin.rows : null;
  }
  return logo.rows;
}

// A Linear Feedback Shift Register, same state and sequence as the firmware's.
let order = [15, 5, 12, 10, 7, 4, 3, 8, 2, 9, 1, 11, 6, 0, 13, 14];
let lfsr = 1;

function randomize() {
  for (let i = 0; i < 16; i++) {
    lfsr = (lfsr >> 1) | (((lfsr & 1) ^ ((lfsr >> 1) & 1)) << 3);
    const temp = order[i];
    order[i] = order[lfsr];
    order[lfsr] = temp;
  }
}

async function tNoEffect(lcd, buf, ctx) {
  lcd.goto(0, 0);
  for (let i = 0; i < 16; i++) lcd.data(buf[i]);
  lcd.goto(0, 1);
  for (let i = 0; i < 16; i++) lcd.data(buf[16 + i]);
  ctx.frame();
}

async function tRandom(lcd, buf, ctx) {
  randomize();
  for (let i = 0; i < 16; i++) {
    lcd.goto(order[i], 0);
    lcd.data(buf[order[i]]);
    await ctx.zzz(1);
    const x = (order[7] - order[i]) & 0x0f;
    lcd.goto(x, 1);
    lcd.data(buf[x + 16]);
    await ctx.zzz(1);
  }
}

async function tWall(lcd, buf, ctx, dir) {
  for (let i = 0; i < 16; i++) {
    const x = dir ? 15 - i : i;
    lcd.goto(x, 0);
    lcd.data(buf[x]);
    lcd.goto(x, 1);
    lcd.data(buf[16 + x]);
    await ctx.zzz(2);
  }
}

async function tScrollFrom(lcd, buf, ctx, dir) {
  for (let i = 0; i < 16; i++) lcd.scroll(dir ^ 1);
  await tNoEffect(lcd, buf, ctx);
  for (let i = 0; i < 16; i++) {
    lcd.scroll(dir);
    await ctx.zzz(2);
  }
}

async function tCurtains(lcd, buf, ctx, dir) {
  for (let i = 0; i < 8; i++) {
    const x = dir ? 7 - i : i;
    lcd.goto(x, 0);
    lcd.data(buf[x]);
    lcd.goto(x, 1);
    lcd.data(buf[16 + x]);
    lcd.goto(15 - x, 0);
    lcd.data(buf[15 - x]);
    lcd.goto(15 - x, 1);
    lcd.data(buf[31 - x]);
    await ctx.zzz(2);
  }
}

async function tBlink(lcd, ctx) {
  await ctx.zzz(4);
  for (let i = 0; i < ctx.vars.blinks; i++) {
    lcd.backlight = false;
    await ctx.zzz(4);
    lcd.backlight = true;
    await ctx.zzz(4);
  }
}

async function tInvaders(lcd, buf, ctx, mode) {
  let alt = 0;
  if (mode) {
    for (let i = 0; i < 24; i++) lcd.scroll(0);
    await tNoEffect(lcd, buf, ctx);
  }
  lcd.goto(16, 0);
  lcd.print(ALIEN_TOP);
  lcd.goto(16, 1);
  lcd.print(ALIEN_BOTTOM);

  for (let i = 0; i < 24; i++) {
    alt ^= 1;
    generateLogo(lcd, ANIM_LOGOS[0].frames[alt], 0, 0);
    for (let q = 0; q < ctx.vars.animspeed; q++) {
      await ctx.zzz(2);
      await ctx.zzz(1);
    }
    lcd.scroll(mode);
  }
}

async function tAnimatedLogo(lcd, buf, ctx, logonum) {
  let alt = 0;
  let y = 0;
  for (let loops = 0; loops < 21; loops++) {
    lcd.goto(loops < 5 ? loops + 35 : loops - 5, loops < 5 ? 1 : 0);
    lcd.data(loops > 4 ? buf[loops - 5] : 0x20);
    lcd.data(0x00);
    lcd.print(LOGO_TOP);

    lcd.goto(loops < 5 ? loops + 35 : loops - 5, loops < 5 ? 0 : 1);
    lcd.data(loops > 4 ? buf[16 + (loops - 5)] : 0x20);
    lcd.print(LOGO_BOTTOM);

    for (let h = 0; h < 5; h++) {
      if (!logonum) {
        generateLogo(lcd, ROCKET, h, y);
        y++;
      } else {
        generateLogo(lcd, ANIM_LOGOS[logonum].frames[alt], h, y);
      }
      for (let q = 0; q < ctx.vars.animspeed; q++) await ctx.zzz(0);
    }
    alt ^= 1;
  }
}

/** select_transition(): the effect codes the editor's dropdowns produce. */
async function selectTransition(code, lcd, buf, ctx) {
  const effect = code & 0x7f;
  if (effect === 1) return tRandom(lcd, buf, ctx);
  if (effect === 2) return tWall(lcd, buf, ctx, 0);
  if (effect === 3) return tWall(lcd, buf, ctx, 1);
  if (effect === 4) return tScrollFrom(lcd, buf, ctx, 1);
  if (effect === 5) return tScrollFrom(lcd, buf, ctx, 0);
  if (effect === 6) return tCurtains(lcd, buf, ctx, 0);
  if (effect === 7) return tCurtains(lcd, buf, ctx, 1);
  if (effect === 8) return tInvaders(lcd, buf, ctx, 1);
  if (effect === 16) return tAnimatedLogo(lcd, buf, ctx, 0);
  if (effect >= 32 && effect <= 36) return tAnimatedLogo(lcd, buf, ctx, effect - 31);
  return tNoEffect(lcd, buf, ctx);
}

/** transition_in() */
export async function transitionIn(lcd, screen, codes, ctx) {
  if (screen.double) {
    lcd.setLines(1);
    lcd.clearHome();
  }
  const rows = logoRows(screen);
  if (rows) generateLogo(lcd, rows, 0, 0);
  await selectTransition(Number(screen.in), lcd, codes, ctx);
  if (Number(screen.in) & 0x80) await tBlink(lcd, ctx);
}

/** transition_out(), which reuses the in-effects with a buffer of spaces. */
export async function transitionOut(lcd, screen, ctx) {
  if (Number(screen.out) & 0x80) await tBlink(lcd, ctx);
  await selectTransition(Number(screen.out), lcd, SPACES, ctx);
}

/** zzz_secs() */
async function zzzSecs(seconds, ctx) {
  await ctx.zzz(2);
  for (let i = 0; i < seconds; i++) await ctx.zzz(6);
}

/**
 * tagsu_show_seq(): reset, transition in, hold for the delay, transition out.
 * `hold` overrides the screen's delay so a preview need not sit there for it.
 */
export async function showScreen(lcd, screen, codes, ctx, { hold = null } = {}) {
  lcd.setLines(2);
  lcd.clearHome();
  await transitionIn(lcd, screen, codes, ctx);
  await zzzSecs(hold === null ? Number(screen.delay) : hold, ctx);
  await transitionOut(lcd, screen, ctx);
  ctx.frame();
}

/** Draw a screen with no animation at all, for the always-on previews. */
export function renderStatic(lcd, screen, codes) {
  lcd.reset();
  lcd.setLines(screen.double ? 1 : 2);
  const rows = logoRows(screen);
  if (rows) generateLogo(lcd, rows, 0, 0);
  lcd.goto(0, 0);
  for (let i = 0; i < 16; i++) lcd.data(codes[i]);
  lcd.goto(0, 1);
  for (let i = 0; i < 16; i++) lcd.data(codes[16 + i]);
}
