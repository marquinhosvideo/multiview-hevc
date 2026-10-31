// hls-source.js
// Fonte HLS para o plugin mv:// do Shaka: lê N playlists HLS (uma por câmera),
// alinha os segmentos, monta um MPD virtual com UMA representação (o canvas com
// tiles) e entrega segmentos já mergeados. Funciona com segmentos fMP4/CMAF e
// com MPEG-TS (remuxado para fMP4 em JavaScript).
//
// O Shaka não precisa de nada: ele recebe um MPD comum, com SegmentTimeline e
// URLs mv://seg/$Time$.m4s.

import { createMerger, gridFor, initTimescale, firstDecodeTime, initCodecString, parseCameraInit } from './hevc-merge.js';
import { isMasterPlaylist, parseMaster, pickVariant, parseMedia, alignSlots, independentOffsets } from './hls.js';
import { looksLikeTs, tsInit, tsToFragment } from './ts-remux.js';
import { isMpd, parseMpd } from './dash.js';

const td = new TextDecoder();
const httpErr = (status, url) => Object.assign(new Error(`HTTP ${status} em ${url}`), { status, url });

// Cache pequeno de segmentos já baixados (o manifesto e o merge pedem os mesmos).
function makeCache(fetchBytes, max = 24) {
  const m = new Map();
  return (url) => {
    if (m.has(url)) return m.get(url);
    const p = fetchBytes(url).catch((e) => { m.delete(url); throw e; });
    m.set(url, p);
    while (m.size > max) m.delete(m.keys().next().value);
    return p;
  };
}

// Uma câmera HLS: resolve master -> media, init e conversão TS -> fMP4.
function makeCamera(index, url, io) {
  const cam = { index, url, mediaUrl: null, playlist: null, init: null, timescale: 90000, container: null, seq: 0, dashSeq: new Map() };

  // Aceita playlist HLS (media ou master) e manifesto DASH (.mpd), sem depender da extensão.
  cam.load = async () => {
    let text = td.decode(await io.fetchBytes(cam.mediaUrl || cam.url));
    if (isMpd(text)) {
      cam.mediaUrl = cam.url;
      cam.playlist = parseMpd(text, cam.url, { seqState: cam.dashSeq, rendition: io.rendition() });
      return cam.playlist;
    }
    if (isMasterPlaylist(text)) {
      cam.mediaUrl = pickVariant(parseMaster(text, cam.url), io.rendition()).uri;
      text = td.decode(await io.fetchBytes(cam.mediaUrl));
    } else cam.mediaUrl = cam.mediaUrl || cam.url;
    cam.playlist = parseMedia(text, cam.mediaUrl);
    return cam.playlist;
  };

  // Segmento da câmera como fMP4 (converte o TS, se for o caso).
  cam.segment = async (uri) => {
    const raw = await io.cached(uri);
    if (looksLikeTs(raw)) return tsToFragment(raw, ++cam.seq);
    if (cam.container === 'ts') throw new Error(`CAM ${index}: a playlist diz TS, mas o segmento não é MPEG-TS`);
    return raw;
  };

  cam.ensureInit = async (firstSegmentUri) => {
    if (cam.init) return cam.init;
    const pl = cam.playlist;
    if (pl.map) {
      cam.container = 'fmp4';
      cam.init = await io.cached(pl.map);
    } else {
      const raw = await io.cached(firstSegmentUri);
      if (!looksLikeTs(raw)) throw new Error(`CAM ${index}: segmento sem EXT-X-MAP e que não é MPEG-TS; formato não reconhecido`);
      cam.container = 'ts';
      cam.init = tsInit(raw);
    }
    cam.timescale = initTimescale(cam.init);
    return cam.init;
  };
  return cam;
}

// opts: { fetchBytes, presentationDelay, onEvent }
export function createHlsSource(opts) {
  const { fetchBytes, presentationDelay = 6, onEvent = () => {} } = opts;
  const io = { fetchBytes, cached: makeCache(fetchBytes), rendition: () => st.rendition };
  const st = { rendition: 'highest', sync: null, offsets: null, cams: [], merger: null, mergerKey: '', timeline: new Map(), asat: null, anchored: false, slotsByTime: new Map(), info: null };

  // Relê as playlists e devolve o MPD virtual do canvas (ou de uma câmera só).
  async function refresh(urls, { single = false, sync = 'auto', rendition = 'highest' } = {}) {
    if (st.rendition !== String(rendition)) { st.rendition = String(rendition); st.cams = []; }
    if (st.cams.length !== urls.length || st.cams.some((c, i) => c.url !== urls[i])) {
      Object.assign(st, { sync: null, offsets: null, cams: urls.map((u, i) => makeCamera(i + 1, u, io)), merger: null, mergerKey: '', timeline: new Map(), asat: null, anchored: false, slotsByTime: new Map() });
    }
    const lists = await Promise.all(st.cams.map((c) => c.load()));
    for (const [i, l] of lists.entries()) {
      if (l.hasDiscontinuity && !l.endList) onEvent({ type: 'warning', message: `CAM ${i + 1}: playlist com EXT-X-DISCONTINUITY; o alinhamento pode falhar na descontinuidade` });
    }
    let aligned;
    if (single) {
      aligned = { mode: 'seq', slots: lists[0].segments.map((s) => ({ id: s.seq, uris: [s.uri], dur: s.dur, pdt: s.pdt })), skew: 0 };
    } else {
      // Streams com relógio comum: PDT ou sequência. Sem tempo em comum (fontes independentes),
      // cai para o pareamento por posição, com offsets fixados na primeira leitura.
      if (st.offsets) aligned = alignSlots(lists, { offsets: st.offsets });
      else if (sync === 'independent') aligned = null;
      else aligned = alignSlots(lists);
      if (!aligned || !aligned.slots.length) {
        if (!st.offsets) {
          st.offsets = independentOffsets(lists);
          if (sync === 'independent') onEvent({ type: 'info', message: 'canais independentes: cada tile mostra o segmento mais recente do seu canal, sem relógio em comum' });
          else onEvent({ type: 'warning', message: 'os streams não têm tempo em comum (PDT/sequência): tratei como canais independentes e pareei os segmentos mais recentes; cada tile mostra um instante diferente' });
        }
        aligned = alignSlots(lists, { offsets: st.offsets });
      }
      if (aligned.mode === 'independent') {
        const durs = lists.map((l) => l.segments[l.segments.length - 1].dur);
        if (Math.max(...durs) - Math.min(...durs) > 0.05 * Math.max(...durs)) {
          throw new Error(`duração dos segmentos diferente entre as câmeras (${durs.map((d) => d.toFixed(2) + 's').join(' / ')}): os GOPs precisam ter o mesmo tamanho para costurar`);
        }
      }
    }
    if (!aligned.slots.length) throw new Error('nenhum segmento em comum entre as câmeras: as playlists não se sobrepõem');
    const firstSlot = aligned.slots[0];
    await Promise.all(st.cams.map((c, i) => c.ensureInit(firstSlot.uris[i])));

    // Merger (canvas) uma vez por conjunto de inits.
    let width, height, grid, codecs;
    let bandwidth;
    if (single) {
      const { sps } = parseCameraInit(st.cams[0].init);
      width = sps.width; height = sps.height; grid = { cols: 1, rows: 1 };
      codecs = initCodecString(st.cams[0].init);
    } else {
      const key = st.cams.map((c) => c.mediaUrl).join('|');
      if (!st.merger || st.mergerKey !== key) {
        st.merger = createMerger(st.cams.map((c) => c.init));
        st.mergerKey = key;
        onEvent({ type: 'merger', width: st.merger.width, height: st.merger.height, tiles: st.merger.tiles });
      }
      width = st.merger.width; height = st.merger.height; grid = { cols: st.merger.cols, rows: st.merger.rows };
      codecs = initCodecString(st.cams[0].init);
    }
    bandwidth = 5_000_000 * st.cams.length; // só informativo: o ABR está desligado
    const ts = st.cams[0].timescale;

    // Linha do tempo: âncora = tfdt do 1º segmento visto; depois soma EXTINF.
    if (!st.anchored) {
      const bytes = await st.cams[0].segment(firstSlot.uris[0]);
      const t0 = firstDecodeTime(bytes);
      st.timeline.set(firstSlot.id, { t: t0, d: Math.round(firstSlot.dur * ts), pdt: firstSlot.pdt });
      st.anchored = true;
      if (firstSlot.pdt !== null) st.asat = firstSlot.pdt - (t0 / ts) * 1000;
    }
    const known = [...st.timeline.keys()];
    if (aligned.slots[0].id < Math.min(...known)) { st.timeline.clear(); st.anchored = false; throw Object.assign(new Error('playlist voltou no tempo; reiniciando'), { status: 503 }); }
    for (const s of aligned.slots) {
      if (st.timeline.has(s.id)) continue;
      const prev = st.timeline.get(Math.max(...st.timeline.keys()));
      st.timeline.set(s.id, { t: prev.t + prev.d, d: Math.round(s.dur * ts), pdt: s.pdt });
    }
    // Janela atual: só o que ainda está na playlist; descarta o resto do histórico.
    const ids = new Set(aligned.slots.map((s) => s.id));
    for (const id of [...st.timeline.keys()]) if (!ids.has(id) && id < aligned.slots[0].id - 4) st.timeline.delete(id);

    st.slotsByTime = new Map(aligned.slots.map((s) => [st.timeline.get(s.id).t, s]));
    const live = !lists[0].endList;
    const win = aligned.slots.map((s) => ({ ...st.timeline.get(s.id) }));
    const winStart = win[0].t;
    const last = win[win.length - 1];
    if (live && st.asat === null) st.asat = Date.now() - ((last.t + last.d) / ts) * 1000;

    const S = win.map((w) => `<S t="${w.t}" d="${w.d}"/>`).join('');
    const target = lists[0].targetDuration || Math.round(firstSlot.dur);
    const media = single ? `mv://camseg/${st.cams[0].index}/$Time$.m4s` : 'mv://seg/$Time$.m4s';
    const initUri = single ? `mv://camseg/${st.cams[0].index}/init.mp4` : 'mv://seg/init.mp4';
    const dur = (x) => `PT${(x / ts).toFixed(3)}S`;
    const head = live
      ? `type="dynamic" availabilityStartTime="${new Date(st.asat).toISOString()}" minimumUpdatePeriod="PT${target}S" timeShiftBufferDepth="${dur(last.t + last.d - winStart)}" suggestedPresentationDelay="PT${presentationDelay}S"`
      : `type="static" mediaPresentationDuration="${dur(last.t + last.d - winStart)}"`;
    const mpd = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-live:2011" ${head} minBufferTime="PT2S">
 <Period id="1" start="PT0S">
  <AdaptationSet id="1" contentType="video" mimeType="video/mp4" segmentAlignment="true" startWithSAP="1" maxWidth="${width}" maxHeight="${height}">
   <Representation id="${single ? 'cam' + st.cams[0].index : 'canvas'}" codecs="${codecs}" width="${width}" height="${height}" bandwidth="${bandwidth}">
    <SegmentTemplate timescale="${ts}"${live ? '' : ` presentationTimeOffset="${winStart}"`} initialization="${initUri}" media="${media}"><SegmentTimeline>${S}</SegmentTimeline></SegmentTemplate>
   </Representation>
  </AdaptationSet>
 </Period>
</MPD>`;
    st.info = { mode: aligned.mode, skew: aligned.skew, containers: st.cams.map((c) => c.container), slots: aligned.slots.length, live };
    return { text: mpd, width, height, grid, codecs, info: st.info,
      cameras: st.cams.map((c) => ({ index: c.index, codecs, width: width / grid.cols, height: height / grid.rows, container: c.container })) };
  }

  const slotFor = (t) => {
    const s = st.slotsByTime.get(t);
    if (!s) throw httpErr(404, `slot ${t}`);
    return s;
  };

  return {
    state: st,
    refresh,
    mergedInit: () => st.merger.init,
    camInit: () => st.cams[0].init,
    async mergedSegment(t) {
      const slot = slotFor(t);
      const segs = await Promise.all(st.cams.map((c, i) => c.segment(slot.uris[i])));
      return { slot, segs, out: st.merger.mergeSegment(segs, { ignoreTime: st.offsets !== null }) };
    },
    async camSegment(t) {
      const slot = slotFor(t);
      return st.cams[0].segment(slot.uris[0]);
    },
  };
}
