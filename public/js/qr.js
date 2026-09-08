/**
 * Minimal QR code generator - byte mode, error correction level M, versions 1-10.
 * Enough for a booking reference or a short ticket URL, with no external library.
 *
 *   QR.render(canvasElement, 'MBS1234ABCD', { size: 168 });
 */
const QR = (() => {
  /* ---------- Galois field tables for Reed-Solomon ---------- */

  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  (() => {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();

  const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

  /** Generator polynomial for `degree` error-correction codewords. */
  function rsPoly(degree) {
    let poly = [1];
    for (let i = 0; i < degree; i++) {
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= mul(poly[j], EXP[i]);
        next[j + 1] ^= poly[j];
      }
      poly = next;
    }
    return poly;
  }

  function rsEncode(data, ecCount) {
    const gen = rsPoly(ecCount);
    const res = new Array(ecCount).fill(0);
    for (const byte of data) {
      const factor = byte ^ res[0];
      res.shift();
      res.push(0);
      for (let i = 0; i < ecCount; i++) res[i] ^= mul(gen[i + 1], factor);
    }
    return res;
  }

  /* ---------- version tables (error correction level M) ---------- */

  // [ total codewords, ec codewords per block, group1 blocks, group2 blocks ]
  const VERSIONS = {
    1: [26, 10, 1, 0], 2: [44, 16, 1, 0], 3: [70, 26, 1, 0], 4: [100, 18, 2, 0],
    5: [134, 24, 2, 0], 6: [172, 16, 4, 0], 7: [196, 18, 4, 0], 8: [242, 22, 4, 0],
    9: [292, 22, 5, 0], 10: [346, 26, 5, 1],
  };

  const ALIGN = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
    6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
  };

  const dataCapacity = (v) => {
    const [total, ecPer, g1, g2] = VERSIONS[v];
    return total - ecPer * (g1 + g2);
  };

  function pickVersion(byteLength) {
    for (let v = 1; v <= 10; v++) {
      const header = 4 + (v < 10 ? 8 : 16);          // mode indicator + char count
      if (dataCapacity(v) * 8 >= header + byteLength * 8) return v;
    }
    throw new Error('Text is too long for this QR encoder');
  }

  /* ---------- bit stream ---------- */

  class Bits {
    constructor() { this.bits = []; }
    push(value, length) {
      for (let i = length - 1; i >= 0; i--) this.bits.push((value >> i) & 1);
    }
    get length() { return this.bits.length; }
    toBytes() {
      while (this.bits.length % 8) this.bits.push(0);
      const out = [];
      for (let i = 0; i < this.bits.length; i += 8) {
        let b = 0;
        for (let j = 0; j < 8; j++) b = (b << 1) | this.bits[i + j];
        out.push(b);
      }
      return out;
    }
  }

  function buildCodewords(text, version) {
    const bytes = new TextEncoder().encode(text);
    const capacity = dataCapacity(version);

    const bits = new Bits();
    bits.push(0b0100, 4);                                   // byte mode
    bits.push(bytes.length, version < 10 ? 8 : 16);
    for (const b of bytes) bits.push(b, 8);

    const remaining = capacity * 8 - bits.length;
    bits.push(0, Math.min(4, Math.max(0, remaining)));       // terminator

    let data = bits.toBytes();
    const PAD = [0xec, 0x11];
    for (let i = 0; data.length < capacity; i++) data.push(PAD[i % 2]);

    /* Split into blocks, add error correction, then interleave. */
    const [, ecPer, g1, g2] = VERSIONS[version];
    const blockCount = g1 + g2;
    const shortLen = Math.floor(capacity / blockCount);

    const dataBlocks = [];
    const ecBlocks = [];
    let offset = 0;
    for (let i = 0; i < blockCount; i++) {
      const len = shortLen + (i >= g1 ? 1 : 0);
      const block = data.slice(offset, offset + len);
      offset += len;
      dataBlocks.push(block);
      ecBlocks.push(rsEncode(block, ecPer));
    }

    const out = [];
    const maxData = Math.max(...dataBlocks.map((b) => b.length));
    for (let i = 0; i < maxData; i++) {
      for (const block of dataBlocks) if (i < block.length) out.push(block[i]);
    }
    for (let i = 0; i < ecPer; i++) {
      for (const block of ecBlocks) out.push(block[i]);
    }
    return out;
  }

  /* ---------- matrix ---------- */

  function buildMatrix(version, codewords, mask) {
    const size = version * 4 + 17;
    const m = Array.from({ length: size }, () => new Array(size).fill(null));
    const reserved = Array.from({ length: size }, () => new Array(size).fill(false));

    const setFinder = (r, c) => {
      for (let i = -1; i <= 7; i++) {
        for (let j = -1; j <= 7; j++) {
          const y = r + i, x = c + j;
          if (y < 0 || y >= size || x < 0 || x >= size) continue;
          const edge = i === 0 || i === 6 || j === 0 || j === 6;
          const core = i >= 2 && i <= 4 && j >= 2 && j <= 4;
          m[y][x] = edge || core ? 1 : 0;
          reserved[y][x] = true;
        }
      }
    };
    setFinder(0, 0);
    setFinder(0, size - 7);
    setFinder(size - 7, 0);

    /* timing patterns */
    for (let i = 8; i < size - 8; i++) {
      m[6][i] = m[i][6] = i % 2 === 0 ? 1 : 0;
      reserved[6][i] = reserved[i][6] = true;
    }

    /* alignment patterns */
    const centres = ALIGN[version];
    for (const r of centres) {
      for (const c of centres) {
        if (reserved[r][c]) continue;
        for (let i = -2; i <= 2; i++) {
          for (let j = -2; j <= 2; j++) {
            m[r + i][c + j] = Math.max(Math.abs(i), Math.abs(j)) !== 1 ? 1 : 0;
            reserved[r + i][c + j] = true;
          }
        }
      }
    }

    /* format information areas + dark module */
    for (let i = 0; i < 9; i++) {
      if (!reserved[8][i]) { reserved[8][i] = true; m[8][i] = 0; }
      if (!reserved[i][8]) { reserved[i][8] = true; m[i][8] = 0; }
    }
    for (let i = 0; i < 8; i++) {
      reserved[8][size - 1 - i] = true; m[8][size - 1 - i] = 0;
      reserved[size - 1 - i][8] = true; m[size - 1 - i][8] = 0;
    }
    m[size - 8][8] = 1;
    reserved[size - 8][8] = true;

    /* version information (version 7 and up) */
    if (version >= 7) {
      let rem = version;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >> 11) * 0x1f25);
      const info = (version << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const bit = (info >> i) & 1;
        const r = Math.floor(i / 3), c = i % 3;
        m[r][size - 11 + c] = bit; reserved[r][size - 11 + c] = true;
        m[size - 11 + c][r] = bit; reserved[size - 11 + c][r] = true;
      }
    }

    /* zig-zag data placement */
    const maskFn = [
      (r, c) => (r + c) % 2 === 0,
      (r) => r % 2 === 0,
      (r, c) => c % 3 === 0,
      (r, c) => (r + c) % 3 === 0,
      (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
      (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
      (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
      (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
    ][mask];

    let bitIndex = 0;
    let upward = true;
    for (let col = size - 1; col > 0; col -= 2) {
      if (col === 6) col--;                                  // skip the timing column
      for (let i = 0; i < size; i++) {
        const row = upward ? size - 1 - i : i;
        for (const c of [col, col - 1]) {
          if (reserved[row][c]) continue;
          const byte = codewords[bitIndex >> 3];
          let bit = byte === undefined ? 0 : (byte >> (7 - (bitIndex & 7))) & 1;
          bitIndex++;
          if (maskFn(row, c)) bit ^= 1;
          m[row][c] = bit;
        }
      }
      upward = !upward;
    }

    /* format information: EC level M (0b00) plus the mask */
    const formatBits = (() => {
      const data = (0b00 << 3) | mask;
      let rem = data;
      for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) * 0x537);
      return ((data << 10) | rem) ^ 0x5412;
    })();

    for (let i = 0; i < 15; i++) {
      const bit = (formatBits >> i) & 1;
      if (i < 6) m[8][i] = bit;
      else if (i < 8) m[8][i + 1] = bit;
      else if (i === 8) m[7][8] = bit;
      else m[14 - i][8] = bit;

      // Second copy: bits 0-6 run up the left column, bits 7-14 along the top row.
      // Bit 7 must NOT land on (size-8, 8) - that is the permanent dark module.
      if (i < 7) m[size - 1 - i][8] = bit;
      else m[8][size - 15 + i] = bit;
    }

    return m;
  }

  /** Standard penalty score - lower is better. */
  function penalty(m) {
    const size = m.length;
    let score = 0;

    for (let r = 0; r < size; r++) {
      for (const horizontal of [true, false]) {
        let run = 1;
        for (let c = 1; c < size; c++) {
          const cur = horizontal ? m[r][c] : m[c][r];
          const prev = horizontal ? m[r][c - 1] : m[c - 1][r];
          if (cur === prev) { run++; }
          else { if (run >= 5) score += run - 2; run = 1; }
        }
        if (run >= 5) score += run - 2;
      }
    }

    for (let r = 0; r < size - 1; r++) {
      for (let c = 0; c < size - 1; c++) {
        const v = m[r][c];
        if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
      }
    }

    let dark = 0;
    for (const row of m) for (const v of row) dark += v;
    const percent = (dark * 100) / (size * size);
    score += Math.floor(Math.abs(percent - 50) / 5) * 10;

    return score;
  }

  function build(text) {
    const version = pickVersion(new TextEncoder().encode(text).length);
    const codewords = buildCodewords(text, version);

    let best = null;
    let bestScore = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      const m = buildMatrix(version, codewords, mask);
      const score = penalty(m);
      if (score < bestScore) { bestScore = score; best = m; }
    }
    return best;
  }

  /** Draws the code into a canvas element. */
  function render(canvas, text, { size = 160, quiet = 4, dark = '#000', light = '#fff' } = {}) {
    const matrix = build(text);
    const modules = matrix.length + quiet * 2;
    const scale = Math.max(1, Math.floor(size / modules));
    const px = modules * scale;

    canvas.width = px;
    canvas.height = px;
    canvas.style.width = px + 'px';
    canvas.style.height = px + 'px';

    const ctx = canvas.getContext('2d');
    ctx.fillStyle = light;
    ctx.fillRect(0, 0, px, px);
    ctx.fillStyle = dark;
    for (let r = 0; r < matrix.length; r++) {
      for (let c = 0; c < matrix.length; c++) {
        if (matrix[r][c]) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
      }
    }
    return canvas;
  }

  return { build, render };
})();
