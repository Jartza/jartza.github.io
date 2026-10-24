/**
 * The logo editor: pick one of the firmware's ten built-in logos, or draw a
 * 15x16 one by hand.
 *
 * A logo occupies three characters on each row of the display, which is 15
 * pixels wide and 16 tall, and the tag stores ten of them in the 320 bytes after
 * the sequence table.
 */

import { BUILTIN_LOGOS } from '../logos.js';
import { LOGO_HEIGHT, LOGO_WIDTH } from '../payload.js';
import { packLogoRows, unpackLogoRows } from '../store.js';
import { append, button, clear, el, segmented } from './dom.js';
import { openDialog } from './dialog.js';

/** Draw packed logo rows into a canvas as LCD dots. */
export function drawLogo(canvas, rows, scale = 3) {
  const ratio = window.devicePixelRatio || 1;
  canvas.width = LOGO_WIDTH * scale * ratio;
  canvas.height = LOGO_HEIGHT * scale * ratio;
  canvas.style.width = `${LOGO_WIDTH * scale}px`;
  canvas.style.height = `${LOGO_HEIGHT * scale}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(ratio * scale, 0, 0, ratio * scale, 0, 0);
  ctx.fillStyle = '#2158cf';
  ctx.fillRect(0, 0, LOGO_WIDTH, LOGO_HEIGHT);
  ctx.fillStyle = '#f4f8ff';
  for (let y = 0; y < LOGO_HEIGHT; y++) {
    const row = rows[y] || 0;
    for (let x = 0; x < LOGO_WIDTH; x++) {
      if (row & (1 << (LOGO_WIDTH - 1 - x))) ctx.fillRect(x, y, 0.86, 0.86);
    }
  }
}

function blankGrid() {
  return Array.from({ length: LOGO_HEIGHT }, () => new Array(LOGO_WIDTH).fill(0));
}

/**
 * Open the editor for a screen's logo.
 *
 * Resolves with { position, builtinIndex, rows } to set a logo, null to remove
 * it, or undefined if the dialog was dismissed.
 */
export function openLogoEditor(current) {
  return openDialog({
    title: 'Logo',
    className: 'logo-editor',
    build: (api) => {
      const state = {
        mode: current && current.builtinIndex === null ? 'custom' : 'builtin',
        position: current ? current.position : 'left',
        builtinIndex: current && current.builtinIndex !== null ? current.builtinIndex : null,
        grid: current ? unpackLogoRows(current.rows) : blankGrid(),
      };

      const tabs = el('div', { class: 'tabs' });
      const pane = el('div', { class: 'logo-pane' });
      const positionRow = el('div', { class: 'field' });
      const actions = el('div', { class: 'modal-actions' });

      const renderTabs = () => {
        clear(tabs);
        for (const [mode, label] of [
          ['builtin', 'Built-in logos'],
          ['custom', 'Draw your own'],
        ]) {
          tabs.append(
            button(label, {
              class: state.mode === mode ? 'tab selected' : 'tab',
              onclick: () => {
                state.mode = mode;
                render();
              },
            }),
          );
        }
      };

      const renderBuiltin = () => {
        const grid = el('div', { class: 'builtin-grid' });
        BUILTIN_LOGOS.forEach((logo, index) => {
          const canvas = el('canvas');
          drawLogo(canvas, logo.rows, 3);
          grid.append(
            el(
              'button',
              {
                type: 'button',
                class: state.builtinIndex === index ? 'builtin selected' : 'builtin',
                title: logo.name,
                onclick: () => {
                  state.builtinIndex = index;
                  state.grid = unpackLogoRows(logo.rows);
                  render();
                },
              },
              [canvas, el('span', { text: logo.name })],
            ),
          );
        });
        return grid;
      };

      const renderCustom = () => {
        const wrap = el('div', { class: 'custom-wrap' });
        const grid = el('div', { class: 'pixel-grid' });
        grid.style.gridTemplateColumns = `repeat(${LOGO_WIDTH}, 1fr)`;

        const preview = el('canvas', { class: 'logo-preview' });
        const refreshPreview = () => drawLogo(preview, packLogoRows(state.grid), 6);

        let painting = null;
        let last = null;
        const cells = [];
        for (let y = 0; y < LOGO_HEIGHT; y++) {
          for (let x = 0; x < LOGO_WIDTH; x++) {
            const cell = el('div', {
              class: state.grid[y][x] ? 'px on' : 'px',
              dataset: { x, y },
            });
            cells.push(cell);
            grid.append(cell);
          }
        }

        const setPixel = (x, y) => {
          if (x < 0 || y < 0 || x >= LOGO_WIDTH || y >= LOGO_HEIGHT) return;
          state.grid[y][x] = painting;
          cells[y * LOGO_WIDTH + x].classList.toggle('on', Boolean(painting));
        };

        const paintAt = (x, y) => {
          // A drag reports discrete positions, so a quick stroke can jump over
          // cells. Fill in the line between the last position and this one.
          if (last) {
            const dx = x - last.x;
            const dy = y - last.y;
            const steps = Math.max(Math.abs(dx), Math.abs(dy));
            for (let i = 1; i < steps; i++) {
              setPixel(
                last.x + Math.round((dx * i) / steps),
                last.y + Math.round((dy * i) / steps),
              );
            }
          }
          setPixel(x, y);
          last = { x, y };
          refreshPreview();
        };

        const paint = (cell) => {
          if (painting === null || !cell) return;
          paintAt(Number(cell.dataset.x), Number(cell.dataset.y));
        };

        const stop = () => {
          painting = null;
          last = null;
        };

        grid.addEventListener('pointerdown', (event) => {
          const cell = event.target.closest('.px');
          if (!cell) return;
          event.preventDefault();
          // Drawing starts by inverting whatever was under the pointer, then
          // keeps painting that same value for the rest of the stroke. We do not
          // capture the pointer, so that pointerover still fires per cell.
          painting = state.grid[Number(cell.dataset.y)][Number(cell.dataset.x)] ? 0 : 1;
          state.builtinIndex = null;
          last = null;
          paint(cell);
        });
        // pointerover fires once per cell the mouse crosses; pointermove with a
        // hit test covers touch, where events keep targeting the first element.
        grid.addEventListener('pointerover', (event) => {
          if (painting !== null) paint(event.target.closest('.px'));
        });
        grid.addEventListener('pointermove', (event) => {
          if (painting === null) return;
          paint(document.elementFromPoint(event.clientX, event.clientY)?.closest('.px'));
        });
        document.addEventListener('pointerup', stop);
        document.addEventListener('pointercancel', stop);

        const redrawCells = () => {
          for (const cell of cells) {
            cell.classList.toggle(
              'on',
              Boolean(state.grid[Number(cell.dataset.y)][Number(cell.dataset.x)]),
            );
          }
          refreshPreview();
        };

        const nudge = (dx, dy) => {
          state.builtinIndex = null;
          if (dy) {
            state.grid =
              dy > 0
                ? [state.grid[LOGO_HEIGHT - 1], ...state.grid.slice(0, -1)]
                : [...state.grid.slice(1), state.grid[0]];
          }
          if (dx) {
            state.grid = state.grid.map((row) =>
              dx > 0 ? [row[LOGO_WIDTH - 1], ...row.slice(0, -1)] : [...row.slice(1), row[0]],
            );
          }
          redrawCells();
        };

        const tools = el('div', { class: 'logo-tools' }, [
          el('div', { class: 'logo-preview-wrap' }, [
            el('span', { class: 'hint', text: 'Preview' }),
            preview,
          ]),
          el('div', { class: 'tool-row' }, [
            button('Clear', {
              onclick: () => {
                state.grid = blankGrid();
                state.builtinIndex = null;
                redrawCells();
              },
            }),
            button('Invert', {
              onclick: () => {
                state.grid = state.grid.map((row) => row.map((v) => (v ? 0 : 1)));
                state.builtinIndex = null;
                redrawCells();
              },
            }),
          ]),
          el('div', { class: 'nudge' }, [
            button('↑', { title: 'Nudge up', onclick: () => nudge(0, -1) }),
            el('div', { class: 'nudge-row' }, [
              button('←', { title: 'Nudge left', onclick: () => nudge(-1, 0) }),
              el('span', { class: 'hint', text: 'Nudge' }),
              button('→', { title: 'Nudge right', onclick: () => nudge(1, 0) }),
            ]),
            button('↓', { title: 'Nudge down', onclick: () => nudge(0, 1) }),
          ]),
        ]);

        refreshPreview();
        append(wrap, [grid, tools]);
        return wrap;
      };

      const render = () => {
        renderTabs();
        clear(pane);
        pane.append(state.mode === 'builtin' ? renderBuiltin() : renderCustom());

        clear(positionRow);
        append(positionRow, [
          el('span', { class: 'label', text: 'Position on screen' }),
          segmented(
            [
              { value: 'left', label: 'Left' },
              { value: 'right', label: 'Right' },
            ],
            state.position,
            (value) => {
              state.position = value;
              render();
            },
          ),
        ]);

        clear(actions);
        append(actions, [
          current && button('Remove logo', { class: 'danger', onclick: () => api.close(null) }),
          button('Cancel', { class: 'ghost', onclick: () => api.close(undefined) }),
          button('Use this logo', {
            class: 'primary',
            disabled: state.mode === 'builtin' && state.builtinIndex === null,
            onclick: () =>
              api.close({
                position: state.position,
                builtinIndex: state.mode === 'builtin' ? state.builtinIndex : null,
                rows: packLogoRows(state.grid),
              }),
          }),
        ]);
      };

      append(api.body, [tabs, pane, positionRow, actions]);
      render();
    },
  });
}
