/**
 * The Tagsu screen editor.
 *
 * Holds a list of screens, shows each one as the tag will actually display it,
 * and turns the list into the 2048-byte image the firmware expects.
 */

import { CONFIRMED, REPORTED, filterText } from '../charmap.js';
import { createContext, renderStatic, Cancelled, showScreen } from '../effects.js';
import { Lcd, drawLcd } from '../lcd.js';
import {
  ALIGN_CENTER,
  ALIGN_LEFT,
  ALIGN_RIGHT,
  MAX_CUSTOM_LOGOS,
  MAX_SCREENS,
  build,
  describeProblem,
  layoutScreen,
  newScreen,
  rowCapacity,
  validate,
} from '../payload.js';
import * as store from '../store.js';
import { confirmDialog, openDialog } from './dialog.js';
import { append, button, clear, el, segmented } from './dom.js';
import { openLogoEditor } from './logo-editor.js';
import { openTransferDialog } from './transfer.js';
import { BLINK, EFFECTS, effectOf } from './transitions.js';

const LEVEL_KEY = 'tagsu.v2.charset-level';

const state = {
  screens: [],
  level: REPORTED,
};

const cards = new Map();
let saveTimer = null;

/* ------------------------------------------------------------------ helpers */

function queueAutosave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => store.saveCurrent(state.screens), 400);
}

function changed({ structural = false } = {}) {
  queueAutosave();
  if (structural) renderList();
  else for (const card of cards.values()) card.update();
  renderStatus();
}

function usedCustomLogos() {
  const seen = [];
  for (const screen of state.screens) {
    if (!screen.logo || screen.logo.builtinIndex !== null) continue;
    if (!seen.some((rows) => rows.every((row, i) => row === screen.logo.rows[i]))) {
      seen.push(screen.logo.rows);
    }
  }
  return seen.length;
}

/* -------------------------------------------------------------- screen card */

function screenCard(screen) {
  const canvas = el('canvas', { class: 'lcd' });
  const lcd = new Lcd();
  const problemList = el('ul', { class: 'problems' });
  const body = el('div', { class: 'card-body' });
  const head = el('div', { class: 'card-head' });
  const node = el('article', { class: 'card' }, [head, body]);

  let abort = null;

  const paint = () => {
    const { codes } = layoutScreen(screen, state.level);
    renderStatic(lcd, screen, codes);
    drawLcd(canvas, lcd, { scale: 4 });
  };

  const stopAnimation = () => {
    if (abort) abort.abort();
    abort = null;
  };

  const playAnimation = async () => {
    stopAnimation();
    abort = new AbortController();
    const controller = abort;
    const { codes } = layoutScreen(screen, state.level);
    lcd.reset();
    const ctx = createContext({
      signal: controller.signal,
      onFrame: () => drawLcd(canvas, lcd, { scale: 4 }),
    });
    try {
      // One second of hold instead of the screen's real delay, which can be
      // minutes; the cycle preview uses the real delays.
      await showScreen(lcd, screen, codes, ctx, { hold: 1 });
    } catch (error) {
      if (!(error instanceof Cancelled)) throw error;
    } finally {
      if (abort === controller) abort = null;
      paint();
    }
  };

  const update = () => {
    const index = state.screens.indexOf(screen);
    const capacity = rowCapacity(screen);

    clear(head);
    append(head, [
      el('h3', { text: `Screen ${index + 1}` }),
      el('div', { class: 'card-tools' }, [
        button('↑', {
          title: 'Move up',
          disabled: index === 0,
          onclick: () => move(index, -1),
        }),
        button('↓', {
          title: 'Move down',
          disabled: index === state.screens.length - 1,
          onclick: () => move(index, 1),
        }),
        button('Duplicate', {
          disabled: state.screens.length >= MAX_SCREENS,
          onclick: () => duplicate(index),
        }),
        button('Delete', { class: 'danger', onclick: () => remove(index) }),
      ]),
    ]);

    clear(body);

    const textRow = (field, alignField, label) => {
      const input = el('input', {
        type: 'text',
        value: screen[field],
        maxlength: capacity,
        placeholder: label,
        spellcheck: 'false',
        autocomplete: 'off',
      });
      input.addEventListener('input', () => {
        // Characters the tag cannot show never make it into the model.
        const clean = filterText(input.value, state.level).slice(0, capacity);
        if (clean !== input.value) {
          const caret = Math.min(input.selectionStart, clean.length);
          input.value = clean;
          input.setSelectionRange(caret, caret);
        }
        screen[field] = clean;
        paint();
        queueAutosave();
        renderStatus();
        renderProblems();
      });
      return el('div', { class: 'field text-field' }, [
        el('span', { class: 'label', text: label }),
        input,
        segmented(
          [
            { value: ALIGN_LEFT, label: '⇤', title: 'Align left' },
            { value: ALIGN_CENTER, label: '↔', title: 'Centre' },
            { value: ALIGN_RIGHT, label: '⇥', title: 'Align right' },
          ],
          Number(screen[alignField]),
          (value) => {
            screen[alignField] = value;
            update();
            changed();
          },
        ),
      ]);
    };

    const effectField = (field, direction) => {
      const code = Number(screen[field]);
      const select = el('select');
      for (const effect of EFFECTS) {
        // These effects animate by rewriting the display's eight custom
        // characters as they run, which is the same place a logo lives and is
        // unavailable in double-height mode. Say which of the two is in the way.
        const unavailable = effect.cgram && (screen.logo || screen.double);
        const because = screen.logo ? ' (not with a logo)' : ' (not with double height)';
        select.append(
          el('option', {
            value: effect.code,
            selected: effect.code === (code & 0x7f),
            disabled: unavailable,
            text: effect[direction] + (unavailable ? because : ''),
          }),
        );
      }
      select.addEventListener('change', () => {
        screen[field] = Number(select.value) | (code & BLINK);
        update();
        changed();
      });
      const blink = el('input', { type: 'checkbox', checked: Boolean(code & BLINK) });
      blink.addEventListener('change', () => {
        screen[field] = (Number(screen[field]) & 0x7f) | (blink.checked ? BLINK : 0);
        changed();
      });
      return el('div', { class: 'field' }, [
        el('span', { class: 'label', text: direction === 'in' ? 'Appears' : 'Disappears' }),
        select,
        el('label', { class: 'check' }, [blink, 'Blink']),
      ]);
    };

    const delay = el('input', {
      type: 'number',
      min: 1,
      max: 255,
      value: screen.delay,
      class: 'delay',
    });
    delay.addEventListener('input', () => {
      const value = parseInt(delay.value, 10);
      screen.delay = Number.isNaN(value) ? delay.value : value;
      queueAutosave();
      renderStatus();
      renderProblems();
    });

    append(body, [
      el('div', { class: 'preview' }, [
        canvas,
        el('div', { class: 'preview-tools' }, [
          button('▶ Play effects', { onclick: playAnimation }),
          button('■', { title: 'Stop', onclick: stopAnimation }),
        ]),
      ]),
      textRow('text1', 'align1', 'Row 1'),
      screen.double
        ? el('p', { class: 'hint indented' }, 'Double height uses row 1 only.')
        : textRow('text2', 'align2', 'Row 2'),
      // A logo lives in the display's eight custom characters, which double
      // height cannot show, so the two are offered as mutually exclusive rather
      // than letting someone build a screen the tag will refuse.
      el('div', { class: 'field' }, [
        el('span', { class: 'label', text: 'Height' }),
        segmented(
          [
            { value: false, label: 'Normal' },
            {
              value: true,
              label: 'Double',
              disabled: Boolean(screen.logo),
              title: screen.logo
                ? 'Remove the logo first: double height cannot show custom characters.'
                : 'Double',
            },
          ],
          Boolean(screen.double),
          (value) => {
            screen.double = value;
            update();
            changed();
          },
        ),
      ]),
      el('div', { class: 'field' }, [
        el('span', { class: 'label', text: 'Logo' }),
        button(screen.logo ? 'Change logo' : 'Add a logo', {
          disabled: screen.double,
          title: screen.double
            ? 'Switch back to normal height first: double height cannot show custom characters.'
            : null,
          onclick: () => editLogo(screen),
        }),
        screen.logo &&
          segmented(
            [
              { value: 'left', label: 'Left' },
              { value: 'right', label: 'Right' },
            ],
            screen.logo.position,
            (value) => {
              screen.logo.position = value;
              changed();
            },
          ),
        screen.logo &&
          button('Remove', {
            class: 'ghost',
            onclick: () => {
              screen.logo = null;
              update();
              changed();
            },
          }),
        screen.double && el('span', { class: 'hint', text: 'Not available with double height.' }),
      ]),
      el('div', { class: 'field' }, [
        el('span', { class: 'label', text: 'Shows for' }),
        delay,
        el('span', { class: 'hint', text: 'seconds' }),
      ]),
      effectField('in', 'in'),
      effectField('out', 'out'),
      problemList,
    ]);

    paint();
    renderProblems();
  };

  function renderProblems() {
    const index = state.screens.indexOf(screen);
    const mine = validate(state.screens, state.level).filter(
      (problem) => problem.screen === index,
    );
    clear(problemList);
    for (const problem of mine) {
      problemList.append(
        el('li', { text: describeProblem({ ...problem, screen: undefined }) }),
      );
    }
    problemList.classList.toggle('empty', mine.length === 0);
  }

  update();
  // repaint redraws the canvas without rebuilding the card, so a resize cannot
  // steal focus from whatever is being typed into.
  return { node, update, stopAnimation, repaint: paint };
}

/* ------------------------------------------------------------- list actions */

/**
 * A card's buttons capture the index its last render saw, and update() derives
 * that from indexOf, which answers -1 for a screen no longer in the list. Every
 * position coming from a click is checked here before it is used.
 *
 * Skipping this is how a null ended up in a saved list: move() spliced nothing
 * out, then spliced the resulting undefined back in, and JSON.stringify writes
 * an undefined array entry as null, after which the editor would not load.
 */
function validIndex(index) {
  return Number.isInteger(index) && index >= 0 && index < state.screens.length;
}

function move(index, offset) {
  const target = index + offset;
  if (!validIndex(index) || !validIndex(target)) return;
  const [screen] = state.screens.splice(index, 1);
  state.screens.splice(target, 0, screen);
  changed({ structural: true });
}

function duplicate(index) {
  if (!validIndex(index) || state.screens.length >= MAX_SCREENS) return;
  const copy = structuredClone(state.screens[index]);
  copy.id = crypto.randomUUID();
  state.screens.splice(index + 1, 0, copy);
  changed({ structural: true });
}

async function remove(index) {
  if (!validIndex(index)) return;
  const ok = await confirmDialog({
    title: 'Delete screen',
    message: `Delete screen ${index + 1}?`,
    confirmLabel: 'Delete',
    danger: true,
  });
  // The list can have moved while the question was on screen.
  if (!ok || !validIndex(index)) return;
  state.screens.splice(index, 1);
  // Disposing of the card is renderList()'s job: it finds the entries whose
  // screens are gone, stops their animations and takes their nodes out. Doing
  // any of that here would delete the map entry renderList() looks for, leaving
  // the node orphaned in the list and the remaining cards shuffled around it.
  changed({ structural: true });
}

/** Throw everything away and start from one blank screen. */
async function newSet() {
  const worthKeeping =
    state.screens.length > 1 ||
    state.screens.some((screen) => screen.text1 || screen.text2 || screen.logo);
  if (worthKeeping) {
    const ok = await confirmDialog({
      title: 'Start a new set',
      message: 'This clears every screen here. Anything you have not saved is lost.',
      confirmLabel: 'Start a new set',
      danger: true,
    });
    if (!ok) return;
  }
  state.screens = [newScreen()];
  changed({ structural: true });
}

function addScreen() {
  if (state.screens.length >= MAX_SCREENS) return;
  state.screens.push(newScreen());
  changed({ structural: true });
}

async function editLogo(screen) {
  const result = await openLogoEditor(screen.logo);
  if (result === undefined) return;
  screen.logo = result;
  if (result) {
    // The effects that animate the custom characters cannot coexist with a logo.
    for (const field of ['in', 'out']) {
      if (effectOf(screen[field]).cgram) screen[field] = Number(screen[field]) & BLINK;
    }
  }
  const card = cards.get(screen.id);
  if (card) card.update();
  changed();
}

/* --------------------------------------------------------------- save, load */

function saveDialog() {
  return openDialog({
    title: 'Save',
    className: 'narrow',
    build: (api) => {
      const name = el('input', { type: 'text', placeholder: 'Name this set', value: '' });
      const existing = store.list();
      const doSave = () => {
        const value = name.value.trim();
        if (!value) return;
        store.save(value, state.screens);
        api.close(value);
      };
      name.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') doSave();
      });
      append(api.body, [
        el('div', { class: 'field' }, [name, button('Save', { class: 'primary', onclick: doSave })]),
        existing.length
          ? el('p', { class: 'hint', text: 'Or overwrite one of these:' })
          : el('p', { class: 'hint', text: 'Nothing saved yet.' }),
        el(
          'ul',
          { class: 'saves' },
          existing.map((item) =>
            el('li', {}, [
              button(item.name, {
                class: 'link',
                onclick: () => {
                  store.save(item.name, state.screens);
                  api.close(item.name);
                },
              }),
              el('span', { class: 'hint', text: `${item.screens.length} screens` }),
            ]),
          ),
        ),
      ]);
    },
  });
}

function loadDialog() {
  return openDialog({
    title: 'Load',
    className: 'narrow',
    build: (api) => {
      const render = () => {
        const saves = store.list();
        const legacy = store.legacySaves().filter((item) => !item.alreadyImported);
        clear(api.body);
        append(api.body, [
          saves.length
            ? el(
                'ul',
                { class: 'saves' },
                saves.map((item) =>
                  el('li', {}, [
                    button(item.name, {
                      class: 'link',
                      onclick: () => api.close(store.load(item.name)),
                    }),
                    el('span', { class: 'hint', text: `${item.screens.length} screens` }),
                    button('Delete', {
                      class: 'ghost',
                      onclick: () => {
                        store.remove(item.name);
                        render();
                      },
                    }),
                  ]),
                ),
              )
            : el('p', { class: 'hint', text: 'Nothing saved yet.' }),
          legacy.length &&
            el('div', { class: 'legacy' }, [
              el('h3', { text: 'From the old editor' }),
              el('p', {
                class: 'hint',
                text: 'These were saved by the previous version of this page.',
              }),
              el(
                'ul',
                { class: 'saves' },
                legacy.map((item) =>
                  el('li', {}, [
                    button(item.name, {
                      class: 'link',
                      onclick: () => api.close(item.screens),
                    }),
                    el('span', { class: 'hint', text: `${item.screens.length} screens` }),
                    button('Import', {
                      class: 'ghost',
                      onclick: () => {
                        store.importLegacy(item);
                        render();
                      },
                    }),
                  ]),
                ),
              ),
            ]),
        ]);
      };
      render();
    },
  });
}

/* ------------------------------------------------------------ cycle preview */

function cycleDialog() {
  return openDialog({
    title: 'Preview the whole cycle',
    className: 'cycle',
    build: (api) => {
      const canvas = el('canvas', { class: 'lcd big' });
      const caption = el('p', { class: 'hint' });
      const lcd = new Lcd();
      const controller = new AbortController();
      const ctx = createContext({
        signal: controller.signal,
        onFrame: () => drawLcd(canvas, lcd, { scale: 8 }),
      });

      append(api.body, [
        canvas,
        caption,
        el('div', { class: 'modal-actions' }, [
          button('Stop', { class: 'ghost', onclick: () => api.close() }),
        ]),
      ]);
      drawLcd(canvas, lcd, { scale: 8 });

      (async () => {
        try {
          for (let i = 0; !controller.signal.aborted; i = (i + 1) % state.screens.length) {
            const screen = state.screens[i];
            caption.textContent = `Screen ${i + 1} of ${state.screens.length}`;
            await showScreen(lcd, screen, layoutScreen(screen, state.level).codes, ctx);
          }
        } catch (error) {
          if (!(error instanceof Cancelled)) throw error;
        }
      })();

      api.body.closest('dialog').addEventListener('close', () => controller.abort());
    },
  });
}

/* ------------------------------------------------------------------- chrome */

function renderStatus() {
  const problems = validate(state.screens, state.level);
  const blocking = problems.filter((problem) => problem.kind !== 'no-screens');

  const budget = document.getElementById('budget');
  clear(budget);
  append(budget, [
    el('span', {}, `${state.screens.length} / ${MAX_SCREENS} screens`),
    el('span', {}, `${usedCustomLogos()} / ${MAX_CUSTOM_LOGOS} custom logos`),
  ]);

  const summary = document.getElementById('summary');
  clear(summary);
  const global = blocking.filter((problem) => problem.screen === undefined);
  if (global.length) {
    append(
      summary,
      global.map((problem) => el('p', { class: 'status bad', text: describeProblem(problem) })),
    );
  } else if (blocking.length) {
    summary.append(
      el('p', {
        class: 'status bad',
        text: `${blocking.length} ${blocking.length === 1 ? 'problem' : 'problems'} to fix before you can update your Tagsu.`,
      }),
    );
  }

  for (const id of ['update', 'cycle']) {
    document.getElementById(id).disabled = problems.length > 0;
  }
  document.getElementById('add').disabled = state.screens.length >= MAX_SCREENS;
}

function renderList() {
  const list = document.getElementById('screens');
  const empty = document.getElementById('empty');
  empty.hidden = state.screens.length > 0;

  for (const [id, card] of cards) {
    if (!state.screens.some((screen) => screen.id === id)) {
      card.stopAnimation();
      card.node.remove();
      cards.delete(id);
    }
  }
  for (const screen of state.screens) {
    if (!cards.has(screen.id)) cards.set(screen.id, screenCard(screen));
  }
  // Reorder in place rather than rebuilding, so previews are not restarted.
  for (const screen of state.screens) list.append(cards.get(screen.id).node);
  for (const card of cards.values()) card.update();
  renderStatus();
}

async function doUpdate() {
  try {
    await openTransferDialog(build(state.screens, state.level));
  } catch (error) {
    await confirmDialog({
      title: 'Cannot build the update',
      message: (error.problems || []).map(describeProblem).join('\n') || error.message,
      confirmLabel: 'Close',
    });
  }
}

function charsetControl() {
  const select = el('select', { id: 'charset' });
  for (const [value, label] of [
    [REPORTED, 'Full character set'],
    [CONFIRMED, 'Verified characters only'],
  ]) {
    select.append(el('option', { value, selected: value === state.level, text: label }));
  }
  select.addEventListener('change', () => {
    state.level = select.value;
    try {
      localStorage.setItem(LEVEL_KEY, state.level);
    } catch {
      // Private browsing; the choice just will not stick.
    }
    renderList();
  });
  return select;
}

export function start() {
  try {
    const stored = localStorage.getItem(LEVEL_KEY);
    if (stored) state.level = stored;
  } catch {
    // No storage, stay on the default.
  }

  state.screens = store.loadCurrent() || [];
  if (!state.screens.length) state.screens.push(newScreen());

  document.getElementById('add').addEventListener('click', addScreen);
  document.getElementById('update').addEventListener('click', doUpdate);
  document.getElementById('cycle').addEventListener('click', cycleDialog);
  document.getElementById('new').addEventListener('click', newSet);
  document.getElementById('save').addEventListener('click', saveDialog);
  document.getElementById('load').addEventListener('click', async () => {
    const screens = await loadDialog();
    if (!screens) return;
    state.screens = screens;
    changed({ structural: true });
  });
  document.getElementById('charset-slot').append(charsetControl());

  // The preview scales itself to the width it is given, so a rotation or a
  // window resize needs a redraw at the new size.
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      for (const card of cards.values()) card.repaint();
    }, 150);
  });

  if (!store.available()) {
    document.getElementById('summary').append(
      el('p', {
        class: 'status bad',
        text: 'This browser will not let the page store anything, so your work cannot be saved or kept between visits.',
      }),
    );
  }

  renderList();
}
