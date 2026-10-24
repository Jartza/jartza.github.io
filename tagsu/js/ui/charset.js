/**
 * The character set reference, and a probe you can send to a real tag.
 *
 * The display is an ST7032i, so its character ROM is in the display, not in the
 * firmware, and this repository never recorded which ROM variant it is. Six
 * codes are known from the old editor and they all sit at CP437 positions, so
 * the table in js/charmap.js guesses CP437 for the rest and marks how much it
 * trusts each entry. This page shows that table and builds a payload that walks
 * the whole thing, so you can hold the result up against a real Tagsu and fix
 * the table from what you see.
 */

import { TABLE, codeToChar, encodeText } from '../charmap.js';
import { glyphRows } from '../font5x8.js';
import { build } from '../payload.js';
import { append, button, el } from './dom.js';
import { openTransferDialog } from './transfer.js';

const FIRST_ROW = 0x2;
const LAST_ROW = 0xf;

function glyphCanvas(code, scale = 3) {
  const canvas = el('canvas');
  const char = codeToChar(code);
  const rows = char === null ? null : glyphRows(char.codePointAt(0));
  const ratio = window.devicePixelRatio || 1;
  canvas.width = 5 * scale * ratio;
  canvas.height = 8 * scale * ratio;
  canvas.style.width = `${5 * scale}px`;
  canvas.style.height = `${8 * scale}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(ratio * scale, 0, 0, ratio * scale, 0, 0);
  ctx.fillStyle = '#1b2433';
  ctx.fillRect(0, 0, 5, 8);
  if (!rows) return canvas;
  ctx.fillStyle = '#f4f8ff';
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 5; x++) {
      if (rows[y] & (1 << (4 - x))) ctx.fillRect(x, y, 0.86, 0.86);
    }
  }
  return canvas;
}

function renderGrid(container) {
  const grid = el('div', { class: 'charset-grid' });
  grid.append(el('div', { class: 'head' }));
  for (let low = 0; low < 16; low++) {
    grid.append(el('div', { class: 'head', text: low.toString(16).toUpperCase() }));
  }
  for (let high = FIRST_ROW; high <= LAST_ROW; high++) {
    grid.append(el('div', { class: 'head', text: `${high.toString(16).toUpperCase()}x` }));
    for (let low = 0; low < 16; low++) {
      const code = (high << 4) | low;
      const entry = TABLE.get(code);
      const cell = el('div', {
        class: `charset-cell ${entry ? entry.confidence : 'missing'}`,
        title: entry
          ? `0x${code.toString(16).toUpperCase()} = ${entry.char} (${entry.confidence})`
          : `0x${code.toString(16).toUpperCase()} unmapped`,
      });
      append(cell, [
        glyphCanvas(code),
        el('span', { class: 'code', text: code.toString(16).toUpperCase().padStart(2, '0') }),
      ]);
      grid.append(cell);
    }
  }
  container.append(grid);
}

/**
 * One screen per block of 16 codes: the codes themselves on row 1, and which
 * block it is on row 2. Raw codes, so the probe can show codes the table only
 * guesses at.
 */
function probeScreens() {
  const screens = [];
  for (let high = FIRST_ROW; high <= LAST_ROW; high++) {
    const codes = new Uint8Array(32).fill(0x20);
    for (let low = 0; low < 16; low++) codes[low] = (high << 4) | low;
    const label = `hex ${high.toString(16).toUpperCase()}0-${high.toString(16).toUpperCase()}F`;
    const { bytes } = encodeText(label);
    codes.set(bytes.slice(0, 16), 16);
    screens.push({ id: `probe-${high}`, codes, delay: 4, in: 0, out: 0, logo: null });
  }
  return screens;
}

export function start() {
  renderGrid(document.getElementById('grid'));

  document.getElementById('probe').addEventListener('click', () => {
    openTransferDialog(build(probeScreens()));
  });

  const counts = { confirmed: 0, reported: 0 };
  for (const entry of TABLE.values()) counts[entry.confidence]++;
  document.getElementById('counts').textContent =
    `${counts.confirmed} verified here, ${counts.reported} read off a real display, ` +
    `${224 - TABLE.size} of the 224 printable codes left out because the display font cannot draw them.`;
}
