// Diagnóstico de 4 (ou 2) streams HLS: dá para fazer o merge de tiles com eles?
//
//   node tools/check-hls.mjs [--segments N] [--no-decode] URL_CAM1 URL_CAM2 URL_CAM3 URL_CAM4
//   make check-hls HLS="URL1 URL2 URL3 URL4"
//
// Faz o que o player faz (lê as playlists, alinha, remuxa TS se for o caso, junta
// os segmentos) e, se houver ffmpeg, a prova definitiva: decodifica o resultado e
// compara, quadro a quadro, cada tile com a câmera decodificada sozinha. É o único
// jeito de saber se os vetores de movimento do encoder respeitam as bordas.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHlsSource } from '../web/hls-source.js';
import { fetchBytes } from '../web/mv-shaka.js';
import { parseCameraInit, initCodecString } from '../web/hevc-merge.js';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); if (i < 0) return def; const v = args[i + 1]; args.splice(i, 2); return v; };
const noDecode = args.includes('--no-decode'); if (noDecode) args.splice(args.indexOf('--no-decode'), 1);
const nSeg = Number(opt('--segments', 3));
const urls = args;
if (urls.length !== 2 && urls.length !== 4) {
  console.error('uso: node tools/check-hls.mjs [--segments N] [--no-decode] URL_CAM1 URL_CAM2 [URL_CAM3 URL_CAM4]');
  process.exit(2);
}

const mark = { ok: '\x1b[32m✔\x1b[0m', warn: '\x1b[33m!\x1b[0m', bad: '\x1b[31m✘\x1b[0m' };
const res = { bad: 0, warn: 0 };
const say = (kind, msg) => { console.log(`${mark[kind]} ${msg}`); if (kind !== 'ok') res[kind]++; };
const events = [];
const src = createHlsSource({ fetchBytes, onEvent: (e) => events.push(e) });

let m;
try { m = await src.refresh(urls); }
catch (e) {
  say('bad', `não consegui montar o merge: ${e.message}`);
  console.log('\nVeredito: com estes streams o merge NÃO funciona como estão.');
  process.exit(1);
}
for (const e of events) if (e.type === 'warning') say('warn', e.message);

console.log(`\nCanvas: ${m.width}x${m.height} (grade ${m.grid.cols}x${m.grid.rows}) · alinhamento por ${m.info.mode === 'pdt' ? 'EXT-X-PROGRAM-DATE-TIME' : 'número de sequência'} · ${m.info.slots} segmentos em comum · ${m.info.live ? 'ao vivo' : 'VOD'}\n`);
console.log('cam  container  perfil/nível        tile       CTU  TMVP  bits  codec');
for (const cam of src.state.cams) {
  const c = parseCameraInit(cam.init), h = c.hvcC.header;
  console.log(`${String(cam.index).padEnd(4)} ${cam.container.padEnd(10)} ${`prof ${h[1] & 31}, nível ${(h[12] / 30).toFixed(1)}`.padEnd(19)} ${`${c.sps.width}x${c.sps.height}`.padEnd(10)} ${String(c.sps.ctbSize).padEnd(4)} ${(c.sps.temporalMvpEnabled ? 'LIGADO' : 'off').padEnd(5)} ${c.sps.bitDepthLuma}    ${initCodecString(cam.init)}`);
}
console.log('');

// ---- verificações estruturais
const cams = src.state.cams.map((c) => ({ ...c, ...parseCameraInit(c.init) }));
if (cams.every((c) => c.container === 'fmp4')) say('ok', 'segmentos fMP4/CMAF: sem conversão');
else say('ok', `segmentos ${cams.map((c) => c.container.toUpperCase()).join('/')}: remuxados para fMP4 no cliente (sem recodificar)`);
if (cams.every((c) => c.sps.width % 64 === 0 && c.sps.height % 64 === 0)) say('ok', `tile ${cams[0].sps.width}x${cams[0].sps.height}: múltiplo de 64`);
else say('bad', `tile ${cams[0].sps.width}x${cams[0].sps.height}: largura/altura precisam ser múltiplos de 64`);
if (m.info.mode === 'pdt') say(m.info.skew <= 40 ? 'ok' : 'warn', `desvio de relógio entre câmeras (PDT): até ${m.info.skew.toFixed(0)} ms`);
else say('warn', 'sem EXT-X-PROGRAM-DATE-TIME: o pareamento depende de as câmeras numerarem os segmentos de forma idêntica');
for (const c of cams) {
  if (c.sps.temporalMvpEnabled) { say('warn', `CAM ${c.index}: TMVP ligado no SPS (predição temporal de vetor pode cruzar a borda do tile)`); break; }
}
if (cams.every((c) => !c.sps.temporalMvpEnabled)) say('ok', 'TMVP desligado em todas as câmeras');

// ---- tentativa de merge nos últimos N segmentos
const times = [...src.state.slotsByTime.keys()].slice(-nSeg);
const merged = [];
for (const t of times) {
  try { const r = await src.mergedSegment(t); merged.push({ t, ...r }); }
  catch (e) { say('bad', `merge do segmento ${t}: ${e.message}`); }
}
if (merged.length === times.length) say('ok', `merge estrutural: ${merged.length} segmentos costurados (1 slice/quadro, IDR e tempos alinhados)`);

// ---- prova definitiva: decodificar e comparar tile a tile
const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
if (merged.length && !noDecode && hasFfmpeg) {
  const dir = mkdtempSync(join(tmpdir(), 'mv-check-'));
  const md5 = (file, vf) => execFileSync('ffmpeg', ['-v', 'error', '-i', file, ...(vf ? ['-vf', vf] : []), '-f', 'framemd5', '-'], { maxBuffer: 1 << 28 })
    .toString().split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(',')[5].trim());
  const tw = cams[0].sps.width, th = cams[0].sps.height;
  const per = cams.map(() => ({ same: 0, total: 0, first: null }));
  for (const [k, seg] of merged.entries()) {
    const out = join(dir, `merged_${k}.mp4`);
    writeFileSync(out, Buffer.concat([src.mergedInit(), seg.out]));
    for (const [i, c] of cams.entries()) {
      const camFile = join(dir, `cam${c.index}_${k}.mp4`);
      writeFileSync(camFile, Buffer.concat([c.init, seg.segs[i]]));
      const ref = md5(camFile);
      const col = i % m.grid.cols, row = Math.floor(i / m.grid.cols);
      const got = md5(out, `crop=${tw}:${th}:${col * tw}:${row * th}`);
      per[i].total += ref.length;
      ref.forEach((h, f) => { if (h === got[f]) per[i].same++; else if (per[i].first === null) per[i].first = `segmento ${k + 1}, quadro ${f}`; });
    }
  }
  for (const [i, p] of per.entries()) {
    if (p.same === p.total && p.total > 0) say('ok', `CAM ${cams[i].index}: ${p.same}/${p.total} quadros idênticos à câmera decodificada sozinha`);
    else say('bad', `CAM ${cams[i].index}: só ${p.same}/${p.total} quadros idênticos (1ª divergência: ${p.first}): o encoder não respeita as bordas do tile`);
  }
} else if (!noDecode && !hasFfmpeg) say('warn', 'ffmpeg não encontrado: pulei a prova bit a bit (brew install ffmpeg)');

console.log('');
if (res.bad) console.log('Veredito: NÃO mergeável como está. Corrija os itens ✘ no encoder ou recodifique (scripts/02_encode.sh).');
else if (!merged.length || noDecode || !hasFfmpeg) console.log('Veredito: estruturalmente mergeável. Falta a prova bit a bit (precisa do ffmpeg; não rode com --no-decode) para saber se os vetores respeitam as bordas.');
else console.log(`Veredito: mergeável. Os ${merged.length} segmentos testados decodificam idênticos a cada câmera. Isso vale para este trecho; conteúdo com mais movimento junto às bordas pode divergir, então repita em outro momento.`);
process.exit(res.bad ? 1 : 0);
