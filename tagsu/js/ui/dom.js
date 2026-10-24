/** Tiny DOM helpers. No framework, no build step. */

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }
  append(node, children);
  return node;
}

export function append(node, children) {
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.firstChild.remove();
  return node;
}

export function button(label, props = {}) {
  return el('button', { type: 'button', ...props }, label);
}

/** A labelled group of mutually exclusive buttons. */
export function segmented(options, selected, onPick) {
  const group = el('div', { class: 'segmented', role: 'group' });
  for (const option of options) {
    group.append(
      button(option.label, {
        class: option.value === selected ? 'seg selected' : 'seg',
        title: option.title || option.label,
        disabled: option.disabled,
        onclick: () => onPick(option.value),
      }),
    );
  }
  return group;
}
