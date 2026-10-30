// Testa web/mv-shaka.js fora do navegador: o plugin mv:// é chamado do mesmo
// jeito que o NetworkingEngine do Shaka chama (manifesto, init, segmentos), com
// xmldom no lugar do DOMParser e um "shaka" mínimo. O resultado vai para um MP4
// que o scripts/08_verify_live.sh confere bit a bit.
//
//   node tools/test-shaka-glue.mjs [url-do-mpd] [saida.mp4] [n-segmentos]
import { writeFileSync } from 'node:fs';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { createMultiviewScheme, fetchBytes } from '../web/mv-shaka.js';

const mpdUrl = process.argv[2] || 'http://127.0.0.1:8080/live.mpd';
const outPath = process.argv[3] || 'build/shaka_glue.mp4';
const nSeg = Number(process.argv[4] || 4);

class ShakaError extends Error {
  constructor(severity, category, code, ...data) { super(`shaka.util.Error ${code} ${data[0] || ''}`); Object.assign(this, { severity, category, code, data }); }
}
ShakaError.Severity = { RECOVERABLE: 1, CRITICAL: 2 };
ShakaError.Category = { NETWORK: 1 };
ShakaError.Code = { BAD_HTTP_STATUS: 1001, HTTP_ERROR: 1002 };
const fakeShaka = { util: { Error: ShakaError, AbortableOperation: { notAbortable: (promise) => ({ promise }) } } };

const events = [];
const { plugin, state } = createMultiviewScheme(fakeShaka, {
  fetchBytes, xmlApi: { DOMParser, XMLSerializer }, onEvent: (e) => events.push(e),
});
const call = async (uri) => (await plugin(uri, { uris: [uri] }, 0).promise);
const bytesOf = (r) => new Uint8Array(r.data);

// 1. Manifesto do canvas
const manUri = `mv://manifest/merge?cams=1,2,3,4&mpd=${encodeURIComponent(mpdUrl)}`;
const man = new TextDecoder().decode(bytesOf(await call(manUri)));
const nAS = (man.match(/<AdaptationSet/g) || []).length;
const rep = man.match(/<Representation[^>]*>/)[0];
const tpl = man.match(/<SegmentTemplate[^>]*>/)[0];
console.log(`manifesto: ${nAS} AdaptationSet\n  ${rep}\n  ${tpl}`);
if (nAS !== 1 || !/width="2048"/.test(rep) || !/mv:\/\/seg\/\$Number\$\.m4s/.test(tpl)) throw new Error('manifesto do canvas inesperado');

// 2. Manifesto de uma câmera (modo comparação)
const one = new TextDecoder().decode(bytesOf(await call(`mv://manifest/cam?cam=3&mpd=${encodeURIComponent(mpdUrl)}`)));
const oneTpl = one.match(/<SegmentTemplate[^>]*>/)[0];
console.log(`manifesto cam3: ${(one.match(/<AdaptationSet/g) || []).length} AdaptationSet\n  ${oneTpl}`);

// 3. Init + segmentos, como o Shaka pediria
const ast = Date.parse(man.match(/availabilityStartTime="([^"]+)"/)[1]);
const last = Math.floor((Date.now() - ast) / 2000);
const first = last - nSeg - 1;
const parts = [bytesOf(await call('mv://seg/init.mp4'))];
for (let n = first; n < first + nSeg; n++) parts.push(bytesOf(await call(`mv://seg/${n}.m4s`)));

// 4. Segmento que ainda não existe: tem que virar erro RECUPERÁVEL (o Shaka tenta de novo)
try { await call(`mv://seg/${last + 50}.m4s`); throw new Error('esperava erro'); }
catch (e) { console.log(`segmento futuro -> code ${e.code}, severity ${e.severity === 1 ? 'RECOVERABLE' : e.severity}`); if (e.code !== 1001 || e.severity !== 1) throw e; }

const total = parts.reduce((a, p) => a + p.length, 0);
const out = new Uint8Array(total); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
writeFileSync(outPath, out);
const s = state.stats;
console.log(`ok: ${outPath}, ${s.segments} segmentos mergeados, ${(s.mergeMs / s.segments).toFixed(1)} ms/segmento, ${s.bytesIn} -> ${s.bytesOut} bytes`);
