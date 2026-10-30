// Teste do merge em JavaScript fora do navegador (Node 18+).
// Baixa init + N segmentos de cada câmera do servidor ao vivo, roda o MESMO
// web/hevc-merge.js que a página usa e grava um MP4 com o resultado, para o
// scripts/08_verify_live.sh conferir bit a bit contra as fontes.
//
//   node tools/test-merge.mjs [url-do-mpd] [saida.mp4] [n-segmentos] [cams]
import { writeFileSync } from 'node:fs';
import { createMerger } from '../web/hevc-merge.js';

const mpdUrl = process.argv[2] || 'http://127.0.0.1:8080/live.mpd';
const outPath = process.argv[3] || 'build/web_merged.mp4';
const nSeg = Number(process.argv[4] || 5);
const cams = (process.argv[5] || '1,2,3,4').split(',').map(Number);

const get = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} em ${url}`);
  return new Uint8Array(await r.arrayBuffer());
};

const mpd = await (await fetch(mpdUrl)).text();
const ast = Date.parse(mpd.match(/availabilityStartTime="([^"]+)"/)[1]);
const templates = [...mpd.matchAll(/<SegmentTemplate([^>]*)\/?>/g)].map((m) => {
  const a = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1], x[2]]));
  return { media: new URL(a.media, mpdUrl).href, init: new URL(a.initialization, mpdUrl).href,
    dur: Number(a.duration) / Number(a.timescale), start: Number(a.startNumber || 1) };
});
const sel = cams.map((c) => templates[c - 1]);
const seg = sel[0].dur;
const lastAvail = Math.floor((Date.now() - ast) / 1000 / seg) + sel[0].start - 1;
const first = lastAvail - nSeg - 1;
if (first < sel[0].start) throw new Error('Servidor no ar há pouco tempo; espere uns segundos');

console.log(`MPD ${mpdUrl}: câmeras ${cams.join(',')}, segmentos ${first}..${first + nSeg - 1} (${seg}s cada)`);
const t0 = performance.now();
const merger = createMerger(await Promise.all(sel.map((t) => get(t.init))));
console.log(`canvas ${merger.width}x${merger.height}, grade ${merger.cols}x${merger.rows}`);
const parts = [merger.init];
let inBytes = 0, mergeMs = 0;
for (let n = first; n < first + nSeg; n++) {
  const segs = await Promise.all(sel.map((t) => get(t.media.replace('$Number$', n))));
  inBytes += segs.reduce((a, s) => a + s.length, 0);
  const t = performance.now();
  parts.push(merger.mergeSegment(segs));
  mergeMs += performance.now() - t;
}
const total = parts.reduce((a, p) => a + p.length, 0);
const out = new Uint8Array(total);
let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
writeFileSync(outPath, out);
console.log(`ok: ${outPath} (${total} bytes; entrada ${inBytes} bytes; merge ${(mergeMs / nSeg).toFixed(1)} ms por segmento de ${seg}s; total ${(performance.now() - t0).toFixed(0)} ms)`);
