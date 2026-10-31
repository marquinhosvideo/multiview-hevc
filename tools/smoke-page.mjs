// Smoke test da página (web/app.js) sem navegador: jsdom + um "shaka" falso que
// faz o que o Shaka real faria com o manifesto virtual (pede o manifesto, o init
// e segmentos pelo plugin mv://). Valida a fiação da página, não o playback.
//
//   node tools/smoke-page.mjs [url-do-mpd]
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const mpd = process.argv[2] || 'http://127.0.0.1:8080/live.mpd';
const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, { url: `http://127.0.0.1:8081/?mpd=${encodeURIComponent(mpd)}`, pretendToBeVisual: true });
const w = dom.window;

for (const k of ['window', 'document', 'location', 'DOMParser', 'XMLSerializer', 'HTMLCanvasElement', 'navigator']) {
  Object.defineProperty(globalThis, k, { value: k === 'window' ? w : w[k], configurable: true, writable: true });
}
globalThis.requestAnimationFrame = (f) => setTimeout(f, 50);
globalThis.devicePixelRatio = 2;
globalThis.MediaSource = w.MediaSource = { isTypeSupported: (t) => /hvc1/.test(t) };
w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: (_, p) => (p === 'measureText' ? () => ({ width: 50 }) : () => {}), set: () => true });
w.HTMLCanvasElement.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, width: 960, height: 540 });
Object.defineProperties(w.HTMLMediaElement.prototype, {
  readyState: { get() { return 4; } },
  play: { value() { return Promise.resolve(); } },
});
Object.defineProperties(w.HTMLVideoElement.prototype, {
  videoWidth: { get() { return this._w || 0; } },
  videoHeight: { get() { return this._h || 0; } },
  getVideoPlaybackQuality: { value() { return { totalVideoFrames: 300, droppedVideoFrames: 0 }; } },
});

// ---- shaka falso
const schemes = {};
class ShakaError extends Error { constructor(s, c, code, ...d) { super(`shaka ${code}`); Object.assign(this, { severity: s, category: c, code, data: d }); } }
ShakaError.Severity = { RECOVERABLE: 1, CRITICAL: 2 }; ShakaError.Category = { NETWORK: 1 }; ShakaError.Code = { BAD_HTTP_STATUS: 1001, HTTP_ERROR: 1002 };
const players = [];
class Player {
  static version = 'v5.3.3-fake';
  static isBrowserSupported() { return true; }
  constructor() { this.listeners = {}; players.push(this); }
  async attach(v) { this.video = v; }
  configure() {}
  addEventListener(t, f) { this.listeners[t] = f; }
  getStats() { return { liveLatency: 6.2 }; }
  async destroy() { this.destroyed = true; }
  async load(uri) {
    const req = (u) => schemes.mv(u, { uris: [u] }, 0).promise;
    const man = new TextDecoder().decode(new Uint8Array((await req(uri)).data));
    const width = Number(man.match(/<Representation[^>]*\swidth="(\d+)"/)[1]);
    const height = Number(man.match(/<Representation[^>]*\sheight="(\d+)"/)[1]);
    const tpl = man.match(/<SegmentTemplate[^>]*>/)[0];
    if (tpl.includes('mv://seg/')) {
      await req('mv://seg/init.mp4');
      const ast = Date.parse(man.match(/availabilityStartTime="([^"]+)"/)[1]);
      const n = Math.floor((Date.now() - ast) / 2000) - 3;
      for (let i = n; i < n + 2; i++) await req(`mv://seg/${i}.m4s`);
    }
    this.video._w = width; this.video._h = height;
  }
}
globalThis.shaka = {
  polyfill: { installAll() {} },
  Player,
  net: { NetworkingEngine: { registerScheme: (s, p) => { schemes[s] = p; } } },
  util: { Error: ShakaError, AbortableOperation: { notAbortable: (promise) => ({ promise }) } },
};

const text = (sel) => w.document.querySelector(sel).textContent.replace(/\s+/g, ' ').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await import('../web/app.js');
await sleep(4000);
console.log('--- modo multiview');
console.log('pills :', text('#pills'));
console.log('decode:', text('#kvDecode'));
console.log('merge :', text('#kvMerge'));
console.log('inset :', text('#decodedRes'));
console.log('banner:', w.document.querySelector('#banner').hidden ? '(oculto)' : text('#banner'));

for (const l of ['side', 'bottom', 'pip', 'raw', 'grid']) {
  w.document.querySelector('#layoutBtn').click();
  w.document.querySelector(`#layoutMenu [data-layout="${l}"]`).click();
  await sleep(150);
  if (!text('#layoutName')) throw new Error(`layout ${l} sem nome`);
}
w.document.querySelector('[data-mode="compare"]').click();
await sleep(3000);
console.log('--- modo comparação');
console.log('pills :', text('#pills'));
console.log('decode:', text('#kvDecode'));
console.log('videos no DOM:', w.document.querySelectorAll('video').length, '| players criados:', players.length, '| destruídos:', players.filter((p) => p.destroyed).length);
console.log('log   :', [...w.document.querySelectorAll('#log li')].slice(0, 6).map((li) => li.textContent).reverse().join('\n        '));
const errs = [...w.document.querySelectorAll('#log li.err')].length;
console.log(errs ? `ERROS NO LOG: ${errs}` : 'sem erros no log');
process.exit(errs ? 1 : 0);
