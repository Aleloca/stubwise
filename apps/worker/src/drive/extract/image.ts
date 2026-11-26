/**
 * Le dimensioni di un'immagine dalla sua intestazione, in JS (area 5, fetta
 * 3): servono a rifiutare un'immagine oltre i 40 megapixel PRIMA di passarla a
 * tesseract, che la decomprimerebbe tutta. Null = un'intestazione che non si
 * capisce.
 */
export function imageSize(b: Uint8Array): { width: number; height: number } | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const at = (i: number, ...bytes: number[]) => bytes.every((x, k) => b[i + k] === x);
  // PNG: firma, poi IHDR con larghezza e altezza a 32 bit big-endian.
  if (b.length >= 24 && at(0, 0x89, 0x50, 0x4e, 0x47) && at(12, 0x49, 0x48, 0x44, 0x52)) {
    return { width: v.getUint32(16), height: v.getUint32(20) };
  }
  // GIF: larghezza e altezza a 16 bit little-endian.
  if (b.length >= 10 && at(0, 0x47, 0x49, 0x46, 0x38)) return { width: v.getUint16(6, true), height: v.getUint16(8, true) };
  // WebP: VP8X (24 bit + 1), VP8 (14 bit), VP8L (14 bit + 1).
  if (b.length >= 30 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) {
    if (at(12, 0x56, 0x50, 0x38, 0x58)) {
      return { width: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), height: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)) };
    }
    if (at(12, 0x56, 0x50, 0x38, 0x20)) return { width: v.getUint16(26, true) & 0x3fff, height: v.getUint16(28, true) & 0x3fff };
    if (at(12, 0x56, 0x50, 0x38, 0x4c)) {
      const bits = v.getUint32(21, true);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    return null;
  }
  // JPEG: i segmenti fino a un SOF (C0–CF, tranne C4, C8, CC).
  if (b.length >= 4 && at(0, 0xff, 0xd8)) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1]!;
      const len = v.getUint16(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: v.getUint16(i + 7), height: v.getUint16(i + 5) };
      }
      if (len < 2) return null;
      i += 2 + len;
    }
    return null;
  }
  return null;
}
