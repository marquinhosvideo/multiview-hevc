// Teste da fonte HLS (web/hls*.js, web/ts-remux.js, plugin mv://) sem navegador.
//
// Gera 4 câmeras HEVC "só intra" com o ffmpeg (libx265, 1 slice, sem WPP): sem
// predição entre quadros o merge é exato por construção, então dá para conferir
// bit a bit o pipeline HLS inteiro sem o Kvazaar. Empacota cada câmera como HLS
// fMP4 e como HLS MPEG-TS, serve por HTTP e passa pelo plugin mv:// como o
// Shaka passaria. O resultado é decodificado e comparado, quadro a quadro, com
// cada câmera decodificada sozinha.
//
//   node tools/test-hls.mjs
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { createMultiviewScheme, fetchBytes } from '../web/mv-shaka.js';
import { parseMedia, parseMaster, alignSlots } from '../web/hls.js';
import { parseMpd } from '../web/dash.js';

const W = 1024, H = 576, SECONDS = 6;
const work = mkdtempSync(join(tmpdir(), 'mv-hls-'));
const sh = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 });
const sources = ['testsrc2', 'mandelbrot', 'gradients=speed=0.03:n=5', 'smptehdbars'];
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? '✔' : '✘'} ${msg}`); if (!ok) failures++; };

// ------------------------------------------------------------------ fontes
for (const [i, src] of sources.entries()) {
  sh('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `${src}${src.includes('=') ? ':' : '='}s=${W}x${H}:r=30`, '-t', String(SECONDS),
    '-vf', 'format=yuv420p,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv', '-c:v', 'libx265', '-x265-params', 'keyint=1:slices=1:no-wpp=1:repeat-headers=1:log-level=error',
    '-tag:v', 'hvc1', join(work, `cam${i + 1}.mp4`)]);
}
// Câmeras com WPP ligado (padrão do x265): o merge mantém o WPP e copia os entry points.
for (let n = 1; n <= 4; n++) {
  sh('ffmpeg', ['-v', 'error', '-y', '-i', join(work, `cam${n}.mp4`), '-vf', 'setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv', '-c:v', 'libx265',
    '-x265-params', 'keyint=1:slices=1:wpp=1:repeat-headers=1:log-level=error', '-tag:v', 'hvc1', join(work, `wpp${n}.mp4`)]);
  const dir = join(work, 'wpp', `cam${n}`); mkdirSync(dir, { recursive: true });
  sh('ffmpeg', ['-v', 'error', '-y', '-i', join(work, `wpp${n}.mp4`), '-c', 'copy', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod',
    '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', join(dir, 'seg_%d.m4s'), join(dir, 'index.m3u8')]);
}
for (const kind of ['fmp4', 'ts']) {
  for (let n = 1; n <= 4; n++) {
    const dir = join(work, kind, `cam${n}`); mkdirSync(dir, { recursive: true });
    sh('ffmpeg', ['-v', 'error', '-y', '-i', join(work, `cam${n}.mp4`), '-c', 'copy', '-f', 'hls', '-hls_time', '2',
      '-hls_playlist_type', 'vod', '-hls_flags', 'program_date_time+independent_segments',
      '-hls_segment_type', kind === 'ts' ? 'mpegts' : 'fmp4', '-hls_fmp4_init_filename', 'init.mp4',
      '-hls_segment_filename', join(dir, kind === 'ts' ? 'seg_%d.ts' : 'seg_%d.m4s'), join(dir, 'index.m3u8')]);
  }
}
// ffmpeg grava o relógio da máquina no EXT-X-PROGRAM-DATE-TIME; como cada câmera foi
// empacotada num momento, fixa um relógio comum (como encoders sincronizados teriam).
const T0 = Date.parse('2026-01-01T12:00:00.000Z');
for (const kind of ['fmp4', 'ts']) {
  for (let n = 1; n <= 4; n++) {
    const f = join(work, kind, `cam${n}`, 'index.m3u8');
    let i = 0;
    writeFileSync(f, readFileSync(f, 'utf8').replace(/#EXT-X-PROGRAM-DATE-TIME:.*/g, () => `#EXT-X-PROGRAM-DATE-TIME:${new Date(T0 + 2000 * i++).toISOString()}`));
  }
}
// Manifestos DASH (.mpd) para os mesmos segmentos fMP4: um com SegmentTimeline, outro com @duration.
const mpd = (tpl) => `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT${SECONDS}S" profiles="urn:mpeg:dash:profile:isoff-live:2011">
 <Period><AdaptationSet contentType="video" mimeType="video/mp4"><Representation id="v1" codecs="hvc1.4.10.L93.9F.A8" width="${W}" height="${H}" bandwidth="2500000">${tpl}</Representation></AdaptationSet></Period>
</MPD>`;
for (let n = 1; n <= 4; n++) {
  const d = join(work, 'fmp4', `cam${n}`);
  writeFileSync(join(d, 'manifest.mpd'), mpd(`<SegmentTemplate timescale="1000" initialization="init.mp4" media="seg_$Number$.m4s" startNumber="0"><SegmentTimeline><S t="0" d="2000" r="${SECONDS / 2 - 1}"/></SegmentTimeline></SegmentTemplate>`));
  writeFileSync(join(d, 'manifest_dur.mpd'), mpd(`<SegmentTemplate timescale="1000" duration="2000" initialization="init.mp4" media="seg_$Number$.m4s" startNumber="0"/>`));
}
// Streams independentes: origem de PTS, numeração de segmentos e relógio (PDT) diferentes em cada câmera.
for (let n = 1; n <= 4; n++) {
  const dir = join(work, 'indep', `cam${n}`); mkdirSync(dir, { recursive: true });
  sh('ffmpeg', ['-v', 'error', '-y', '-i', join(work, `cam${n}.mp4`), '-c', 'copy', '-output_ts_offset', String(n * 37.5), '-f', 'hls', '-hls_time', '2',
    '-hls_playlist_type', 'vod', '-hls_flags', 'program_date_time+independent_segments', '-start_number', String(n * 100),
    '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', join(dir, 'seg_%d.m4s'), join(dir, 'index.m3u8')]);
  const f = join(dir, 'index.m3u8');
  let i = 0;
  writeFileSync(f, readFileSync(f, 'utf8').replace(/#EXT-X-PROGRAM-DATE-TIME:.*/g, () => `#EXT-X-PROGRAM-DATE-TIME:${new Date(T0 + n * 86400000 + 2000 * i++).toISOString()}`));
}
// Variantes: "live" (sem ENDLIST) e master playlist apontando para a media playlist.
for (let n = 1; n <= 4; n++) {
  const d = join(work, 'fmp4', `cam${n}`);
  const pl = readFileSync(join(d, 'index.m3u8'), 'utf8');
  writeFileSync(join(d, 'live.m3u8'), pl.replace('#EXT-X-ENDLIST', '').replace('#EXT-X-PLAYLIST-TYPE:VOD', ''));
  writeFileSync(join(d, 'master.m3u8'), `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=${W}x${H},CODECS="hvc1.1.6.L93.B0"\nindex.m3u8\n`);
}

// ------------------------------------------------------------------ servidor
const MIME = { '.m3u8': 'application/vnd.apple.mpegurl', '.m4s': 'video/mp4', '.mp4': 'video/mp4', '.ts': 'video/mp2t' };
const server = createServer((req, res) => {
  const f = join(work, decodeURIComponent(req.url.split('?')[0]));
  try { statSync(f); res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream', connection: 'close' }); res.end(readFileSync(f)); }
  catch { res.writeHead(404); res.end(); }
}).listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

// ------------------------------------------------------------------ shaka falso
class ShakaError extends Error {
  constructor(severity, category, code, ...data) { super(`shaka.util.Error ${code}`); Object.assign(this, { severity, category, code, data }); }
}
ShakaError.Severity = { RECOVERABLE: 1, CRITICAL: 2 };
ShakaError.Category = { NETWORK: 1 };
ShakaError.Code = { BAD_HTTP_STATUS: 1001, HTTP_ERROR: 1002 };
const fakeShaka = { util: { Error: ShakaError, AbortableOperation: { notAbortable: (promise) => ({ promise }) } } };

const frameMd5 = (file, vf) => sh('ffmpeg', ['-v', 'error', '-i', file, ...(vf ? ['-vf', vf] : []), '-f', 'framemd5', '-'])
  .toString().split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(',')[5].trim());

async function run(label, playlistUrls, { expectLive, sync } = {}) {
  console.log(`\n--- ${label}`);
  const events = [];
  const { plugin } = createMultiviewScheme(fakeShaka, { fetchBytes, xmlApi: null, onEvent: (e) => events.push(e) });
  const call = async (uri) => new Uint8Array((await plugin(uri, { uris: [uri] }, 0).promise).data);
  const hls = playlistUrls.map((u) => `&hls=${encodeURIComponent(u)}`).join('');
  const mpd = new TextDecoder().decode(await call(`mv://manifest/hls?cams=1,2,3,4${sync ? `&sync=${sync}` : ''}${hls}`));
  const rep = mpd.match(/<Representation[^>]*>/)[0];
  check(/width="2048"/.test(rep) && /height="1152"/.test(rep), `manifesto com 1 representação 2048x1152 (${rep.match(/codecs="[^"]+"/)[0]})`);
  check((mpd.match(/<AdaptationSet/g) || []).length === 1, 'um único AdaptationSet');
  check(expectLive ? /type="dynamic"/.test(mpd) && /availabilityStartTime/.test(mpd) : /type="static"/.test(mpd), expectLive ? 'MPD dinâmico com availabilityStartTime' : 'MPD estático');
  const times = [...mpd.matchAll(/<S t="(\d+)" d="(\d+)"/g)].map((m) => Number(m[1]));
  check(times.length === SECONDS / 2, `${times.length} segmentos na linha do tempo`);

  const parts = [await call('mv://seg/init.mp4')];
  for (const t of times) parts.push(await call(`mv://seg/${t}.m4s`));
  const out = join(work, `${label.replace(/\W+/g, '_')}.mp4`);
  writeFileSync(out, Buffer.concat(parts));

  try { await call(`mv://seg/${times[times.length - 1] + 999999}.m4s`); check(false, 'segmento inexistente deveria falhar'); }
  catch (e) { check(e.code === 1001 && e.severity === 1, 'segmento inexistente vira erro HTTP recuperável (404)'); }

  const pos = [[0, 0], [W, 0], [0, H], [W, H]];
  for (let n = 1; n <= 4; n++) {
    const ref = frameMd5(join(work, `cam${n}.mp4`));
    const got = frameMd5(out, `crop=${W}:${H}:${pos[n - 1][0]}:${pos[n - 1][1]}`);
    const same = ref.filter((h, i) => h === got[i]).length;
    check(same === ref.length && got.length === ref.length, `cam${n}: ${same}/${ref.length} quadros idênticos à câmera isolada`);
  }
  return { events, mpd };
}

// ------------------------------------------------------------------ casos
const urls = (kind, file = 'index.m3u8') => [1, 2, 3, 4].map((n) => `${base}/${kind}/cam${n}/${file}`);
const r1 = await run('HLS fMP4 (VOD)', urls('fmp4'));
check(r1.events.some((e) => e.type === 'manifest' && e.info.mode === 'pdt'), 'alinhamento por EXT-X-PROGRAM-DATE-TIME');
await run('HLS fMP4 (live, sem ENDLIST)', urls('fmp4', 'live.m3u8'), { expectLive: true });
await run('HLS fMP4 via master playlist', urls('fmp4', 'master.m3u8'));
const r4 = await run('HLS MPEG-TS (remux em JS)', urls('ts'));
check(r4.events.some((e) => e.type === 'manifest' && e.info.containers.every((c) => c === 'ts')), 'container detectado como TS');

// Streams independentes (sem tempo em comum): o modo automático cai para o pareamento por posição.
{
  const r = await run('HLS independentes (PTS, sequência e PDT diferentes)', urls('indep'));
  check(r.events.some((e) => e.type === 'warning' && /independentes/.test(e.message)), 'avisa que tratou como streams independentes');
  check(r.events.some((e) => e.type === 'manifest' && e.info.mode === 'independent'), 'modo de pareamento: independent');
  // Sem o modo independente (relógios fora de sincronia), o merge estrito recusa com mensagem clara.
  const { plugin } = createMultiviewScheme(fakeShaka, { fetchBytes, xmlApi: null });
  const call = async (uri) => new Uint8Array((await plugin(uri, { uris: [uri] }, 0).promise).data);
  void call;
}

// Mistura: 3 câmeras fMP4 (1 fragmento por quadro) + 1 em TS (1 fragmento por segmento).
// O TS começa o PTS em 1,4 s e o fMP4 em 0: com relógios diferentes, o modo estrito recusa e o independente aceita.
{
  const mixed = [`${base}/fmp4/cam1/index.m3u8`, `${base}/fmp4/cam2/index.m3u8`, `${base}/fmp4/cam3/index.m3u8`, `${base}/ts/cam4/index.m3u8`];
  const { plugin } = createMultiviewScheme(fakeShaka, { fetchBytes, xmlApi: null });
  const q = mixed.map((u) => `&hls=${encodeURIComponent(u)}`).join('');
  const call = async (uri) => new Uint8Array((await plugin(uri, { uris: [uri] }, 0).promise).data);
  await call(`mv://manifest/hls?cams=1,2,3,4${q}`);
  const t = Number((await call(`mv://manifest/hls?cams=1,2,3,4${q}`).then((b) => new TextDecoder().decode(b))).match(/<S t="(\d+)"/)[1]);
  try { await call(`mv://seg/${t}.m4s`); check(false, 'merge estrito com tfdt diferente deveria falhar'); }
  catch (e) { check(/desalinhada no tempo/.test(String(e.data && e.data[1] && e.data[1].message)), 'modo estrito recusa relógios diferentes com mensagem clara'); }
}
await run('HLS misto fMP4 + TS, modo independente (fragmentação diferente)', [`${base}/fmp4/cam1/index.m3u8`, `${base}/fmp4/cam2/index.m3u8`, `${base}/fmp4/cam3/index.m3u8`, `${base}/ts/cam4/index.m3u8`], { sync: 'independent' });

// DASH como fonte: SegmentTimeline, @duration e mistura HLS + DASH.
await run('DASH (SegmentTimeline)', urls('fmp4', 'manifest.mpd'));
await run('DASH (@duration)', urls('fmp4', 'manifest_dur.mpd'));
await run('HLS + DASH misturados', [`${base}/fmp4/cam1/index.m3u8`, `${base}/fmp4/cam2/manifest.mpd`, `${base}/fmp4/cam3/index.m3u8`, `${base}/fmp4/cam4/manifest_dur.mpd`]);

// parseMpd: janela ao vivo, formatação %0Nd, BaseURL e recusas claras.
{
  const live = (extra = '', tpl = '<SegmentTemplate timescale="1" duration="2" initialization="i_$RepresentationID$.mp4" media="s_$Number%05d$.m4s" startNumber="10"/>') =>
    `<MPD type="dynamic" availabilityStartTime="2026-01-01T00:00:00Z" timeShiftBufferDepth="PT10S"><BaseURL>http://h/base/</BaseURL><Period start="PT0S">${extra}<AdaptationSet mimeType="video/mp4"><Representation id="A" codecs="hvc1.1.6.L93.B0" width="64" height="64" bandwidth="1">${tpl}</Representation></AdaptationSet></Period></MPD>`;
  const now = Date.parse('2026-01-01T00:01:00Z');
  const seqState = new Map();
  const a = parseMpd(live(), 'http://x/m.mpd', { now, seqState });
  check(a.segments.length === 5 && a.endList === false && a.map === 'http://h/base/i_A.mp4', 'parseMpd dinâmico @duration: janela de 5 segmentos, init e BaseURL');
  check(a.segments[0].uri === 'http://h/base/s_00035.m4s' && a.segments.at(-1).uri === 'http://h/base/s_00039.m4s', 'parseMpd: $Number%05d$ e startNumber');
  const b = parseMpd(live(), 'http://x/m.mpd', { now: now + 4000, seqState });
  check(b.segments.at(-1).seq === a.segments.at(-1).seq + 2, 'parseMpd: seq consecutivo e estável entre atualizações');
  check(a.segments[0].pdt === Date.parse('2026-01-01T00:00:50Z'), 'parseMpd: PDT derivado do availabilityStartTime');
  const refuse = (xml, re, msg) => { try { parseMpd(xml, 'http://x/m.mpd', { now }); check(false, msg); } catch (e) { check(re.test(e.message), msg); } };
  refuse(live('', '<SegmentList/>').replace('codecs="hvc1.1.6.L93.B0"', 'codecs="hvc1.1.6.L93.B0"'), /SegmentList/, 'parseMpd recusa SegmentList com mensagem clara');
  refuse(live().replace('hvc1.1.6.L93.B0', 'avc1.64001f'), /H\.264/, 'parseMpd recusa canal H.264 com mensagem clara');
  refuse(live('', '<SegmentBase indexRange="0-1"/>'), /on-demand|SegmentTemplate/, 'parseMpd recusa SegmentBase (arquivo único)');
}

// WPP: as câmeras com WPP ligado são costuradas sem recusa; compara com a câmera WPP decodificada sozinha.
{
  const { plugin } = createMultiviewScheme(fakeShaka, { fetchBytes, xmlApi: null });
  const call = async (uri) => new Uint8Array((await plugin(uri, { uris: [uri] }, 0).promise).data);
  const q = [1, 2, 3, 4].map((n) => `&hls=${encodeURIComponent(`${base}/wpp/cam${n}/index.m3u8`)}`).join('');
  const m = new TextDecoder().decode(await call(`mv://manifest/hls?cams=1,2,3,4&sync=independent${q}`));
  const times = [...m.matchAll(/<S t="(\d+)"/g)].map((x) => Number(x[1]));
  const parts = [await call('mv://seg/init.mp4')];
  for (const t of times) parts.push(await call(`mv://seg/${t}.m4s`));
  const out = join(work, 'wpp_merged.mp4'); writeFileSync(out, Buffer.concat(parts));
  const pos = [[0, 0], [0, H], [0, 2 * H], [0, 3 * H]]; // WPP: tiles empilhados em 1 coluna
  check(/width="1024"/.test(m) && /height="2304"/.test(m), 'com WPP o canvas é 1024x2304 (1 coluna)');
  for (let n = 1; n <= 4; n++) {
    const ref = frameMd5(join(work, `wpp${n}.mp4`));
    const got = frameMd5(out, `crop=${W}:${H}:${pos[n - 1][0]}:${pos[n - 1][1]}`);
    const same = ref.filter((h, i) => h === got[i]).length;
    check(same === ref.length && got.length === ref.length, `WPP cam${n}: ${same}/${ref.length} quadros idênticos à câmera isolada`);
  }
}

// Predição ponderada (pred_weight_table no slice header): barras estáticas com fade, x265 com weightp=1 e sem TMVP.
// Sem movimento e sem TMVP nada cruza a borda do tile, então o merge tem de sair bit a bit igual nas 4 câmeras:
// o que está em jogo é só o cabeçalho com a tabela de pesos (L0, e L0+L1 com B-frames) ter sido lido e copiado certo.
for (const [label, extra, bipred] of [['P', 'bframes=0:weightp=1', false], ['B', 'bframes=3:weightp=1:weightb=1', true]]) {
  const dir = join(work, `wp${label}`); mkdirSync(dir, { recursive: true });
  const bars = ['smptebars', 'smptehdbars', 'pal75bars', 'pal100bars'];
  for (let n = 1; n <= 4; n++) {
    sh('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `${bars[n - 1]}=s=${W}x${H}:r=30`, '-t', '4', '-vf',
      'fade=t=in:st=0:d=2,fade=t=out:st=2:d=2,format=yuv420p,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv',
      '-c:v', 'libx265', '-x265-params', `keyint=60:min-keyint=60:scenecut=0:slices=1:no-wpp=1:temporal-mvp=0:${extra}:repeat-headers=1:log-level=error`,
      '-tag:v', 'hvc1', join(dir, `c${n}.mp4`)]);
    const d = join(dir, `cam${n}`); mkdirSync(d, { recursive: true });
    sh('ffmpeg', ['-v', 'error', '-y', '-i', join(dir, `c${n}.mp4`), '-c', 'copy', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod',
      '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', join(d, 'seg_%d.m4s'), join(d, 'index.m3u8')]);
  }
  const { parseCameraInit } = await import('../web/hevc-merge.js');
  const pps = parseCameraInit(new Uint8Array(readFileSync(join(dir, 'cam1', 'init.mp4')))).pps;
  if (label === 'N') check(pps.weightedPred === false, 'controle (sem weightp): weighted_pred_flag desligado');
  else check(pps.weightedPred === true && pps.weightedBipred === bipred, `weightp ${label}: a fonte liga weighted_pred_flag${bipred ? ' e weighted_bipred_flag' : ''} no PPS`);
  const camFile = (n) => {
    const d = join(dir, `cam${n}`), segs = readdirSync(d).filter((f) => f.endsWith('.m4s')).sort((x, y) => Number(x.match(/\d+/)[0]) - Number(y.match(/\d+/)[0]));
    const f = join(dir, `ref${n}.mp4`);
    writeFileSync(f, Buffer.concat([readFileSync(join(d, 'init.mp4')), ...segs.map((x) => readFileSync(join(d, x)))]));
    return f;
  };
  const { plugin } = createMultiviewScheme(fakeShaka, { fetchBytes, xmlApi: null });
  const call = async (uri) => new Uint8Array((await plugin(uri, { uris: [uri] }, 0).promise).data);
  const q = [1, 2, 3, 4].map((n) => `&hls=${encodeURIComponent(`${base}/wp${label}/cam${n}/index.m3u8`)}`).join('');
  const m = new TextDecoder().decode(await call(`mv://manifest/hls?cams=1,2,3,4&sync=independent${q}`));
  const parts = [await call('mv://seg/init.mp4')];
  for (const t of [...m.matchAll(/<S t="(\d+)"/g)].map((x) => Number(x[1]))) parts.push(await call(`mv://seg/${t}.m4s`));
  const out = join(dir, 'merged.mp4'); writeFileSync(out, Buffer.concat(parts));
  // Compara os elementos de sintaxe de cada slice header (trace_headers do FFmpeg) entre a câmera
  // sozinha e o seu slice no merge. Pixels não servem aqui: com x265 os vetores podem cruzar a borda do tile.
  const slicesOf = (file) => {
    const txt = spawnSync('ffmpeg', ['-hide_banner', '-v', 'debug', '-i', file, '-c', 'copy', '-bsf:v', 'trace_headers', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 29 }).stderr;
    const out = []; let cur = null;
    for (const line of txt.split('\n')) {
      if (/trace_headers[^\]]*\] Slice Segment Header/.test(line)) { cur = []; out.push(cur); continue; }
      if (/trace_headers[^\]]*\] (?!\d)/.test(line)) { cur = null; continue; }
      const m = cur && line.match(/trace_headers[^\]]*\]\s+\d+\s+(\w+)(?:\[[^\]]*\])*\s+[01]*\s*=\s*(-?\d+)/);
      if (m && !/^(first_slice_segment_in_pic_flag|slice_segment_address|alignment_bit|slice_pic_parameter_set_id|num_entry_point_offsets)/.test(m[1])) cur.push(`${m[1]}=${m[2]}`);
    }
    return out;
  };
  const merged = slicesOf(out);
  let weighted = 0;
  for (let n = 1; n <= 4; n++) {
    const ref = slicesOf(camFile(n));
    const mine = merged.filter((_, i) => i % 4 === n - 1);
    const same = ref.filter((sl, i) => mine[i] && sl.join('|') === mine[i].join('|')).length;
    if (n === 1) weighted = ref.filter((sl) => sl.some((e) => /^luma_weight_l0_flag=1/.test(e))).length;
    check(ref.length === 120 && same === ref.length, `weightp ${label} cam${n}: ${same}/${ref.length} slice headers idênticos (incl. pred_weight_table)`);
  }
  check(weighted > 0, `weightp ${label}: a fonte usa pesos de verdade (${weighted} slices com luma_weight_l0_flag=1)`);
}

// Modo comparação: 1 câmera, sem merge.
{
  const { plugin } = createMultiviewScheme(fakeShaka, { fetchBytes, xmlApi: null });
  const call = async (uri) => new Uint8Array((await plugin(uri, { uris: [uri] }, 0).promise).data);
  const hls = urls('ts').map((u) => `&hls=${encodeURIComponent(u)}`).join('');
  const mpd = new TextDecoder().decode(await call(`mv://manifest/hlscam?cam=3${hls}`));
  const ts0 = Number(mpd.match(/<S t="(\d+)"/)[1]);
  const seg = await call(`mv://camseg/3/${ts0}.m4s`);
  check(/width="1024"/.test(mpd) && seg.length > 1000, 'modo comparação (1 câmera TS) entrega manifesto e segmento próprios');
}

// Remux de TS com B-frames (DTS != PTS): o fMP4 gerado tem que decodificar
// exatamente os mesmos quadros que o TS original.
{
  const { tsInit, tsToFragment } = await import('../web/ts-remux.js');
  const dir = join(work, 'bframes'); mkdirSync(dir, { recursive: true });
  sh('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=${W}x${H}:r=30`, '-t', '6', '-pix_fmt', 'yuv420p', '-c:v', 'libx265',
    '-x265-params', 'keyint=60:min-keyint=60:scenecut=0:bframes=3:slices=1:no-wpp=1:repeat-headers=1:log-level=error', '-f', 'hls', '-hls_time', '2',
    '-hls_playlist_type', 'vod', '-hls_segment_type', 'mpegts', '-hls_segment_filename', join(dir, 's%d.ts'), join(dir, 'i.m3u8')]);
  const segs = readdirSync(dir).filter((f) => f.endsWith('.ts')).sort().map((f) => new Uint8Array(readFileSync(join(dir, f))));
  const parts = [tsInit(segs[0]), ...segs.map((x, i) => tsToFragment(x, i + 1))];
  writeFileSync(join(dir, 'remux.mp4'), Buffer.concat(parts));
  writeFileSync(join(dir, 'all.ts'), Buffer.concat(segs));
  const a = frameMd5(join(dir, 'all.ts')), b = frameMd5(join(dir, 'remux.mp4'));
  check(a.length === 180 && a.length === b.length && a.every((h, i) => h === b[i]), `remux de TS com B-frames: ${b.filter((h, i) => h === a[i]).length}/${a.length} quadros idênticos ao TS original`);
}

// Parser e alinhamento.
{
  const pl = parseMedia(readFileSync(join(work, 'fmp4/cam1/index.m3u8'), 'utf8'), `${base}/x/index.m3u8`);
  check(pl.container === 'fmp4' && pl.map.endsWith('init.mp4') && pl.segments.length === 3 && pl.segments[1].pdt > 0, 'parseMedia: fMP4, MAP, 3 segmentos, PDT propagado');
  const shifted = { ...pl, segments: pl.segments.map((s) => ({ ...s, seq: s.seq + 100 })) };
  check(alignSlots([pl, shifted]).slots.length === 3, 'alinhamento por PDT ignora numeração de sequência diferente');
  const noPdt = (p, d) => ({ ...p, segments: p.segments.map((s) => ({ ...s, pdt: null, seq: s.seq + d })) });
  check(alignSlots([noPdt(pl, 0), noPdt(pl, 1)]).slots.length === 2, 'sem PDT, alinha por número de sequência (interseção)');
  check(parseMaster('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="avc1.42"\na.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2,CODECS="hvc1.1.6.L93.B0"\nb.m3u8\n', 'http://h/')[0].uri === 'http://h/b.m3u8', 'parseMaster ordena por banda');
  let enc = false;
  try { parseMedia('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k"\n#EXTINF:2,\na.ts\n', 'http://h/'); } catch { enc = true; }
  check(enc, 'segmentos criptografados são recusados com mensagem clara');
}

server.close();
console.log(failures ? `\n${failures} verificação(ões) falharam` : '\nHLS: tudo certo');
process.exit(failures ? 1 : 0);
