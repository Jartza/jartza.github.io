/**
 * Saved screen sets in localStorage.
 *
 * Everything read back from storage is put through coerceScreen() before the
 * editor sees it. Saves can be old, hand-edited or damaged, and a single bad
 * entry used to be enough to stop the editor loading at all, so each field is
 * checked and anything unusable is replaced or dropped.
 *
 * This also migrates what the old Angular editor left behind. That used
 * angular-local-storage with the prefix "tagsu", so keys look like
 * "tagsu.<name>" holding { settings: [...], time: <ms> }, with logo pixels as
 * arrays of 0 and 1 rather than packed row words.
 */

import { BUILTIN_LOGOS } from './logos.js';
import { DEFAULT_DELAY, LOGO_HEIGHT, LOGO_WIDTH, newScreen } from './payload.js';

const PREFIX = 'tagsu.v2.';
const LEGACY_PREFIX = 'tagsu.';
const CURRENT_KEY = 'tagsu.v2.current';

function read(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function available() {
  try {
    const probe = '__tagsu_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------- logo packing */

/** Pack a 16x15 grid of 0/1 into the row words the firmware expects. */
export function packLogoRows(grid) {
  return grid.map((row) => {
    let value = 0;
    for (let x = 0; x < LOGO_WIDTH; x++) {
      if (row[x]) value |= 1 << (LOGO_WIDTH - 1 - x);
    }
    return value;
  });
}

/** Unpack row words back into a 16x15 grid of 0/1 for the logo editor. */
export function unpackLogoRows(rows) {
  const grid = [];
  for (let y = 0; y < LOGO_HEIGHT; y++) {
    const row = [];
    const value = rows[y] || 0;
    for (let x = 0; x < LOGO_WIDTH; x++) {
      row.push(value & (1 << (LOGO_WIDTH - 1 - x)) ? 1 : 0);
    }
    grid.push(row);
  }
  return grid;
}

/* ---------------------------------------------------------------- coercion */

function clampInt(value, min, max, fallback) {
  const number = parseInt(value, 10);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
}

function coerceLogo(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.rows)) return null;

  // A valid built-in index is authoritative, so the bitmap is taken from the
  // firmware's own table rather than from whatever was stored alongside it.
  const index = raw.builtinIndex;
  const builtinIndex =
    Number.isInteger(index) && index >= 0 && index < BUILTIN_LOGOS.length ? index : null;
  if (builtinIndex !== null) {
    return {
      position: raw.position === 'right' ? 'right' : 'left',
      builtinIndex,
      rows: [...BUILTIN_LOGOS[builtinIndex].rows],
    };
  }

  // The old editor stored each row as 15 zeros and ones; we store a row word.
  const source = Array.isArray(raw.rows[0]) ? packLogoRows(raw.rows) : raw.rows;
  const rows = [];
  for (let y = 0; y < LOGO_HEIGHT; y++) {
    const value = Number(source[y]);
    rows.push(Number.isInteger(value) && value > 0 ? value & 0x7fff : 0);
  }
  return { position: raw.position === 'right' ? 'right' : 'left', builtinIndex: null, rows };
}

/**
 * Build a well-formed screen from whatever came out of storage, or null if the
 * value cannot be a screen at all. Handles both the current shape and the old
 * editor's, which called the logo a "sprite".
 */
export function coerceScreen(raw) {
  // typeof [] is 'object', and an array is not a screen.
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const screen = newScreen();
  if (typeof raw.id === 'string' && raw.id) screen.id = raw.id;
  screen.text1 = typeof raw.text1 === 'string' ? raw.text1 : '';
  screen.text2 = typeof raw.text2 === 'string' ? raw.text2 : '';
  screen.align1 = clampInt(raw.align1, 0, 2, 0);
  screen.align2 = clampInt(raw.align2, 0, 2, 0);
  screen.double = Boolean(raw.double);
  screen.delay = clampInt(raw.delay, 1, 255, DEFAULT_DELAY);
  screen.in = clampInt(raw.in, 0, 255, 0);
  screen.out = clampInt(raw.out, 0, 255, 0);
  screen.logo = coerceLogo(raw.logo || raw.sprite);
  return screen;
}

/** Coerce a stored list, dropping entries that are not screens. */
export function coerceScreens(list) {
  return Array.isArray(list) ? list.map(coerceScreen).filter(Boolean) : [];
}

/* ------------------------------------------------------------- save slots */

/** Named save slots, newest first. The work-in-progress slot is not listed. */
export function list() {
  if (!available()) return [];
  const out = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(PREFIX) || key === CURRENT_KEY) continue;
    const item = read(key);
    if (!item || !Array.isArray(item.screens)) continue;
    out.push({
      name: key.slice(PREFIX.length),
      time: item.time || 0,
      screens: coerceScreens(item.screens),
    });
  }
  return out.sort((a, b) => b.time - a.time);
}

export function save(name, screens) {
  return write(PREFIX + name, { screens, time: Date.now() });
}

export function load(name) {
  const item = read(PREFIX + name);
  return item && Array.isArray(item.screens) ? coerceScreens(item.screens) : null;
}

export function remove(name) {
  try {
    localStorage.removeItem(PREFIX + name);
  } catch {
    // Nothing we can do, and nothing depends on it.
  }
}

/** The editor autosaves here on every change, which the old editor never did. */
export function saveCurrent(screens) {
  return write(CURRENT_KEY, { screens, time: Date.now() });
}

export function loadCurrent() {
  const item = read(CURRENT_KEY);
  return item && Array.isArray(item.screens) ? coerceScreens(item.screens) : null;
}

/* ----------------------------------------------------------------- legacy */

/**
 * Find save slots written by the old editor. Importing is left to the caller so
 * it can ask first.
 */
export function legacySaves() {
  if (!available()) return [];
  const out = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(LEGACY_PREFIX) || key.startsWith(PREFIX)) continue;
    const name = key.slice(LEGACY_PREFIX.length);
    // The old editor read a "settings" key that it never actually wrote, and
    // listed it in its own load dialog as a bogus entry. Skip it.
    if (name === 'settings' || !name) continue;
    const item = read(key);
    if (!item || !Array.isArray(item.settings) || !item.settings.length) continue;
    const screens = coerceScreens(item.settings);
    if (!screens.length) continue;
    out.push({
      name,
      time: item.time || 0,
      screens,
      alreadyImported: read(PREFIX + name) !== null,
    });
  }
  return out.sort((a, b) => b.time - a.time);
}

export function importLegacy(entry) {
  return save(entry.name, entry.screens);
}
