/**
 * The recording overlay shared by record.mjs (the pitch video) and guides.mjs
 * (the how-to guides): a visible cursor that glides to what is clicked, and a
 * caption bar. Injected into every document with `context.addInitScript`.
 *
 * `director(page)` wraps a Playwright page with the moves a recording makes —
 * caption, move, click, type, smooth scroll — and keeps a log of every caption
 * with its time, which guides.mjs turns into a WebVTT track.
 */
/* global window, requestAnimationFrame -- page.evaluate callbacks run in the browser */

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The overlay script for a viewport of `width` × `height`; `scale` sizes the caption. */
export function overlayScript({width, height, scale = 1}) {
  const px = (n) => `${Math.round(n * scale)}px`;
  return `
(() => {
  const mount = () => {
    if (document.getElementById('__cur')) return;
    const c = document.createElement('div');
    c.id = '__cur';
    c.innerHTML = '<svg width="${Math.round(26 * scale)}" height="${Math.round(26 * scale)}" viewBox="0 0 24 24"><path d="M4 2l7 19 2.6-7.6L21 11z" fill="#fff" stroke="#07090d" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    Object.assign(c.style, {position:'fixed', left:'0', top:'0', zIndex:2147483647, pointerEvents:'none',
      transform:'translate(' + (window.__cx ?? ${width / 2}) + 'px,' + (window.__cy ?? ${height * 0.7}) + 'px)',
      transition:'transform .7s cubic-bezier(.22,1,.36,1)', filter:'drop-shadow(0 2px 6px rgba(0,0,0,.6))'});
    document.documentElement.appendChild(c);
    const cap = document.createElement('div');
    cap.id = '__cap';
    Object.assign(cap.style, {position:'fixed', left:'50%', bottom:'${px(34)}', transform:'translateX(-50%)', zIndex:2147483646,
      pointerEvents:'none', maxWidth:'${px(1240)}', padding:'${px(14)} ${px(26)}', borderRadius:'${px(14)}', fontSize:'${px(25)}', lineHeight:'1.35',
      fontFamily:'"Segoe UI Variable Display","Segoe UI",system-ui,sans-serif', fontWeight:'500', color:'#fff', textAlign:'center',
      background:'rgba(7,9,13,.86)', border:'1px solid rgba(110,168,255,.35)', boxShadow:'0 12px 40px rgba(0,0,0,.5)',
      opacity:'0', transition:'opacity .35s'});
    document.documentElement.appendChild(cap);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
  window.__caption = (t) => { mount(); const e = document.getElementById('__cap'); if (!t) { e.style.opacity = '0'; return; }
    e.style.opacity = '0'; setTimeout(() => { e.textContent = t; e.style.opacity = '1'; }, 180); };
  window.__move = (x, y) => { mount(); window.__cx = x; window.__cy = y;
    document.getElementById('__cur').style.transform = 'translate(' + x + 'px,' + y + 'px)'; };
  window.__hideCursor = () => { mount(); document.getElementById('__cur').style.opacity = '0'; };
})();`;
}

/** Recording moves over `page`. `t0` is when the recording started (ms). */
export function director(page, t0 = Date.now()) {
  const captions = [];
  const now = () => (Date.now() - t0) / 1000;

  const caption = async (t) => {
    const last = captions.at(-1);
    if (last && last.end === null) last.end = now();
    if (t) captions.push({start: now(), end: null, text: t});
    await page.evaluate((x) => window.__caption?.(x), t).catch(() => {});
  };
  const hideCursor = () => page.evaluate(() => window.__hideCursor?.()).catch(() => {});

  async function moveTo(locator) {
    await locator.scrollIntoViewIfNeeded();
    const b = await locator.boundingBox();
    if (!b) return;
    await page.evaluate(([x, y]) => window.__move?.(x, y), [b.x + b.width / 2, b.y + b.height / 2]);
    await sleep(800);
  }
  async function click(locator) {
    await moveTo(locator);
    await locator.click();
    await sleep(300);
  }
  /** Types like a person, so the viewer can read along. */
  async function type(locator, text, delay = 55) {
    await moveTo(locator);
    await locator.click();
    await locator.pressSequentially(text, {delay});
  }
  /** Smooth scroll by `dy` pixels over `ms`. */
  async function glide(dy, ms = 1800) {
    await page.evaluate(
      ([dy, ms]) =>
        new Promise((r) => {
          const y0 = window.scrollY;
          const s = performance.now();
          const step = (n) => {
            const k = Math.min(1, (n - s) / ms);
            const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
            window.scrollTo(0, y0 + dy * e);
            k < 1 ? requestAnimationFrame(step) : r();
          };
          requestAnimationFrame(step);
        }),
      [dy, ms],
    );
  }
  async function glideTo(locator, offset = 120, ms = 1800) {
    const b = await locator.boundingBox();
    if (b) await glide(b.y - offset, ms);
  }
  /** Closes the last caption and returns every caption with its start and end (seconds). */
  function captionLog() {
    const last = captions.at(-1);
    if (last && last.end === null) last.end = now();
    return captions;
  }

  return {caption, hideCursor, moveTo, click, type, glide, glideTo, captionLog, now};
}

/** A WebVTT track from a caption log; `offset` shifts every cue (a trimmed start). */
export function toVtt(captions, {offset = 0, speed = 1} = {}) {
  const ts = (s) => {
    const t = Math.max(0, (s - offset) / speed);
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const sec = (t % 60).toFixed(3).padStart(6, '0');
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${sec}`;
  };
  // The burned-in caption fades in ~0.2 s after it is set; the cue follows it.
  const cues = captions
    .filter((c) => c.end - c.start > 0.3)
    .map((c, i) => `${i + 1}\n${ts(c.start + 0.2)} --> ${ts(c.end)}\n${c.text}\n`);
  return `WEBVTT\n\n${cues.join('\n')}`;
}
