// hevc-merge.js
// Merge de bitstreams HEVC no domínio comprimido, em JavaScript puro (navegador
// ou Node). Recebe segmentos fMP4 de N câmeras encodadas com as restrições da
// POC (MV dentro do quadro, sem TMVP, sem WPP, 1 slice por quadro, mesmos
// SPS/PPS) e devolve UM segmento fMP4 cujo vídeo é um único bitstream HEVC com
// tiles. Nada é decodificado: só SPS, PPS e slice headers são reescritos; os
// dados CABAC de cada câmera são copiados.
//
// É a mesma ideia do filtro hevcmerge do GPAC, simplificada para o contrato de
// encoding da POC (grade uniforme, tiles do mesmo tamanho).

// ---------------------------------------------------------------------------
// Bits
// ---------------------------------------------------------------------------

class BitReader {
  constructor(bytes, bitPos = 0) { this.b = bytes; this.pos = bitPos; }
  u(n) {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.b[this.pos >> 3];
      if (byte === undefined) throw new Error('BitReader: fim dos dados');
      v = v * 2 + ((byte >> (7 - (this.pos & 7))) & 1);
      this.pos++;
    }
    return v;
  }
  flag() { return this.u(1) === 1; }
  ue() {
    let zeros = 0;
    while (this.u(1) === 0) { zeros++; if (zeros > 31) throw new Error('ue(v) inválido'); }
    return zeros === 0 ? 0 : (2 ** zeros - 1) + this.u(zeros);
  }
  se() { const k = this.ue(); return k & 1 ? (k + 1) / 2 : -(k / 2); }
  skip(n) { this.pos += n; }
}

class BitWriter {
  constructor() { this.out = []; this.cur = 0; this.n = 0; }
  bit(v) {
    this.cur = (this.cur << 1) | (v & 1);
    if (++this.n === 8) { this.out.push(this.cur); this.cur = 0; this.n = 0; }
  }
  u(n, v) { for (let i = n - 1; i >= 0; i--) this.bit(Math.floor(v / 2 ** i) & 1); }
  ue(v) {
    const x = v + 1, len = Math.floor(Math.log2(x));
    this.u(len, 0); this.u(len + 1, x);
  }
  // Copia os bits [from, to) de um buffer.
  copy(bytes, from, to) {
    for (let p = from; p < to; p++) this.bit((bytes[p >> 3] >> (7 - (p & 7))) & 1);
  }
  // rbsp_trailing_bits / byte_alignment: um bit 1 e zeros até fechar o byte.
  trailing() { this.bit(1); while (this.n !== 0) this.bit(0); }
  bytes() { return Uint8Array.from(this.out); }
}

// Remove bytes de prevenção de emulação (00 00 03 -> 00 00).
function toRbsp(ebsp) {
  const out = new Uint8Array(ebsp.length);
  let o = 0, zeros = 0;
  for (let i = 0; i < ebsp.length; i++) {
    const v = ebsp[i];
    if (zeros >= 2 && v === 3) { zeros = 0; continue; }
    out[o++] = v;
    zeros = v === 0 ? zeros + 1 : 0;
  }
  return out.subarray(0, o);
}

// Reinsere a prevenção de emulação, a partir do byte 2 (depois do cabeçalho da NAL).
function toEbsp(rbsp) {
  const out = new Uint8Array(rbsp.length + (rbsp.length >> 1) + 4);
  let o = 0, zeros = 0;
  for (let i = 0; i < rbsp.length; i++) {
    const v = rbsp[i];
    if (i >= 2 && zeros >= 2 && v <= 3) { out[o++] = 3; zeros = 0; }
    out[o++] = v;
    zeros = v === 0 ? zeros + 1 : 0;
  }
  if (rbsp[rbsp.length - 1] === 0) out[o++] = 3;
  return out.subarray(0, o);
}

// Posição (em bits) do stop bit do rbsp_trailing_bits.
function stopBitPos(rbsp) {
  let i = rbsp.length - 1;
  while (i >= 0 && rbsp[i] === 0) i--;
  if (i < 0) throw new Error('RBSP vazio');
  let bit = 7;
  while (((rbsp[i] >> (7 - bit)) & 1) === 0) bit--;
  return i * 8 + bit;
}

const nalType = (nal) => (nal[0] >> 1) & 0x3f;

// ---------------------------------------------------------------------------
// SPS / PPS
// ---------------------------------------------------------------------------

function skipScalingListData(r) {
  for (let sizeId = 0; sizeId < 4; sizeId++) {
    for (let matrixId = 0; matrixId < 6; matrixId += sizeId === 3 ? 3 : 1) {
      if (!r.flag()) { r.ue(); continue; }
      const coefNum = Math.min(64, 1 << (4 + (sizeId << 1)));
      if (sizeId > 1) r.se();
      for (let i = 0; i < coefNum; i++) r.se();
    }
  }
}

// st_ref_pic_set(idx). Devolve NumDeltaPocs do conjunto lido.
function parseStRps(r, idx, numInSps, prev) {
  let inter = false;
  if (idx !== 0) inter = r.flag();
  if (inter) {
    const deltaIdxMinus1 = idx === numInSps ? r.ue() : 0;
    const ref = prev[idx - (deltaIdxMinus1 + 1)];
    r.u(1); r.ue(); // delta_rps_sign, abs_delta_rps_minus1
    let n = 0;
    for (let j = 0; j <= ref; j++) {
      const used = r.flag();
      const useDelta = used ? true : r.flag();
      if (useDelta) n++;
    }
    return n;
  }
  const neg = r.ue(), pos = r.ue();
  for (let i = 0; i < neg + pos; i++) { r.ue(); r.u(1); }
  return neg + pos;
}

function skipProfileTierLevel(r, maxSubLayersMinus1) {
  r.skip(96); // perfil/tier/nível gerais
  const prof = [], lvl = [];
  for (let i = 0; i < maxSubLayersMinus1; i++) { prof.push(r.flag()); lvl.push(r.flag()); }
  if (maxSubLayersMinus1 > 0) for (let i = maxSubLayersMinus1; i < 8; i++) r.skip(2);
  for (let i = 0; i < maxSubLayersMinus1; i++) { if (prof[i]) r.skip(88); if (lvl[i]) r.skip(8); }
}

export function parseSps(nal) {
  const rbsp = toRbsp(nal);
  const r = new BitReader(rbsp, 16);
  const s = { rbsp };
  r.skip(4);
  const maxSub = r.u(3);
  r.skip(1);
  skipProfileTierLevel(r, maxSub);
  r.ue();
  s.chromaFormatIdc = r.ue();
  s.separateColourPlane = s.chromaFormatIdc === 3 ? r.flag() : false;
  s.posWidth = r.pos;
  s.width = r.ue(); s.height = r.ue();
  s.posAfterSize = r.pos;
  s.conformanceWindow = r.flag();
  s.confWin = { left: 0, right: 0, top: 0, bottom: 0 };
  if (s.conformanceWindow) { s.confWin = { left: r.ue(), right: r.ue(), top: r.ue(), bottom: r.ue() }; }
  s.posAfterConf = r.pos;
  s.bitDepthLuma = r.ue() + 8; s.bitDepthChroma = r.ue() + 8;
  s.log2MaxPocLsb = r.ue() + 4;
  const subOrdering = r.flag();
  for (let i = subOrdering ? 0 : maxSub; i <= maxSub; i++) { r.ue(); r.ue(); r.ue(); }
  const log2MinCb = r.ue() + 3;
  s.ctbLog2 = log2MinCb + r.ue();
  s.ctbSize = 1 << s.ctbLog2;
  r.ue(); r.ue(); r.ue(); r.ue();
  if (r.flag() && r.flag()) skipScalingListData(r);
  r.skip(1); // amp
  s.saoEnabled = r.flag();
  if (r.flag()) { r.skip(8); r.ue(); r.ue(); r.skip(1); } // pcm
  s.numStRps = r.ue();
  s.rpsDeltas = [];
  for (let i = 0; i < s.numStRps; i++) s.rpsDeltas.push(parseStRps(r, i, s.numStRps, s.rpsDeltas));
  s.longTermRefsPresent = r.flag();
  if (s.longTermRefsPresent) {
    s.numLtSps = r.ue();
    for (let i = 0; i < s.numLtSps; i++) { r.skip(s.log2MaxPocLsb); r.skip(1); }
  }
  s.temporalMvpEnabled = r.flag();
  return s;
}

export function parsePps(nal) {
  const rbsp = toRbsp(nal);
  const r = new BitReader(rbsp, 16);
  const p = { rbsp };
  r.ue(); r.ue();
  p.dependentSliceSegments = r.flag();
  p.outputFlagPresent = r.flag();
  p.numExtraSliceHeaderBits = r.u(3);
  r.skip(1); // sign data hiding
  p.cabacInitPresent = r.flag();
  p.numRefIdxL0Default = r.ue() + 1;
  p.numRefIdxL1Default = r.ue() + 1;
  r.se(); r.skip(2);
  if (r.flag()) r.ue(); // cu_qp_delta
  r.se(); r.se();
  p.sliceChromaQpOffsetsPresent = r.flag();
  p.weightedPred = r.flag();
  p.weightedBipred = r.flag();
  r.skip(1);
  p.posTiles = r.pos;
  p.tilesEnabled = r.flag();
  p.entropyCodingSync = r.flag();
  if (p.tilesEnabled) throw new Error('A câmera já usa tiles; o merge espera 1 tile por câmera');
  p.posAfterTiles = r.pos;
  p.loopFilterAcrossSlices = r.flag();
  p.deblockingOverrideEnabled = false;
  p.deblockingDisabled = false;
  if (r.flag()) {
    p.deblockingOverrideEnabled = r.flag();
    p.deblockingDisabled = r.flag();
    if (!p.deblockingDisabled) { r.se(); r.se(); }
  }
  if (r.flag()) skipScalingListData(r);
  p.listsModificationPresent = r.flag();
  r.ue();
  p.sliceHeaderExtPresent = r.flag();
  if (r.flag()) {
    const range = r.flag(); r.skip(7);
    if (range) {
      // pps_range_extension: só aceitamos sem chroma_qp_offset_list
      throw new Error('PPS com range extension não suportado');
    }
  }
  if (p.listsModificationPresent) throw new Error('lists_modification_present não suportado');
  return p;
}

// SPS do canvas: mesma SPS da câmera com nova largura/altura e sem janela de corte.
function buildCanvasSps(sps, width, height) {
  const w = new BitWriter();
  w.copy(sps.rbsp, 0, sps.posWidth);
  w.ue(width); w.ue(height);
  w.bit(0); // conformance_window_flag
  w.copy(sps.rbsp, sps.posAfterConf, stopBitPos(sps.rbsp));
  w.trailing();
  return toEbsp(w.bytes());
}

// PPS do canvas: liga tiles numa grade uniforme, sem filtro entre tiles.
function buildCanvasPps(pps, cols, rows) {
  const w = new BitWriter();
  w.copy(pps.rbsp, 0, pps.posTiles);
  w.bit(1); // tiles_enabled_flag
  w.bit(pps.entropyCodingSync ? 1 : 0); // WPP da câmera é mantido: cada tile continua com suas linhas de CTU
  w.ue(cols - 1); w.ue(rows - 1);
  w.bit(1); // uniform_spacing_flag
  w.bit(0); // loop_filter_across_tiles_enabled_flag
  w.copy(pps.rbsp, pps.posAfterTiles, stopBitPos(pps.rbsp));
  w.trailing();
  return toEbsp(w.bytes());
}

// ---------------------------------------------------------------------------
// Slice header
// ---------------------------------------------------------------------------

// Reescreve um slice (1 por quadro da câmera) como o slice de um tile do canvas.
function rewriteSlice(nal, sps, pps, isFirst, ctbAddr, addrBits, meta = {}) {
  const rbsp = toRbsp(nal);
  const type = nalType(rbsp);
  meta.type = type; meta.tid = rbsp[1] & 7; meta.poc = 0; meta.rps = ''; meta.tmvp = false;
  const r = new BitReader(rbsp, 16);
  if (!r.flag()) throw new Error('A câmera tem mais de um slice por quadro; o merge espera 1');
  const isIrap = type >= 16 && type <= 23;
  const noOutputOfPriorPics = isIrap ? r.u(1) : 0;
  const ppsId = r.ue();

  // Trecho do meio do cabeçalho, copiado bit a bit.
  const midStart = r.pos;
  r.skip(pps.numExtraSliceHeaderBits);
  const sliceType = r.ue(); // 0=B 1=P 2=I
  meta.sliceType = sliceType;
  if (pps.outputFlagPresent) r.skip(1);
  if (sps.separateColourPlane) r.skip(2);
  let sliceTmvp = false;
  if (type !== 19 && type !== 20) {
    meta.poc = r.u(sps.log2MaxPocLsb);
    const rpsStart = r.pos;
    const fromSps = r.flag();
    if (!fromSps) parseStRps(r, sps.numStRps, sps.numStRps, sps.rpsDeltas);
    else if (sps.numStRps > 1) r.skip(Math.ceil(Math.log2(sps.numStRps)));
    meta.rps = Array.from({ length: r.pos - rpsStart }, (_, i) => (rbsp[(rpsStart + i) >> 3] >> (7 - ((rpsStart + i) & 7))) & 1).join('');
    if (sps.longTermRefsPresent) throw new Error('long-term refs não suportado');
    if (sps.temporalMvpEnabled) { sliceTmvp = r.flag(); meta.tmvp = sliceTmvp; }
  }
  let saoLuma = false, saoChroma = false;
  if (sps.saoEnabled) {
    saoLuma = r.flag();
    if (sps.chromaFormatIdc !== 0) saoChroma = r.flag();
  }
  if (sliceType !== 2) {
    let l0 = pps.numRefIdxL0Default, l1 = pps.numRefIdxL1Default;
    if (r.flag()) { l0 = r.ue() + 1; if (sliceType === 0) l1 = r.ue() + 1; }
    if (sliceType === 0) r.skip(1); // mvd_l1_zero_flag
    if (pps.cabacInitPresent) r.skip(1);
    if (sliceTmvp) {
      let fromL0 = true;
      if (sliceType === 0) fromL0 = r.flag();
      if ((fromL0 && l0 > 1) || (!fromL0 && l1 > 1)) r.ue();
    }
    // pred_weight_table(): só é lida para achar o fim do cabeçalho; os pesos valem por slice, e cada
    // câmera vira o seu próprio slice, então os bits são copiados como estão.
    if ((pps.weightedPred && sliceType === 1) || (pps.weightedBipred && sliceType === 0)) {
      r.ue();
      const chroma = sps.separateColourPlane ? 0 : sps.chromaFormatIdc;
      if (chroma !== 0) r.se();
      for (const n of sliceType === 0 ? [l0, l1] : [l0]) {
        const luma = [], chromaFlags = [];
        for (let i = 0; i < n; i++) luma.push(r.flag());
        if (chroma !== 0) for (let i = 0; i < n; i++) chromaFlags.push(r.flag());
        for (let i = 0; i < n; i++) {
          if (luma[i]) { r.se(); r.se(); }
          if (chromaFlags[i]) for (let j = 0; j < 2; j++) { r.se(); r.se(); }
        }
      }
    }
    r.ue(); // five_minus_max_num_merge_cand
  }
  r.se(); // slice_qp_delta
  if (pps.sliceChromaQpOffsetsPresent) { r.se(); r.se(); }
  let deblockDisabled = pps.deblockingDisabled;
  if (pps.deblockingOverrideEnabled && r.flag()) {
    deblockDisabled = r.flag();
    if (!deblockDisabled) { r.se(); r.se(); }
  }
  if (pps.loopFilterAcrossSlices && (saoLuma || saoChroma || !deblockDisabled)) r.skip(1);
  const midEnd = r.pos;

  // Entry points: sem WPP não há (1 slice = 1 tile). Com WPP, o tile tem as mesmas linhas de CTU
  // que o quadro da câmera tinha, então os offsets valem como estão e são copiados.
  let epStart = r.pos, epEnd = r.pos;
  if (pps.entropyCodingSync) {
    const n = r.ue();
    if (n > 0) { const len = r.ue() + 1; r.skip(len * n); }
    epEnd = r.pos;
  }
  let extStart = r.pos, extEnd = r.pos;
  if (pps.sliceHeaderExtPresent) { const len = r.ue(); extStart = r.pos; r.skip(len * 8); extEnd = r.pos; }
  // byte_alignment(): 1 + zeros
  if (r.u(1) !== 1) throw new Error('slice header mal formado (byte_alignment)');
  while (r.pos & 7) r.skip(1);
  const dataStart = r.pos >> 3;

  const w = new BitWriter();
  w.u(8, rbsp[0]); w.u(8, rbsp[1]);
  w.bit(isFirst ? 1 : 0);
  if (isIrap) w.bit(noOutputOfPriorPics);
  w.ue(ppsId);
  if (!isFirst) {
    if (pps.dependentSliceSegments) w.bit(0);
    w.u(addrBits, ctbAddr);
  }
  w.copy(rbsp, midStart, midEnd);
  if (pps.entropyCodingSync) w.copy(rbsp, epStart, epEnd);
  else w.ue(0); // num_entry_point_offsets: 1 slice = 1 tile
  if (pps.sliceHeaderExtPresent) { w.ue((extEnd - extStart) >> 3); w.copy(rbsp, extStart, extEnd); }
  w.trailing();
  const head = w.bytes();
  const out = new Uint8Array(head.length + rbsp.length - dataStart);
  out.set(head, 0);
  out.set(rbsp.subarray(dataStart), head.length);
  return toEbsp(out);
}

// ---------------------------------------------------------------------------
// MP4 (ISO BMFF) mínimo
// ---------------------------------------------------------------------------

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'dinf', 'stbl', 'mvex', 'edts', 'moof', 'traf']);
const PREFIX = { stsd: 8, hvc1: 78, hev1: 78 };
const td = new TextDecoder(), te = new TextEncoder();

function readU32(b, o) { return ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]; }
function writeU32(b, o, v) { b[o] = v >>> 24; b[o + 1] = (v >>> 16) & 255; b[o + 2] = (v >>> 8) & 255; b[o + 3] = v & 255; }

function parseBoxes(b, start = 0, end = b.length) {
  const out = [];
  let o = start;
  while (o + 8 <= end) {
    let size = readU32(b, o), hdr = 8;
    const type = td.decode(b.subarray(o + 4, o + 8));
    if (size === 1) { size = readU32(b, o + 8) * 2 ** 32 + readU32(b, o + 12); hdr = 16; }
    else if (size === 0) size = end - o;
    const box = { type, start: o, size };
    const pre = PREFIX[type];
    if (CONTAINERS.has(type) || pre !== undefined) {
      box.prefix = b.subarray(o + hdr, o + hdr + (pre || 0));
      box.children = parseBoxes(b, o + hdr + (pre || 0), o + size);
    } else {
      box.data = b.subarray(o + hdr, o + size);
    }
    out.push(box);
    o += size;
  }
  return out;
}

function serialize(box) {
  let body;
  if (box.children) {
    const parts = [box.prefix || new Uint8Array(0), ...box.children.map(serialize)];
    body = concat(parts);
  } else body = box.data;
  const out = new Uint8Array(8 + body.length);
  writeU32(out, 0, out.length);
  out.set(te.encode(box.type), 4);
  out.set(body, 8);
  return out;
}

function concat(parts) {
  let n = 0; for (const p of parts) n += p.length;
  const out = new Uint8Array(n); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const find = (boxes, type) => boxes.find((x) => x.type === type);
function findPath(boxes, path) {
  let cur = { children: boxes };
  for (const t of path) { cur = find(cur.children || [], t); if (!cur) return null; }
  return cur;
}

function parseHvcC(data) {
  const lengthSize = (data[21] & 3) + 1;
  const arrays = [];
  let o = 23;
  for (let i = 0; i < data[22]; i++) {
    const type = data[o] & 0x3f, n = (data[o + 1] << 8) | data[o + 2];
    o += 3;
    const nalus = [];
    for (let j = 0; j < n; j++) {
      const len = (data[o] << 8) | data[o + 1];
      nalus.push(data.subarray(o + 2, o + 2 + len)); o += 2 + len;
    }
    arrays.push({ type, nalus });
  }
  const get = (t) => (arrays.find((a) => a.type === t) || { nalus: [] }).nalus[0];
  return { header: data.subarray(0, 22), lengthSize, vps: get(32), sps: get(33), pps: get(34) };
}

function buildHvcC(header, vps, sps, pps) {
  const parts = [header, Uint8Array.of(3)];
  for (const [type, nal] of [[32, vps], [33, sps], [34, pps]]) {
    parts.push(Uint8Array.of(0x80 | type, 0, 1, nal.length >> 8, nal.length & 255), nal);
  }
  return concat(parts);
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

// Lê o init segment de uma câmera.
export function parseCameraInit(initBytes) {
  const boxes = parseBoxes(initBytes);
  const entry = findPath(boxes, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd']).children[0];
  const hvcCBox = find(entry.children, 'hvcC');
  if (!hvcCBox) {
    const kind = entry.type === 'avc1' || entry.type === 'avc3' ? 'H.264' : entry.type;
    throw new Error(`o stream é ${kind}, não HEVC: tiles só existem em HEVC (recodifique para HEVC, como o scripts/02_encode.sh faz)`);
  }
  const hvcC = parseHvcC(hvcCBox.data);
  if (hvcC.lengthSize !== 4) throw new Error('lengthSizeMinusOne diferente de 3 não suportado');
  const sps = parseSps(hvcC.sps), pps = parsePps(hvcC.pps);
  return { boxes, hvcC, sps, pps, raw: initBytes };
}

// Timescale (mdhd) de um init segment.
export function initTimescale(initBytes) {
  const mdhd = findPath(parseBoxes(initBytes), ['moov', 'trak', 'mdia', 'mdhd']).data;
  return readU32(mdhd, mdhd[0] === 1 ? 20 : 12);
}

// baseMediaDecodeTime (tfdt) do primeiro fragmento de um segmento.
export function firstDecodeTime(segBytes) {
  const moof = find(parseBoxes(segBytes), 'moof');
  if (!moof) throw new Error('segmento sem moof');
  return readFragment(segBytes, moof).decodeTime;
}

// Codec string RFC 6381 ("hvc1.1.6.L153.B0") a partir do hvcC de um init.
export function initCodecString(initBytes) {
  const { hvcC } = parseCameraInit(initBytes);
  const h = hvcC.header;
  const hex = (n) => n.toString(16).toUpperCase();
  const space = ['', 'A', 'B', 'C'][h[1] >> 6];
  let compat = 0;
  for (let i = 0; i < 32; i++) if ((readU32(h, 2) >>> i) & 1) compat |= 1 << (31 - i); // bits invertidos
  const cons = [...h.subarray(6, 12)];
  while (cons.length > 1 && cons[cons.length - 1] === 0) cons.pop();
  return `hvc1.${space}${h[1] & 31}.${hex(compat >>> 0)}.${h[1] & 32 ? 'H' : 'L'}${h[12]}.${cons.map(hex).join('.')}`;
}

// Grade usada para N câmeras.
// (1 câmera não precisa de merge; 3 exigiria um tile de preenchimento.)
export function gridFor(n) {
  if (n === 2) return { cols: 2, rows: 1 };
  if (n === 4) return { cols: 2, rows: 2 };
  throw new Error(`Grade para ${n} câmeras não suportada (use 2 ou 4)`);
}

const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// Menor nível HEVC (general_level_idc = nível x 30) cujo tamanho máximo de quadro comporta w x h.
const LEVELS = [[30, 36864], [60, 122880], [63, 245760], [90, 552960], [93, 983040], [120, 2228224], [123, 2228224],
  [150, 8912896], [153, 8912896], [156, 8912896], [180, 35651584], [183, 35651584], [186, 35651584]];
export function levelForSize(w, h) {
  for (const [idc, maxPs] of LEVELS) {
    const maxDim = Math.sqrt(8 * maxPs);
    if (w * h <= maxPs && w <= maxDim && h <= maxDim) return idc;
  }
  return 186;
}

// VPS com o general_level_idc trocado (byte 17 do RBSP: 2 de cabeçalho NAL + 4 de campos + 11 de PTL).
function patchVpsLevel(nal, level) {
  const rbsp = toRbsp(nal);
  if (rbsp.length <= 17 || rbsp[17] >= level) return nal;
  const out = rbsp.slice(); out[17] = level;
  return toEbsp(out);
}

// Cria o contexto do merge a partir dos inits das câmeras (na ordem dos tiles).
export function createMerger(cameraInits, opts = {}) {
  const cams = cameraInits.map(parseCameraInit);
  const c0 = cams[0];
  for (let i = 1; i < cams.length; i++) {
    if (!sameBytes(cams[i].hvcC.sps, c0.hvcC.sps) || !sameBytes(cams[i].hvcC.pps, c0.hvcC.pps)) {
      throw new Error(`SPS/PPS da câmera ${i + 1} diferem da câmera 1: encode todas com os mesmos parâmetros`);
    }
  }
  const { sps, pps } = c0;
  const n = cams.length, ctb = sps.ctbSize, wpp = pps.entropyCodingSync;
  const okW = sps.width % ctb === 0, okH = sps.height % ctb === 0;
  // Os limites entre tiles têm de cair em fronteiras de CTU; só a última coluna/linha pode ser parcial.
  //  - WPP: tiles lado a lado perdem o sincronismo do CABAC em decoders reais (a sincronização das
  //    linhas de CTU assume a largura do quadro); empilhados em 1 coluna o tile tem a largura do quadro.
  //  - largura e altura múltiplas do CTU: grade (2x2 ou 2x1), como sempre.
  //  - só a largura é (ex.: 1920x1080, 3840x2160, 960x540): 1 fileira de tiles; a altura fica livre.
  //  - só a altura é: 1 coluna.
  // Os layouts da página só recortam o frame, então a disposição dos tiles não aparece para quem assiste.
  let cols, rows;
  if (n < 2 || n > 4) throw new Error(`Multiview de ${n} canais não suportado (use 2 a 4)`);
  let wppRow = false;
  if (wpp) {
    if (okH) { cols = 1; rows = n; }
    else if (opts.allowWppRow && okW) { cols = n; rows = 1; wppRow = true; } // experimental: ver README
    else {
      throw new Error(`Canal com WPP e altura ${sps.height} não múltipla do CTU (${ctb}): com WPP os tiles têm de ficar empilhados, e a altura precisa ser múltipla do CTU. ` +
        'Opções: desligue o WPP no encoder (o mais seguro) ou habilite "tiles lado a lado com WPP (experimental)", que a especificação HEVC permite mas o FFmpeg não decodifica');
    }
  } else if (okW && okH) ({ cols, rows } = n === 3 ? { cols: 3, rows: 1 } : gridFor(n));
  else if (okW) { cols = n; rows = 1; }
  else if (okH) { cols = 1; rows = n; }
  else throw new Error(`Tile ${sps.width}x${sps.height}: nem a largura nem a altura é múltipla do CTU (${ctb}); use outra resolução ou um encoder com CTU menor`);
  const width = sps.width * cols, height = sps.height * rows;
  const picWCtbs = Math.ceil(width / ctb), picHCtbs = Math.ceil(height / ctb);
  const addrBits = Math.ceil(Math.log2(picWCtbs * picHCtbs));
  // Janela de corte do SPS (ex.: 540 linhas codificadas como 544): o canvas a descarta, então cada tile
  // guarda a área visível para o render recortar.
  const sw = sps.chromaFormatIdc === 1 || sps.chromaFormatIdc === 2 ? 2 : 1, sh = sps.chromaFormatIdc === 1 ? 2 : 1;
  const vis = { x: sps.confWin.left * sw, y: sps.confWin.top * sh };
  vis.w = sps.width - vis.x - sps.confWin.right * sw; vis.h = sps.height - vis.y - sps.confWin.bottom * sh;
  const tiles = cams.map((_, k) => {
    const col = k % cols, row = Math.floor(k / cols);
    return {
      x: col * sps.width, y: row * sps.height, w: sps.width, h: sps.height, vis,
      ctbAddr: row * Math.ceil(sps.height / ctb) * picWCtbs + col * (sps.width / ctb),
    };
  });
  // O canvas pode exceder o nível sinalizado pelo canal (ex.: 4 canais de 1080p precisam de nível 5): sobe o nível.
  const level = Math.max(sps.rbsp[14], levelForSize(width, height));
  const patched = { ...sps, rbsp: Object.assign(sps.rbsp.slice(), { 14: level }) };
  const vpsNal = patchVpsLevel(c0.hvcC.vps, level);
  const hvcHeader = Uint8Array.from(c0.hvcC.header); hvcHeader[12] = level;
  const canvasSps = buildCanvasSps(patched, width, height);
  const canvasPps = buildCanvasPps(pps, cols, rows);

  // Init segment do canvas: o da câmera 1 com hvcC e dimensões trocados.
  const initBoxes = parseBoxes(c0.raw);
  const tkhd = findPath(initBoxes, ['moov', 'trak', 'tkhd']);
  const tk = tkhd.data.slice(), off = tk[0] === 1 ? 88 : 76;
  writeU32(tk, off, width * 65536); writeU32(tk, off + 4, height * 65536);
  tkhd.data = tk;
  const entry = findPath(initBoxes, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd']).children[0];
  const pre = entry.prefix.slice();
  pre[24] = width >> 8; pre[25] = width & 255; pre[26] = height >> 8; pre[27] = height & 255;
  entry.prefix = pre;
  find(entry.children, 'hvcC').data = buildHvcC(hvcHeader, vpsNal, canvasSps, canvasPps);
  entry.children = entry.children.filter((b) => b.type === 'hvcC' || b.type === 'pasp' || b.type === 'colr');
  const init = concat(initBoxes.map(serialize));

  return {
    width, height, cols, rows, tiles, init, level,
    codecTile: { width: sps.width, height: sps.height, ctb: sps.ctbSize },
    wpp: c0.pps.entropyCodingSync, wppRow,
    mergeSegment: (segments, opts) => mergeSegment(cams, tiles, addrBits, segments, opts),
  };
}

// Lê as amostras de um fragmento (moof + mdat).
function readFragment(bytes, moof) {
  const traf = find(moof.children, 'traf');
  const tfhdB = find(traf.children, 'tfhd').data;
  const tfhdFlags = (tfhdB[1] << 16) | (tfhdB[2] << 8) | tfhdB[3];
  let o = 8, base = moof.start;
  const tfhd = { flags: tfhdFlags, trackId: readU32(tfhdB, 4) };
  if (tfhdFlags & 0x1) { base = readU32(tfhdB, o) * 2 ** 32 + readU32(tfhdB, o + 4); o += 8; }
  if (tfhdFlags & 0x2) { tfhd.sdi = readU32(tfhdB, o); o += 4; }
  if (tfhdFlags & 0x8) { tfhd.defDur = readU32(tfhdB, o); o += 4; }
  if (tfhdFlags & 0x10) { tfhd.defSize = readU32(tfhdB, o); o += 4; }
  if (tfhdFlags & 0x20) { tfhd.defFlags = readU32(tfhdB, o); o += 4; }
  const tfdt = find(traf.children, 'tfdt').data;
  const decodeTime = tfdt[0] === 1 ? readU32(tfdt, 4) * 2 ** 32 + readU32(tfdt, 8) : readU32(tfdt, 4);

  const trunB = find(traf.children, 'trun').data;
  const version = trunB[0];
  const flags = (trunB[1] << 16) | (trunB[2] << 8) | trunB[3];
  const count = readU32(trunB, 4);
  let p = 8, dataOffset = 0, firstFlags;
  if (flags & 0x1) { dataOffset = readU32(trunB, p) | 0; p += 4; }
  if (flags & 0x4) { firstFlags = readU32(trunB, p); p += 4; }
  const samples = [];
  let cursor = base + dataOffset;
  for (let i = 0; i < count; i++) {
    const s = {};
    if (flags & 0x100) { s.dur = readU32(trunB, p); p += 4; }
    if (flags & 0x200) { s.size = readU32(trunB, p); p += 4; } else s.size = tfhd.defSize;
    if (flags & 0x400) { s.flags = readU32(trunB, p); p += 4; }
    if (flags & 0x800) { s.cto = readU32(trunB, p) | 0; p += 4; }
    if (s.size === undefined) throw new Error('tamanho de amostra ausente');
    s.bytes = bytes.subarray(cursor, cursor + s.size);
    cursor += s.size;
    samples.push(s);
  }
  return { tfhd, tfdtBox: find(traf.children, 'tfdt'), decodeTime, version, flags, firstFlags, samples, mfhd: find(moof.children, 'mfhd') };
}

function splitNals(sample) {
  const nals = [];
  for (let o = 0; o + 4 <= sample.length;) {
    const len = readU32(sample, o);
    nals.push(sample.subarray(o + 4, o + 4 + len));
    o += 4 + len;
  }
  return nals;
}

// Junta todos os fragmentos de um segmento num só (amostras com campos explícitos).
// Usado quando as câmeras empacotam o mesmo tempo em números diferentes de fragmentos.
function flattenFragments(bytes, moofs) {
  const frags = moofs.map((m) => readFragment(bytes, m));
  const f0 = frags[0];
  const samples = [];
  for (const fr of frags) {
    fr.samples.forEach((s, i) => samples.push({
      dur: s.dur ?? fr.tfhd.defDur,
      bytes: s.bytes,
      flags: s.flags ?? (i === 0 && fr.firstFlags !== undefined ? fr.firstFlags : fr.tfhd.defFlags),
      cto: s.cto ?? 0,
    }));
  }
  if (samples.some((s) => s.dur === undefined || s.flags === undefined)) throw new Error('amostras sem duração/flags: não consigo juntar os fragmentos');
  return { ...f0, version: 1, flags: 0x1 | 0x100 | 0x200 | 0x400 | 0x800, firstFlags: undefined, samples };
}

// Resumo de um segmento fMP4: quadros, quantos começam num IRAP (IDR/CRA/BLA = quantos GOPs) e duração em ticks.
export function inspectSegment(bytes) {
  const moofs = parseBoxes(bytes).filter((b) => b.type === 'moof');
  if (!moofs.length) throw new Error('segmento sem moof');
  const f = flattenFragments(bytes, moofs);
  let irap = 0;
  for (const smp of f.samples) {
    if (splitNals(smp.bytes).some((n) => { const t = nalType(n); return t >= 16 && t <= 21; })) irap++;
  }
  return { frames: f.samples.length, irap, ticks: f.samples.reduce((a, x) => a + x.dur, 0) };
}

// opts.skipStructure: não confere tipo de quadro/POC/RPS entre as câmeras (GOPs diferentes costuram quadros inválidos).
// opts.baseTime: força o tfdt da saída (modo independente: o tempo é o do manifesto, não o de nenhuma câmera).
// opts.ignoreTime: câmeras independentes têm origens de tempo diferentes (tfdt); a saída usa o
// tempo da câmera 1 e os quadros são pareados por posição. A contagem de quadros ainda tem de bater.
const NAL_NAMES = { 0: 'TRAIL_N', 1: 'TRAIL_R', 2: 'TSA_N', 3: 'TSA_R', 4: 'STSA_N', 5: 'STSA_R', 6: 'RADL_N', 7: 'RADL_R', 8: 'RASL_N', 9: 'RASL_R',
  16: 'BLA_W_LP', 17: 'BLA_W_RADL', 18: 'BLA_N_LP', 19: 'IDR_W_RADL', 20: 'IDR_N_LP', 21: 'CRA' };

// Os slices de um mesmo quadro têm de concordar em tipo de NAL, POC, conjunto de referências e TMVP (7.4.7.1);
// se as câmeras têm GOPs diferentes, o quadro costurado seria inválido e o decoder trava ou corrompe.
function checkSameStructure(metas, frameIdx) {
  const m0 = metas[0];
  const irap = (t) => t >= 16 && t <= 23;
  const inter = metas.some((m) => m.sliceType !== 2); // algum slice P/B: o quadro depende de outros quadros
  for (let k = 1; k < metas.length; k++) {
    const m = metas[k];
    let what = null;
    if (irap(m.type) !== irap(m0.type)) what = `IDR/CRA num canal e quadro comum no outro (CAM 1: ${NAL_NAMES[m0.type] ?? m0.type}, CAM ${k + 1}: ${NAL_NAMES[m.type] ?? m.type})`;
    else if (inter) { // em quadros só intra os decoders toleram estas diferenças; com predição, não
      what = m.type !== m0.type ? `tipo de quadro (CAM 1: ${NAL_NAMES[m0.type] ?? m0.type}, CAM ${k + 1}: ${NAL_NAMES[m.type] ?? m.type})`
        : m.tid !== m0.tid ? 'camada temporal'
        : m.poc !== m0.poc ? `contagem de ordem do quadro (POC: CAM 1 = ${m0.poc}, CAM ${k + 1} = ${m.poc})`
        : m.rps !== m0.rps ? 'conjunto de quadros de referência (RPS)'
        : m.tmvp !== m0.tmvp ? 'slice_temporal_mvp_enabled_flag' : null;
    }
    if (what) {
      throw new Error(`quadro ${frameIdx + 1} do segmento: os canais diferem em ${what}. Os canais não têm a mesma estrutura de GOP ` +
        '(IDR ou referências em posições diferentes), então o quadro costurado seria inválido: o decoder trava ou corrompe a imagem');
    }
  }
}

function tfdtAt(t) {
  const d = new Uint8Array(12);
  d[0] = 1; writeU32(d, 4, Math.floor(t / 2 ** 32)); writeU32(d, 8, t % 2 ** 32);
  return d;
}

function mergeSegment(cams, tiles, addrBits, segments, opts = {}) {
  if (segments.length !== cams.length) throw new Error('número de segmentos diferente do número de câmeras');
  const parsed = segments.map((s) => ({ bytes: s, boxes: parseBoxes(s) }));
  const moofsPerCam = parsed.map((p) => p.boxes.filter((b) => b.type === 'moof'));
  let nFrag = moofsPerCam[0].length;
  let fragsPerCam = null;
  if (moofsPerCam.some((m) => m.length !== nFrag)) {
    fragsPerCam = parsed.map((p, k) => [flattenFragments(p.bytes, moofsPerCam[k])]);
    nFrag = 1;
  }

  const out = [];
  const styp = find(parsed[0].boxes, 'styp');
  if (styp) out.push(serialize(styp));
  const { sps, pps } = cams[0];

  let firstDecode;
  for (let f = 0; f < nFrag; f++) {
    const frags = fragsPerCam ? fragsPerCam.map((l) => l[f]) : parsed.map((p, k) => readFragment(p.bytes, moofsPerCam[k][f]));
    const f0 = frags[0];
    if (f === 0) firstDecode = f0.decodeTime;
    for (let k = 1; k < frags.length; k++) {
      if (frags[k].samples.length !== f0.samples.length) {
        throw new Error(`câmera ${k + 1} com ${frags[k].samples.length} quadros no segmento e a câmera 1 com ${f0.samples.length}: ` +
          'taxa de quadros e tamanho do GOP/segmento precisam ser iguais nas câmeras');
      }
      if (!opts.ignoreTime && frags[k].decodeTime !== f0.decodeTime) {
        throw new Error(`câmera ${k + 1} desalinhada no tempo (tfdt ${frags[k].decodeTime} vs ${f0.decodeTime}): ` +
          'os relógios das câmeras diferem; sincronize os encoders ou use o modo de streams independentes');
      }
    }

    // Amostras do canvas.
    const merged = f0.samples.map((_, i) => {
      const parts = [], metas = [];
      frags.forEach((fr, k) => {
        const vcl = splitNals(fr.samples[i].bytes).filter((n) => nalType(n) < 32);
        if (vcl.length !== 1) throw new Error(`câmera ${k + 1}: ${vcl.length} slices no quadro ${i} (esperado 1)`);
        const meta = {};
        const nal = rewriteSlice(vcl[0], sps, pps, k === 0, tiles[k].ctbAddr, addrBits, meta);
        metas.push(meta);
        const len = new Uint8Array(4); writeU32(len, 0, nal.length);
        parts.push(len, nal);
      });
      if (!opts.skipStructure) checkSameStructure(metas, i);
      return concat(parts);
    });

    // moof novo: mesmo tempo/durações da câmera 1, tamanhos novos.
    const has = (bit) => (f0.flags & bit) !== 0;
    const trunFlags = 0x1 | 0x200 | (f0.flags & (0x4 | 0x100 | 0x400 | 0x800));
    const perSample = 4 * [0x100, 0x200, 0x400, 0x800].filter((b) => trunFlags & b).length;
    const trun = new Uint8Array(8 + 4 + (trunFlags & 0x4 ? 4 : 0) + perSample * merged.length);
    trun[0] = f0.version; trun[1] = trunFlags >> 16; trun[2] = (trunFlags >> 8) & 255; trun[3] = trunFlags & 255;
    writeU32(trun, 4, merged.length);
    let p = 12;
    if (trunFlags & 0x4) { writeU32(trun, p, f0.firstFlags); p += 4; }
    merged.forEach((m, i) => {
      const s = f0.samples[i];
      if (has(0x100)) { writeU32(trun, p, s.dur); p += 4; }
      writeU32(trun, p, m.length); p += 4;
      if (has(0x400)) { writeU32(trun, p, s.flags); p += 4; }
      if (has(0x800)) { writeU32(trun, p, s.cto >>> 0); p += 4; }
    });

    // tfhd: sempre default-base-is-moof, sem base_data_offset nem default_sample_size.
    const t = f0.tfhd;
    const tfhdFlags = 0x20000 | (t.flags & (0x2 | 0x8 | 0x20));
    const fields = [t.trackId];
    if (tfhdFlags & 0x2) fields.push(t.sdi);
    if (tfhdFlags & 0x8) fields.push(t.defDur);
    if (tfhdFlags & 0x20) fields.push(t.defFlags);
    const tfhd = new Uint8Array(4 + 4 * fields.length);
    tfhd[1] = tfhdFlags >> 16; tfhd[2] = (tfhdFlags >> 8) & 255; tfhd[3] = tfhdFlags & 255;
    fields.forEach((v, i) => writeU32(tfhd, 4 + 4 * i, v));

    const moof = {
      type: 'moof', prefix: new Uint8Array(0), children: [
        { type: 'mfhd', data: f0.mfhd.data },
        { type: 'traf', prefix: new Uint8Array(0), children: [
          { type: 'tfhd', data: tfhd },
          { type: 'tfdt', data: opts.baseTime !== undefined ? tfdtAt(opts.baseTime + (f0.decodeTime - firstDecode)) : f0.tfdtBox.data },
          { type: 'trun', data: trun },
        ] },
      ],
    };
    const moofSize = serialize(moof).length;
    writeU32(trun, 8, moofSize + 8); // data_offset: início do payload do mdat
    out.push(serialize(moof), serialize({ type: 'mdat', data: concat(merged) }));
  }
  return concat(out);
}
