// mv-shaka.js
// Liga o merge HEVC ao Shaka Player sem modificar o Shaka.
//
// O Shaka recebe um manifesto "virtual" com UMA representação de vídeo (o canvas
// com tiles). As URLs desse manifesto usam o esquema mv://, atendido por um
// plugin registrado no NetworkingEngine do Shaka:
//
//   mv://manifest/merge?mpd=...&cams=1,2,3,4  -> MPD reescrito (1 AdaptationSet, canvas)
//   mv://manifest/cam?mpd=...&cam=2           -> MPD só com a câmera 2 (comparação)
//   mv://seg/init.mp4                         -> init do canvas
//   mv://seg/123.m4s                          -> busca o segmento 123 das N câmeras
//                                                e devolve 1 segmento mergeado
//
// Fonte HLS (uma playlist .m3u8 por câmera, repita &hls=... na ordem das câmeras):
//   mv://manifest/hls?cams=1,2,3,4&hls=URL1&hls=URL2&hls=URL3&hls=URL4
//   mv://manifest/hlscam?cam=2&hls=URL1&hls=URL2&hls=URL3&hls=URL4
//   mv://seg/<tempo>.m4s e mv://camseg/<cam>/<tempo>.m4s funcionam como acima
//
// Para o Shaka (e para o MSE) existe um único stream de vídeo, logo um único
// SourceBuffer e um único decoder.

import { createMerger, gridFor } from './hevc-merge.js';
import { createHlsSource } from './hls-source.js';

const MPD_NS = 'urn:mpeg:dash:schema:mpd:2011';

// Lê as câmeras (AdaptationSets de vídeo) de um MPD do servidor.
export function readCameras(doc, mpdUrl) {
  const sets = [...doc.getElementsByTagNameNS(MPD_NS, 'AdaptationSet')];
  return sets.map((as, i) => {
    const rep = as.getElementsByTagNameNS(MPD_NS, 'Representation')[0];
    const tpl = rep.getElementsByTagNameNS(MPD_NS, 'SegmentTemplate')[0] ||
      as.getElementsByTagNameNS(MPD_NS, 'SegmentTemplate')[0];
    const attr = (el, n) => (el && el.getAttribute(n)) || null;
    const repId = attr(rep, 'id');
    const abs = (t) => new URL(t.replace(/\$RepresentationID\$/g, repId), mpdUrl).href;
    return {
      index: i + 1,
      as, rep, tpl,
      init: abs(attr(tpl, 'initialization')),
      media: abs(attr(tpl, 'media')),
      codecs: attr(rep, 'codecs') || attr(as, 'codecs'),
      width: Number(attr(rep, 'width') || attr(as, 'maxWidth')),
      height: Number(attr(rep, 'height') || attr(as, 'maxHeight')),
      bandwidth: Number(attr(rep, 'bandwidth') || 0),
    };
  });
}

function stripForShaka(doc, presentationDelay) {
  const mpd = doc.documentElement;
  mpd.setAttribute('suggestedPresentationDelay', `PT${presentationDelay}S`);
  for (const b of [...doc.getElementsByTagNameNS(MPD_NS, 'BaseURL')]) b.parentNode.removeChild(b);
  // SRD e dicas do GPAC não interessam ao Shaka.
  for (const tag of ['SupplementalProperty', 'EssentialProperty']) {
    for (const p of [...doc.getElementsByTagNameNS(MPD_NS, tag)]) p.parentNode.removeChild(p);
  }
}

// Manifesto do canvas: mantém a 1ª câmera escolhida como "esqueleto" (timeline,
// timescale, startNumber) e aponta tudo para mv://seg/.
export function buildMergedMpd(xml, mpdUrl, cams, xmlApi, presentationDelay = 6) {
  const doc = new xmlApi.DOMParser().parseFromString(xml, 'application/xml');
  const all = readCameras(doc, mpdUrl);
  const chosen = cams.map((n) => {
    const c = all[n - 1];
    if (!c) throw new Error(`Câmera ${n} não existe no MPD (há ${all.length})`);
    return c;
  });
  const grid = gridFor(chosen.length);
  const keep = chosen[0];
  for (const c of all) if (c !== keep) c.as.parentNode.removeChild(c.as);
  stripForShaka(doc, presentationDelay);

  const w = keep.width * grid.cols, h = keep.height * grid.rows;
  keep.as.setAttribute('maxWidth', String(w));
  keep.as.setAttribute('maxHeight', String(h));
  keep.as.removeAttribute('par');
  keep.rep.setAttribute('id', 'canvas');
  keep.rep.setAttribute('width', String(w));
  keep.rep.setAttribute('height', String(h));
  keep.rep.setAttribute('bandwidth', String(chosen.reduce((a, c) => a + c.bandwidth, 0)));
  keep.tpl.setAttribute('initialization', 'mv://seg/init.mp4');
  keep.tpl.setAttribute('media', 'mv://seg/$Number$.m4s');
  return {
    text: new xmlApi.XMLSerializer().serializeToString(doc),
    cameras: chosen.map(({ index, init, media, codecs, width, height }) => ({ index, init, media, codecs, width, height })),
    grid, width: w, height: h,
  };
}

// Manifesto de uma câmera só, com URLs http absolutas (sem merge).
export function buildSingleCamMpd(xml, mpdUrl, cam, xmlApi, presentationDelay = 6) {
  const doc = new xmlApi.DOMParser().parseFromString(xml, 'application/xml');
  const all = readCameras(doc, mpdUrl);
  const keep = all[cam - 1];
  if (!keep) throw new Error(`Câmera ${cam} não existe no MPD`);
  for (const c of all) if (c !== keep) c.as.parentNode.removeChild(c.as);
  stripForShaka(doc, presentationDelay);
  keep.tpl.setAttribute('initialization', keep.init);
  keep.tpl.setAttribute('media', keep.media);
  return { text: new xmlApi.XMLSerializer().serializeToString(doc) };
}

// Cria o plugin do esquema mv:// para o NetworkingEngine do Shaka.
//   shakaNs: o namespace global `shaka` (ou um fake, nos testes)
//   opts.fetchBytes(url) -> Promise<Uint8Array>   (lança {status} em erro HTTP)
//   opts.xmlApi: { DOMParser, XMLSerializer }
//   opts.onEvent(evt): telemetria para a página (merge, erros)
export function createMultiviewScheme(shakaNs, opts) {
  const { fetchBytes, xmlApi, onEvent = () => {}, presentationDelay = 6 } = opts;
  const state = { cameras: null, merger: null, mergerKey: '', hls: null, hlsCams: {}, stats: { segments: 0, mergeMs: 0, bytesIn: 0, bytesOut: 0 } };
  const te = new TextEncoder(), td = new TextDecoder();

  const httpError = (uri, status, requestType) => new shakaNs.util.Error(
    shakaNs.util.Error.Severity.RECOVERABLE, shakaNs.util.Error.Category.NETWORK,
    shakaNs.util.Error.Code.BAD_HTTP_STATUS, uri, status, '', {}, requestType);

  async function getMerger() {
    const key = state.cameras.map((c) => c.init).join('|');
    if (!state.merger || state.mergerKey !== key) {
      const inits = await Promise.all(state.cameras.map((c) => fetchBytes(c.init)));
      state.merger = createMerger(inits);
      state.mergerKey = key;
      onEvent({ type: 'merger', width: state.merger.width, height: state.merger.height, tiles: state.merger.tiles });
    }
    return state.merger;
  }

  async function handle(uri, requestType) {
    const u = new URL(uri);
    // new URL('mv://manifest/merge') => host 'manifest', pathname '/merge'
    if (u.host === 'manifest' && (u.pathname === '/hls' || u.pathname === '/hlscam')) {
      const urls = u.searchParams.getAll('hls');
      if (u.pathname === '/hls') {
        const cams = (u.searchParams.get('cams') || '1,2,3,4').split(',').map(Number);
        const chosen = cams.map((n) => {
          if (!urls[n - 1]) throw new Error(`Câmera ${n} sem URL HLS (recebi ${urls.length} URLs)`);
          return urls[n - 1];
        });
        state.hls = state.hls || createHlsSource({ fetchBytes, presentationDelay, onEvent });
        const m = await state.hls.refresh(chosen);
        state.cameras = m.cameras.map((c, i) => ({ ...c, index: cams[i] }));
        state.merger = null; state.source = 'hls';
        onEvent({ type: 'manifest', cameras: state.cameras, width: m.width, height: m.height, grid: m.grid, source: 'hls', info: m.info });
        return te.encode(m.text);
      }
      const cam = Number(u.searchParams.get('cam'));
      if (!urls[cam - 1]) throw new Error(`Câmera ${cam} sem URL HLS`);
      const src = state.hlsCams[cam] = state.hlsCams[cam] || createHlsSource({ fetchBytes, presentationDelay, onEvent });
      return te.encode((await src.refresh([urls[cam - 1]], { single: true })).text);
    }
    if (u.host === 'camseg') {
      const [, cam, file] = u.pathname.match(/^\/(\d+)\/(.+)$/) || [];
      const src = state.hlsCams[Number(cam)];
      if (!src) throw new Error('mv://camseg pedido antes do manifesto');
      if (file === 'init.mp4') return src.camInit();
      return src.camSegment(Number(file.replace('.m4s', '')));
    }
    if (u.host === 'manifest') {
      const mpdUrl = u.searchParams.get('mpd');
      const xml = td.decode(await fetchBytes(mpdUrl));
      if (u.pathname === '/merge') {
        const cams = (u.searchParams.get('cams') || '1,2,3,4').split(',').map(Number);
        const m = buildMergedMpd(xml, mpdUrl, cams, xmlApi, presentationDelay);
        state.cameras = m.cameras; state.source = 'dash';
        onEvent({ type: 'manifest', cameras: m.cameras, width: m.width, height: m.height, grid: m.grid });
        return te.encode(m.text);
      }
      if (u.pathname === '/cam') {
        return te.encode(buildSingleCamMpd(xml, mpdUrl, Number(u.searchParams.get('cam')), xmlApi, presentationDelay).text);
      }
    }
    if (u.host === 'seg') {
      if (!state.cameras) throw new Error('mv://seg pedido antes do manifesto');
      if (state.source === 'hls') {
        if (u.pathname === '/init.mp4') return state.hls.mergedInit();
        const t = u.pathname.match(/^\/(\d+)\.m4s$/);
        if (!t) throw httpError(uri, 404, requestType);
        const t0 = performance.now();
        const { slot, segs, out } = await state.hls.mergedSegment(Number(t[1]));
        const ms = performance.now() - t0;
        const bytesIn = segs.reduce((a, x) => a + x.length, 0);
        Object.assign(state.stats, { segments: state.stats.segments + 1, mergeMs: state.stats.mergeMs + ms,
          bytesIn: state.stats.bytesIn + bytesIn, bytesOut: state.stats.bytesOut + out.length });
        onEvent({ type: 'segment', number: slot.id, ms, bytesIn, bytesOut: out.length, cams: segs.length });
        return out;
      }
      const merger = await getMerger();
      if (u.pathname === '/init.mp4') return merger.init;
      const n = u.pathname.match(/^\/(\d+)\.m4s$/);
      if (n) {
        const segs = await Promise.all(state.cameras.map((c) => fetchBytes(c.media.replace(/\$Number\$/g, n[1]))));
        const t0 = performance.now();
        const out = merger.mergeSegment(segs);
        const ms = performance.now() - t0;
        const bytesIn = segs.reduce((a, s) => a + s.length, 0);
        Object.assign(state.stats, {
          segments: state.stats.segments + 1, mergeMs: state.stats.mergeMs + ms,
          bytesIn: state.stats.bytesIn + bytesIn, bytesOut: state.stats.bytesOut + out.length,
        });
        onEvent({ type: 'segment', number: Number(n[1]), ms, bytesIn, bytesOut: out.length, cams: segs.length });
        return out;
      }
    }
    throw httpError(uri, 404, requestType);
  }

  function plugin(uri, request, requestType) {
    const started = performance.now();
    const p = handle(uri, requestType).then((bytes) => ({
      uri, originalUri: uri, originalRequest: request, status: 200, headers: {},
      data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      timeMs: performance.now() - started,
    }), (err) => {
      if (err instanceof shakaNs.util.Error) throw err;
      if (err && err.status) throw httpError(err.url || uri, err.status, requestType);
      onEvent({ type: 'error', message: String(err && err.message || err), uri });
      throw new shakaNs.util.Error(shakaNs.util.Error.Severity.CRITICAL, shakaNs.util.Error.Category.NETWORK,
        shakaNs.util.Error.Code.HTTP_ERROR, uri, err, requestType);
    });
    return shakaNs.util.AbortableOperation.notAbortable(p);
  }

  return { plugin, state };
}

// fetch -> Uint8Array, com o status no erro (para o Shaka tentar de novo em 404).
export async function fetchBytes(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) { const e = new Error(`HTTP ${r.status} em ${url}`); e.status = r.status; e.url = url; throw e; }
  return new Uint8Array(await r.arrayBuffer());
}
