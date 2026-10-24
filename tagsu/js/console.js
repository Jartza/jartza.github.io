/**
 * The tagsu.io console, ported off jQuery.
 *
 * It is a fake 8-bit prompt: type a word, get an answer. Keystrokes come from an
 * off-screen input so that tapping the page brings up a keyboard on phones.
 */

const COMMANDS = {
  help: () => [
    '',
    'Command list:',
    'WHAT - what is Tagsu',
    'SPECS - Tagsu technical data',
    'PIC - show a picture of Tagsu',
    'ABOUT - learn more about Tagsu',
    'EDIT - write new screens to your Tagsu',
    'CHARSET - which characters the display can show',
    'RAKETTITIEDE - what is Rakettitiede',
    'FACEBOOK - share on that ginger haired girl’s web page',
    'TWITTER - share on that other site nobody really uses',
    'LOAD - load file from tape',
    'SYS64738 - reset',
  ],
  what: () => [
    '',
    'Tagsu is an electronic namebadge with a 16x2 character backlit LCD screen.',
    'With the built-in modem, Tagsu is easily programmable, even by non-technical persons.',
    'It fits 42 screens of text and multiple nice effects. It is the size of a standard ID badge.',
    'It is battery powered and runs for around two days on one standard AAA battery.',
    'Tagsu weighs 100 grams with the case and the battery.',
  ],
  specs: () => [
    '',
    'Tagsu runs on a small AVR - ATtiny85.',
    'CPU speed is 8MHz. 512 bytes of RAM. 8192 bytes of Flash, of which 2048 are reserved for user data.',
    'Display is a 16x2 alphanumeric LCD. Modem speed is ~12kbps.',
  ],
  rakettitiede: () => [
    '',
    'Rakettitiede is a Finnish IT consultancy company founded in 2011.',
    'Find out more about us by using the hidden GO command!',
  ],
  rm: () => ['', '?DEVICE NOT PRESENT  ERROR'],
  finger: () => ['', '?NAUGHTY BOY  ERROR'],
};

const ALIASES = {
  whatis: 'what',
  peek: 'what',
  who: 'rakettitiede',
};

const NAVIGATION = {
  edit: 'edit.html',
  update: 'edit.html',
  save: 'edit.html',
  charset: 'charset.html',
  about: 'about.html',
  go: 'https://www.rakettitiede.com',
  sys: 'index.html',
  sys64738: 'index.html',
  run: 'mailto:tagsu@rakettitiede.com?subject=I%20can%20haz%20Tagsu',
  order: 'mailto:tagsu@rakettitiede.com?subject=I%20can%20haz%20Tagsu',
  poke: 'mailto:tagsu@rakettitiede.com?subject=I%20can%20haz%20Tagsu',
  get: 'mailto:tagsu@rakettitiede.com?subject=I%20can%20haz%20Tagsu',
};

export function startConsole(root) {
  const output = root.querySelector('.output');
  const typed = root.querySelector('.typed');
  const input = root.querySelector('input');
  let buffer = '';

  const scroll = () => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });

  const writeLines = (lines) => {
    for (const line of lines) {
      const node = document.createElement('div');
      // Plain text, so the console renders with white-space: pre-wrap to keep
      // the two spaces a C64 error message has between its words.
      node.textContent = line === '' ? '\u00a0' : line;
      output.append(node);
    }
    output.append(Object.assign(document.createElement('div'), { textContent: 'READY.' }));
    scroll();
  };

  const writeImage = (src, alt) => {
    const figure = document.createElement('div');
    const image = document.createElement('img');
    image.src = src;
    image.alt = alt;
    image.addEventListener('load', scroll);
    figure.append(image);
    output.append(figure);
    output.append(Object.assign(document.createElement('div'), { textContent: 'READY.' }));
  };

  const tape = () => {
    const overlay = document.getElementById('tape');
    overlay.style.display = 'block';
    const until = performance.now() + 2000;
    const random = () => Math.round(Math.random() * 255);
    const step = () => {
      if (performance.now() > until) {
        overlay.style.display = 'none';
        overlay.replaceChildren();
        return;
      }
      overlay.replaceChildren();
      overlay.style.background = `rgb(${random()},${random()},${random()})`;
      for (let i = 0; i < 40; i++) {
        const bar = document.createElement('div');
        bar.style.cssText = `position:absolute;left:0;width:100%;top:${Math.random() * 100}%;height:${Math.random() * 1.2}%;background:rgb(${random()},${random()},${random()})`;
        overlay.append(bar);
      }
      setTimeout(step, 50);
    };
    step();
  };

  const run = (line) => {
    const command = line.trim().split(/\s+/)[0].toLowerCase();
    if (!command) return writeLines(['']);

    const resolved = ALIASES[command] || command;

    if (resolved === 'pic') {
      return writeImage('img/tagsu_with_callouts.jpg', 'This is what a Tagsu looks like');
    }
    if (resolved === 'load') {
      tape();
      return writeLines(['', 'PRESS PLAY ON TAPE', 'LOADING', '?LOAD  ERROR']);
    }
    if (COMMANDS[resolved]) return writeLines(COMMANDS[resolved]());
    if (NAVIGATION[resolved]) {
      writeLines(['']);
      window.location.href = NAVIGATION[resolved];
      return undefined;
    }
    if (resolved === 'facebook' || resolved === 'twitter') {
      const link = document.getElementById(`${resolved}-share`);
      if (link) window.location.href = link.href;
      return undefined;
    }
    return writeLines(['', '?SYNTAX  ERROR']);
  };

  const focus = () => input.focus({ preventScroll: true });
  root.addEventListener('click', focus);
  root.addEventListener('touchend', focus);
  // Typing anywhere on the page goes to the console; this page has nothing else
  // to type into, and the alternative is a prompt that silently ignores you.
  document.addEventListener('keydown', (event) => {
    if (document.activeElement === input) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key.length === 1 || event.key === 'Enter' || event.key === 'Backspace') focus();
  });

  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const line = buffer;
    output.append(
      Object.assign(document.createElement('div'), { textContent: `> ${line.toUpperCase()}` }),
    );
    buffer = '';
    input.value = '';
    typed.textContent = '';
    run(line);
  });

  input.addEventListener('input', () => {
    buffer = input.value;
    typed.textContent = buffer.toUpperCase();
    scroll();
  });

  writeLines(['Tagsu console 1.0 initialized.', 'Type HELP for help.']);
  focus();
}
