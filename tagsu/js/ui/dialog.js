/** Modal dialogs built on the native <dialog> element. */

import { append, button, clear, el } from './dom.js';

/**
 * Open a modal. `build(api)` fills api.body and calls api.close(result) when
 * done; the returned promise resolves with that result, or undefined if the
 * dialog was dismissed with Escape or the close button.
 */
export function openDialog({ title, className = '', build, width = null }) {
  const body = el('div', { class: 'modal-body' });
  const node = el('dialog', { class: `modal ${className}`.trim() }, [
    el('form', { method: 'dialog', class: 'modal-head' }, [
      el('h2', { text: title }),
      // type=submit so the method="dialog" form closes the dialog; the button
      // helper defaults to type="button", which would do nothing at all.
      button('×', { type: 'submit', class: 'modal-close', 'aria-label': 'Close' }),
    ]),
    body,
  ]);
  if (width) node.style.maxWidth = `${width}px`;

  let result;
  const api = {
    body,
    title: (text) => {
      node.querySelector('h2').textContent = text;
    },
    close(value) {
      result = value;
      node.close();
    },
  };

  document.body.append(node);
  const finished = new Promise((resolve) => {
    node.addEventListener('close', () => {
      node.remove();
      resolve(result);
    });
  });

  build(api);
  node.showModal();
  return finished;
}

/** A yes/no question. Resolves true if confirmed. */
export function confirmDialog({ title, message, confirmLabel = 'OK', danger = false }) {
  return openDialog({
    title,
    className: 'narrow',
    build: (api) => {
      append(api.body, [
        el('p', { text: message }),
        el('div', { class: 'modal-actions' }, [
          button('Cancel', { class: 'ghost', onclick: () => api.close(false) }),
          button(confirmLabel, {
            class: danger ? 'danger' : 'primary',
            onclick: () => api.close(true),
          }),
        ]),
      ]);
    },
  }).then(Boolean);
}

/** Replace the contents of a node with new children. */
export function replace(node, children) {
  clear(node);
  append(node, children);
  return node;
}
