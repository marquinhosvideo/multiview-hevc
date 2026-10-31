// ts-remux.js
// MPEG-TS (HLS clássico) -> fMP4 (CMAF), só para vídeo HEVC. Não decodifica nem
// altera o bitstream: separa os NALs, descarta AUD/SEI/parâmetros dos quadros e
// reembala os slices como amostras de 4 bytes de comprimento. O init segment é
// montado a partir de VPS/SPS/PPS do próprio stream. Assim, o merge enxerga o
// mesmo formato que recebe de um HLS fMP4.
//
// Limites: um programa, um stream de vídeo HEVC (stream_type 0x24); PTS/DTS de
// 33 bits sem tratamento de wrap-around (~26 h); sem criptografia.

import { parseSps } from './hevc-merge.js';

const TS_SIZE = 188;
const td = new TextDecoder();

export function looksLikeTs(b) {
  return b.length >= TS_SIZE * 3 && b[0] === 0x47 && b[TS_SIZE] === 0x47 && b[TS_SIZE * 2] === 0x47;
}

function readTimestamp(b, o) {
  return (b[o] & 0x0e) * 2 ** 29 + (b[o + 1] << 22) + ((b[o + 2] & 0xfe) << 14) + (b[o + 3] << 7) + (b[o + 4] >> 1);
}

// Annex B -> lista de NALs (sem start code).
function splitAnnexB(es) {
  const starts = [];
  for (let i = 0; i + 3 <= es.length; i++) {
    if (es[i] === 0 && es[i + 1] === 0 && es[i + 2] === 1) { starts.push(i + 3); i += 2; }
  }
  return starts.map((s, k) => {
    let e = k + 1 < starts.length ? starts[k + 1] - 3 : es.length;
    while (e > s && es[e - 1] === 0) e--; // zero à direita / 1º zero do start code de 4 bytes
    return es.subarray(s, e);
  }).filter((n) => n.length > 2);
}

const nalType = (n) => (n[0] >> 1) & 0x3f;

// -> { samples:[{pts,dts,nals}], params:{vps,sps,pps}, pid }
export function demuxHevcTs(b) {
  if (!looksLikeTs(b)) throw new Error('não parece MPEG-TS (sem sincronismo 0x47)');
  let pmtPid = null, videoPid = null, videoType = null;
  const chunks = [];
  const pes = [];
  const flush = () => {
    if (!chunks.length) return;
    const n = chunks.reduce((a, c) => a + c.length, 0);
    const buf = new Uint8Array(n); let o = 0;
    for (const c of chunks) { buf.set(c, o); o += c.length; }
    chunks.length = 0;
    pes.push(buf);
  };
  for (let p = 0; p + TS_SIZE <= b.length; p += TS_SIZE) {
    if (b[p] !== 0x47) throw new Error(`perdeu o sincronismo do TS em ${p}`);
    const pid = ((b[p + 1] & 0x1f) << 8) | b[p + 2];
    const pusi = (b[p + 1] & 0x40) !== 0;
    const afc = (b[p + 3] >> 4) & 3;
    let o = p + 4;
    if (afc & 2) o += 1 + b[p + 4];
    if (!(afc & 1) || o >= p + TS_SIZE) continue;
    const payload = b.subarray(o, p + TS_SIZE);
    if (pid === 0 && pmtPid === null && pusi) {
      const t = payload.subarray(1 + payload[0]);
      const end = 3 + (((t[1] & 0x0f) << 8) | t[2]) - 4;
      for (let i = 8; i + 4 <= end; i += 4) {
        const prog = (t[i] << 8) | t[i + 1];
        if (prog !== 0) { pmtPid = ((t[i + 2] & 0x1f) << 8) | t[i + 3]; break; }
      }
    } else if (pmtPid !== null && pid === pmtPid && videoPid === null && pusi) {
      const t = payload.subarray(1 + payload[0]);
      const end = 3 + (((t[1] & 0x0f) << 8) | t[2]) - 4;
      let i = 12 + (((t[10] & 0x0f) << 8) | t[11]);
      while (i + 5 <= end) {
        const type = t[i], spid = ((t[i + 1] & 0x1f) << 8) | t[i + 2];
        if (type === 0x24 || type === 0x1b) { videoPid = spid; videoType = type; break; }
        i += 5 + (((t[i + 3] & 0x0f) << 8) | t[i + 4]);
      }
      if (videoType === 0x1b) throw new Error('o TS tem vídeo H.264, não HEVC: tiles exigem HEVC');
    } else if (videoPid !== null && pid === videoPid) {
      if (pusi) flush();
      chunks.push(payload);
    }
  }
  flush();
  if (videoPid === null) throw new Error('TS sem stream de vídeo HEVC (stream_type 0x24)');

  const samples = [];
  const params = {};
  for (const buf of pes) {
    if (buf[0] !== 0 || buf[1] !== 0 || buf[2] !== 1) continue;
    const flags = buf[7] >> 6;
    const hdr = 9 + buf[8];
    if (!(flags & 2)) throw new Error('PES de vídeo sem PTS');
    const pts = readTimestamp(buf, 9);
    const dts = flags === 3 ? readTimestamp(buf, 14) : pts;
    // Um PES = um quadro; se vier mais de um (AUD no meio), separa.
    let cur = null;
    for (const nal of splitAnnexB(buf.subarray(hdr))) {
      const t = nalType(nal);
      if (t === 32) params.vps = params.vps || nal;
      else if (t === 33) params.sps = params.sps || nal;
      else if (t === 34) params.pps = params.pps || nal;
      if (t === 35 && cur && cur.nals.length) { samples.push(cur); cur = null; }
      if (!cur) cur = { pts, dts, nals: [] };
      cur.nals.push(nal);
    }
    if (cur && cur.nals.length) samples.push(cur);
  }
  return { samples, params, pid: videoPid };
}

// ---------------------------------------------------------------------------
// Caixas ISO BMFF
// ---------------------------------------------------------------------------
const u32 = (v) => Uint8Array.of(v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
const u16 = (v) => Uint8Array.of(v >> 8, v & 255);
const zeros = (n) => new Uint8Array(n);
const cat = (...parts) => {
  const flat = parts.flat();
  const out = new Uint8Array(flat.reduce((a, p) => a + p.length, 0)); let o = 0;
  for (const p of flat) { out.set(p, o); o += p.length; }
  return out;
};
const box = (type, ...payload) => {
  const body = cat(...payload);
  return cat(u32(8 + body.length), new TextEncoder().encode(type), body);
};
const full = (type, version, flags, ...payload) => box(type, Uint8Array.of(version, flags >> 16, (flags >> 8) & 255, flags & 255), ...payload);
const MATRIX = cat(u32(0x10000), zeros(12), u32(0x10000), zeros(12), u32(0x40000000));

function hvcC(vps, sps, pps) {
  const s = parseSps(sps);
  const h = new Uint8Array(23);
  h[0] = 1;
  h.set(s.rbsp.subarray(3, 15), 1); // profile_tier_level geral: 12 bytes
  h[13] = 0xf0; h[14] = 0x00;       // min_spatial_segmentation_idc
  h[15] = 0xfc;                     // parallelismType
  h[16] = 0xfc | s.chromaFormatIdc;
  h[17] = 0xf8 | (s.bitDepthLuma - 8);
  h[18] = 0xf8 | (s.bitDepthChroma - 8);
  // 19..20 avgFrameRate = 0
  h[21] = (1 << 3) | (1 << 2) | 3;  // 1 camada temporal, nested, lengthSizeMinusOne = 3
  h[22] = 3;                        // 3 arrays: VPS, SPS, PPS
  const arrays = [[32, vps], [33, sps], [34, pps]].map(([t, n]) => cat(Uint8Array.of(0x80 | t), u16(1), u16(n.length), n));
  return box('hvcC', h, ...arrays);
}

// Init segment (ftyp + moov) de uma câmera, a partir dos parâmetros do TS.
export function buildInit({ vps, sps, pps }, timescale = 90000) {
  if (!vps || !sps || !pps) throw new Error('TS sem VPS/SPS/PPS no 1º segmento: o primeiro quadro não é IDR?');
  const s = parseSps(sps);
  const entry = box('hvc1', zeros(6), u16(1), zeros(16), u16(s.width), u16(s.height), u32(0x480000), u32(0x480000), zeros(4), u16(1),
    zeros(32), u16(0x18), Uint8Array.of(0xff, 0xff), hvcC(vps, sps, pps));
  const stbl = box('stbl',
    full('stsd', 0, 0, u32(1), entry), full('stts', 0, 0, u32(0)), full('stsc', 0, 0, u32(0)),
    full('stsz', 0, 0, u32(0), u32(0)), full('stco', 0, 0, u32(0)));
  const minf = box('minf', full('vmhd', 0, 1, zeros(8)), box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1))), stbl);
  const mdia = box('mdia', full('mdhd', 0, 0, u32(0), u32(0), u32(timescale), u32(0), u16(0x55c4), u16(0)),
    full('hdlr', 0, 0, u32(0), new TextEncoder().encode('vide'), zeros(12), Uint8Array.of(0)), minf);
  const trak = box('trak', full('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(0), zeros(8), u16(0), u16(0), u16(0), u16(0),
    MATRIX, u32(s.width * 65536), u32(s.height * 65536)), mdia);
  const moov = box('moov', full('mvhd', 0, 0, u32(0), u32(0), u32(timescale), u32(0), u32(0x10000), u16(0x100), u16(0), zeros(8),
    MATRIX, zeros(24), u32(2)), trak, box('mvex', full('trex', 0, 0, u32(1), u32(1), u32(0), u32(0), u32(0))));
  return cat(box('ftyp', new TextEncoder().encode('isom'), u32(512), new TextEncoder().encode('isomiso6cmfc')), moov);
}

const SYNC = 0x02000000, NON_SYNC = 0x01010000;
const isIrap = (t) => t >= 16 && t <= 23;

// Um segmento TS -> fragmento fMP4 (moof + mdat), com tfdt = DTS do 1º quadro.
export function tsToFragment(tsBytes, seqNo = 1) {
  const { samples } = demuxHevcTs(tsBytes);
  if (!samples.length) throw new Error('segmento TS sem quadros de vídeo');
  const rows = samples.map((s) => {
    const vcl = s.nals.filter((n) => nalType(n) < 32);
    return { dts: s.dts, cto: s.pts - s.dts, vcl, sync: vcl.length > 0 && isIrap(nalType(vcl[0])),
      data: cat(...vcl.map((n) => cat(u32(n.length), n))) };
  });
  rows.forEach((r, i) => { r.dur = i + 1 < rows.length ? rows[i + 1].dts - r.dts : (i ? rows[i - 1].dur : 3000); });
  const n = rows.length;
  const trun = new Uint8Array(12 + 16 * n);
  trun.set([1, 0, 0x0f, 0x01]); // v1; data_offset|duration|size|flags|cto
  trun.set(u32(n), 4);
  const base = rows[0].dts;
  const mdatPayload = cat(...rows.map((r) => r.data));
  const build = (offset) => {
    trun.set(u32(offset), 8);
    rows.forEach((r, i) => {
      const o = 12 + 16 * i;
      trun.set(u32(r.dur), o); trun.set(u32(r.data.length), o + 4);
      trun.set(u32(r.sync ? SYNC : NON_SYNC), o + 8); trun.set(u32(r.cto >>> 0), o + 12);
    });
    return box('moof', full('mfhd', 0, 0, u32(seqNo)),
      box('traf', full('tfhd', 0, 0x20000, u32(1)),
        full('tfdt', 1, 0, u32(Math.floor(base / 2 ** 32)), u32(base % 2 ** 32)),
        box('trun', trun)));
  };
  const size = build(0).length;
  return cat(build(size + 8), box('mdat', mdatPayload));
}

// Atalho: 1º segmento TS de uma câmera -> init segment.
export function tsInit(tsBytes) {
  const { params } = demuxHevcTs(tsBytes);
  return buildInit(params);
}
