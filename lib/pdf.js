/* Minimal dependency-free PDF writer — multi-page A4, tables, branding.
 * Produces real PDF 1.4 files readable by any PDF viewer.
 */
const A4_W = 595.28, A4_H = 841.89;
const MARGIN = 40;

function esc(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
    .replace(/[^\x20-\x7E₹–—‘’“”•·→≤≥]/g, c => {
      // map common unicode to PDF-safe approximations
      const map = { '₹': 'Rs.', '–': '-', '—': '-', '‘': "'", '’': "'", '“': '"', '”': '"', '•': '*', '·': '-', '→': '->', '≤': '<=', '≥': '>=' };
      return map[c] || '?';
    });
}
// approx glyph widths for Helvetica (units/em ~1000)
function width(str, size, bold) {
  let w = 0;
  for (const ch of String(str)) {
    const c = ch.charCodeAt(0);
    if (c >= 48 && c <= 57 || ch === '.' || ch === ':') w += 556;
    else if (ch === ' ') w += 278;
    else if (ch === ',' || ch === ';' || ch === "'" || ch === '|') w += 278;
    else if (ch === 'i' || ch === 'l' || ch === 'I' || ch === '!') w += 278;
    else if (ch === 'W' || ch === 'M' || w === 0 && false) w += 944;
    else if (ch >= 'A' && ch <= 'Z') w += 700;
    else w += 530;
  }
  if (bold) w *= 1.04;
  return w * size / 1000;
}
function wrap(str, maxW, size, bold) {
  const words = String(str).split(/\s+/);
  const lines = []; let cur = '';
  for (const word of words) {
    const test = cur ? cur + ' ' + word : word;
    if (width(test, size, bold) > maxW && cur) { lines.push(cur); cur = word; }
    else cur = test;
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

class Pdf {
  constructor() { this.pages = []; this.newPage(); }
  newPage() { this.ops = []; this.pages.push(this.ops); this.y = MARGIN; }
  ensure(space) { if (this.y + space > A4_H - MARGIN) this.newPage(); }
  text(x, yTop, str, o) {
    o = o || {};
    const size = o.size || 9, bold = o.bold;
    const font = bold ? '/F2' : '/F1';
    const invY = A4_H - yTop;
    let op = 'BT ' + font + ' ' + size + ' Tf ' + (o.color || '0 0 0') + ' rg';
    if (o.align === 'right') x = x - width(str, size, bold);
    if (o.align === 'center') x = x - width(str, size, bold) / 2;
    op += ' 1 0 0 1 ' + x.toFixed(2) + ' ' + invY.toFixed(2) + ' Tm (' + esc(str) + ') Tj ET';
    if (o.rule) { /* underline */ }
    this.ops.push(op);
  }
  line(x1, y1, x2, y2, gray) {
    const g = gray == null ? 0.8 : gray;
    this.ops.push(`${g} G 0.7 w ${x1.toFixed(2)} ${(A4_H - y1).toFixed(2)} m ${x2.toFixed(2)} ${(A4_H - y2).toFixed(2)} l S`);
  }
  rect(x, yTop, w, h, gray) {
    const g = gray == null ? 0.95 : gray;
    this.ops.push(`${g} g ${x.toFixed(2)} ${(A4_H - yTop - h).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f 0 g`);
  }
  // simple table: cols = [{label, w, align}], rows = [[...cells]]
  table(cols, rows, o) {
    o = o || {};
    const size = o.size || 8;
    const rowH = o.rowH || 16;
    const headFill = o.headFill || [0.29, 0.06, 0.07];
    let x0 = o.x != null ? o.x : MARGIN;
    const totalW = cols.reduce((s, c) => s + c.w, 0);
    // header
    this.ensure(rowH + 4);
    this.ops.push(`${headFill[0]} ${headFill[1]} ${headFill[2]} rg ${x0} ${(A4_H - this.y - rowH).toFixed(2)} ${totalW} ${rowH} re f 0 0 0 rg`);
    let x = x0;
    for (const c of cols) {
      const tx = c.align === 'right' ? x + c.w - 4 : x + 4;
      this.text(tx, this.y + rowH - 11, c.label, { size: size, bold: true, color: '1 1 1', align: c.align });
      x += c.w;
    }
    this.y += rowH;
    // rows
    let alt = false;
    for (const row of rows) {
      // compute needed height (multi-line cells)
      const cellLines = row.map((cell, i) => wrap(String(cell == null ? '' : cell), cols[i].w - 8, size, false));
      const maxL = Math.max(...cellLines.map(l => l.length));
      const h = Math.max(rowH, maxL * (size + 3) + 6);
      this.ensure(h);
      if (alt) this.rect(x0, this.y, totalW, h, 0.96);
      alt = !alt;
      x = x0;
      for (let i = 0; i < cols.length; i++) {
        const lines = cellLines[i];
        let ly = this.y + size + 2;
        for (const ln of lines) {
          const tx = cols[i].align === 'right' ? x + cols[i].w - 4 : x + 4;
          this.text(tx, ly, ln, { size, align: cols[i].align });
          ly += size + 3;
        }
        x += cols[i].w;
      }
      this.line(x0, this.y + h, x0 + totalW, this.y + h, 0.85);
      this.y += h;
    }
    this.y += 8;
  }
  render(meta) {
    // build PDF objects
    const objs = [];
    const add = s => { objs.push(s); return objs.length; };
    add('<< /Type /Catalog /Pages 2 0 R >>'); // 1
    const pagesObjIdx = add(''); // 2 placeholder
    const font1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
    const font2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');
    const pageIds = [];
    for (const ops of this.pages) {
      const content = ops.join('\n');
      const cid = add(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
      const pid = add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4_W} ${A4_H}] /Contents ${cid} 0 R /Resources << /Font << /F1 ${font1} 0 R /F2 ${font2} 0 R >> >> >>`);
      pageIds.push(pid);
    }
    objs[pagesObjIdx - 1] = `<< /Type /Pages /Kids [${pageIds.map(i => i + ' 0 R').join(' ')}] /Count ${pageIds.length} >>`;
    const info = add(`<< /Title (${esc((meta && meta.title) || 'Report')}) /Producer (Karim\'s Restaurant Platform) /CreationDate (D:${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}) >>`);
    // xref
    let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
    const offsets = [0];
    for (let i = 0; i < objs.length; i++) {
      offsets.push(Buffer.byteLength(out, 'latin1'));
      out += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`;
    }
    const xrefPos = Buffer.byteLength(out, 'latin1');
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    for (let i = 1; i <= objs.length; i++) out += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
    out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info ${info} 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
    return Buffer.from(out, 'latin1');
  }
}

module.exports = { Pdf, A4_W, A4_H, MARGIN, width, wrap };
