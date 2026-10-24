/**
 * The transition effects the firmware implements, as the editor offers them.
 *
 * Bit 7 of a transition byte adds a backlight blink, so the editor exposes the
 * effect and the blink separately instead of listing every combination twice the
 * way the old one did. select_transition() in firmware/tagsu_effects.c decides
 * what the low seven bits mean.
 */

export const BLINK = 0x80;

/** `cgram` effects animate the custom characters, so they cannot share them. */
export const EFFECTS = [
  { code: 0, in: 'No effect', out: 'No effect' },
  { code: 1, in: 'Random write', out: 'Random clear' },
  { code: 2, in: 'Wall of text from left', out: 'Wall of empty from left' },
  { code: 3, in: 'Wall of text from right', out: 'Wall of empty from right' },
  { code: 4, in: 'Scroll from left', out: 'Scroll to left' },
  { code: 5, in: 'Scroll from right', out: 'Scroll to right' },
  { code: 6, in: 'Curtains in', out: 'Curtains in' },
  { code: 7, in: 'Curtains out', out: 'Curtains out' },
  { code: 8, in: 'Invaders', out: 'Invaders', cgram: true },
  { code: 16, in: 'Flying rockets', out: 'Flying rockets', cgram: true },
  { code: 32, in: 'Pac', out: 'Pac', cgram: true },
  { code: 33, in: 'Boulder', out: 'Boulder', cgram: true },
  { code: 34, in: 'Miner', out: 'Miner', cgram: true },
  { code: 35, in: 'Archer', out: 'Archer', cgram: true },
  { code: 36, in: 'Aeroplane', out: 'Aeroplane', cgram: true },
];

export function effectOf(code) {
  return EFFECTS.find((effect) => effect.code === (Number(code) & 0x7f)) || EFFECTS[0];
}

export function describe(code, direction) {
  const effect = effectOf(code);
  const blink = Number(code) & BLINK ? ' + blink' : '';
  return effect[direction] + blink;
}
