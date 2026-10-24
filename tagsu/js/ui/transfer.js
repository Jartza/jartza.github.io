/**
 * The "Update to Tagsu" dialog: play the modem signal out of the headphone jack,
 * or download the audio to play somewhere else.
 *
 * Three speeds are offered and 32 kHz is preselected, because that is the rate
 * measured as most reliable on real hardware. Nobody should have to choose.
 */

import { Player, download, wavBlob } from '../audio.js';
import { DEFAULT_RATE, OFFERED_RATES, durationSeconds, timing } from '../modem.js';
import { append, button, clear, el } from './dom.js';
import { openDialog } from './dialog.js';

const player = new Player();

function formatRate(rate) {
  return rate % 1000 === 0 ? `${rate / 1000} kHz` : `${(rate / 1000).toFixed(1)} kHz`;
}

/** The "why this rate" detail, for anyone who wants to see the margins. */
function timingDetail(rate) {
  const t = timing(rate);
  const row = (label, value, note) =>
    el('tr', {}, [
      el('th', { text: label }),
      el('td', { text: value }),
      el('td', { class: 'hint', text: note || '' }),
    ]);
  return el('details', { class: 'timing' }, [
    el('summary', { text: 'How the tag will see this' }),
    el('table', {}, [
      row('Sync pulse', `${t.syncTicks.toFixed(1)} ticks`, 'must be over 40'),
      row('1 bit', `${t.oneTicks.toFixed(1)} ticks`, 'must stay under 40'),
      row('0 bit', `${t.zeroTicks.toFixed(1)} ticks`, ''),
      row('Decision point', `${t.threshold} ticks`, 'sync length / 4'),
    ]),
    el('p', {
      class: 'hint',
      text:
        'The tag times every pulse with a 125 kHz timer and treats anything over 40 ticks as a sync pulse, so both the sync pulse and a 1 bit need to stay on their own side of that line.',
    }),
  ]);
}

export function openTransferDialog(payload) {
  return openDialog({
    title: 'Update your Tagsu',
    className: 'transfer',
    build: async (api) => {
      const status = el('p', { class: 'status' });
      const speedBox = el('div', { class: 'speeds' });
      const deviceLine = el('p', { class: 'hint' });
      const detail = el('div');
      const progress = el('div', { class: 'progress' }, el('span'));
      const actions = el('div', { class: 'modal-actions' });

      append(api.body, [
        el('ol', { class: 'steps' }, [
          el('li', {}, 'Plug the audio cable into your Tagsu and into this device.'),
          el('li', {}, 'Turn the volume up to maximum.'),
          el('li', {}, 'Press Update now and leave it alone until it finishes.'),
        ]),
        speedBox,
        deviceLine,
        detail,
        progress,
        status,
        actions,
      ]);

      let target = DEFAULT_RATE;
      let plan = null;
      let playing = false;
      let busy = false;

      /** Open the output device at a rate and work out how to deliver it. */
      async function selectRate(rate) {
        busy = true;
        render();
        try {
          const info = await player.prepare(rate);
          target = rate;
          plan = player.plan(rate);
          if (!plan) {
            deviceLine.textContent = `This device runs its audio at ${formatRate(info.hardwareRate)}, which leaves no usable transfer rate. Download the .wav and play it elsewhere.`;
          } else if (plan.exact) {
            deviceLine.textContent =
              rate === DEFAULT_RATE
                ? `Sending at ${formatRate(rate)}, the rate the tag likes best.`
                : `Sending at ${formatRate(rate)}.`;
          } else {
            // We could not get the device onto the requested rate, and the only
            // exact alternatives are whole-number divisions of what it does run.
            deviceLine.textContent = `This device runs its audio at ${formatRate(info.hardwareRate)} and would not switch to ${formatRate(rate)}, so this will go out at ${formatRate(plan.rate)} — the closest rate reachable without resampling.`;
          }
        } catch (error) {
          plan = null;
          deviceLine.textContent = '';
          status.textContent = `${error.message} You can still download the .wav and play it elsewhere.`;
          status.className = 'status bad';
        } finally {
          busy = false;
          render();
        }
      }

      function render() {
        clear(speedBox);
        speedBox.append(el('span', { class: 'label', text: 'Transfer speed' }));
        const group = el('div', { class: 'segmented' });
        for (const rate of OFFERED_RATES) {
          group.append(
            button(
              [
                el('strong', { text: formatRate(rate) }),
                el('span', {
                  class: 'hint',
                  text: `${durationSeconds(rate, payload).toFixed(1)} s${rate === DEFAULT_RATE ? ' · tested best' : ''}`,
                }),
              ],
              {
                class: rate === target ? 'seg selected' : 'seg',
                disabled: playing || busy,
                onclick: () => selectRate(rate),
              },
            ),
          );
        }
        speedBox.append(group);

        clear(detail);
        if (plan) detail.append(timingDetail(plan.rate));

        clear(actions);
        append(actions, [
          button('Download .wav', {
            class: 'ghost',
            disabled: playing,
            onclick: () => download(wavBlob(payload, target), 'tagsu.wav'),
            title: `${formatRate(target)}, ${durationSeconds(target, payload).toFixed(1)} s`,
          }),
          button('Download .bin', {
            class: 'ghost',
            disabled: playing,
            onclick: () =>
              download(new Blob([payload], { type: 'application/octet-stream' }), 'tagsu.bin'),
            title: 'The raw 2048 bytes, for flashing over ISP',
          }),
          playing
            ? button('Stop', { class: 'danger', onclick: () => player.stop() })
            : button('Update now', {
                class: 'primary',
                disabled: !plan || busy,
                onclick: start,
              }),
        ]);
      }

      async function start() {
        playing = true;
        status.textContent = 'Playing the update…';
        status.className = 'status busy';
        render();
        try {
          const { finished, seconds } = await player.play(payload, plan.repeat);
          const bar = progress.firstElementChild;
          const begun = performance.now();
          const tick = () => {
            if (!player.playing) return;
            bar.style.width = `${Math.min(100, ((performance.now() - begun) / (seconds * 1000)) * 100)}%`;
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
          await finished;
          bar.style.width = '100%';
          status.textContent =
            'Done. Your Tagsu should have shown a progress bar and then READY. If it showed ?LOAD  ERROR, turn the volume up or try a different speed.';
          status.className = 'status ok';
        } catch (error) {
          status.textContent = error.message;
          status.className = 'status bad';
        } finally {
          playing = false;
          render();
        }
      }

      render();
      await selectRate(DEFAULT_RATE);
    },
  });
}
