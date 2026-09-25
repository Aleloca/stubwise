import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

/**
 * L'ICONA DELLA TAB WISEY sui FILE che questo script genera, non sul
 * cablaggio (quello lo prova `src/app/navigation.test.tsx`): 28×27 pt, cioè il gufo a 28×24 in ALTO più 3 pt di
 * margine TRASPARENTE sotto (25 set 2026). Senza il margine, sul telefono il
 * gufo toccava la scritta «WISEY»: nel fotogramma 56×48 il disegno arriva a
 * 1 px dal bordo, mentre gli SF Symbol delle altre tab hanno aria intorno.
 *
 * Si leggono i PNG a mano (IHDR per le misure, IDAT decompresso per l'alfa)
 * per non aggiungere una dipendenza di test: i file li scrive
 * `wisey-assets.py` sempre RGBA 8 bit, non interlacciati. È un `.mjs`
 * come `version-bump.test.mjs` qui accanto: legge file con Node, e la
 * tsconfig dell'app (React Native) non ha i tipi di Node.
 */
// `__dirname` e non `import.meta`: babel-jest trasforma questo file in CommonJS.
const ASSETS = join(__dirname, "../assets/wisey");

function decodeRgba(file) {
  const png = readFileSync(join(ASSETS, file));
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  expect(png[24]).toBe(8); // bit depth
  expect(png[25]).toBe(6); // RGBA
  const chunks = [];
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") chunks.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * 4;
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x += 1) {
      const value = raw[y * (stride + 1) + 1 + x];
      const left = x >= 4 ? pixels[y * stride + x - 4] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const upLeft = x >= 4 && y > 0 ? pixels[(y - 1) * stride + x - 4] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = Math.floor((left + up) / 2);
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      pixels[y * stride + x] = (value + predictor) & 0xff;
    }
  }
  return { width, height, alpha: (x, y) => pixels[y * stride + x * 4 + 3] };
}

/**
 * Design §10: l'icona della tab si ANIMA sulla stessa fase del gufo grande,
 * quindi non è più un file solo ma quattro fotogrammi per ognuna delle sei
 * fasi, ciascuno alle tre densità.
 */
const PHASES = ["riposo", "ascolta", "pensa", "lavora", "parla", "fatto"];
const TAB_FILES = PHASES.flatMap((phase) =>
  [0, 1, 2, 3].flatMap((frame) =>
    [
      [`wisey-tab-${phase}-${frame}.png`, 1],
      [`wisey-tab-${phase}-${frame}@2x.png`, 2],
      [`wisey-tab-${phase}-${frame}@3x.png`, 3],
    ],
  ),
);

describe("l'icona della tab Wisey", () => {
  test("sei fasi × quattro fotogrammi × tre densità", () => {
    expect(TAB_FILES).toHaveLength(72);
  });

  test.each(TAB_FILES)("%s: tela 28×27 pt, gufo 28×24 in alto, 3 pt trasparenti sotto", (file, scale) => {
    const icon = decodeRgba(file);
    expect([icon.width, icon.height]).toEqual([28 * scale, 27 * scale]);

    const opaqueRows = new Set();
    for (let y = 0; y < icon.height; y += 1) {
      for (let x = 0; x < icon.width; x += 1) if (icon.alpha(x, y) > 0) opaqueRows.add(y);
    }
    // Il margine: nessun pixel visibile negli ultimi 3 pt.
    expect(Math.max(...opaqueRows)).toBeLessThan(24 * scale);
    // Il gufo NON è stato rimpicciolito: arriva ancora in fondo ai suoi 24 pt.
    expect(Math.max(...opaqueRows)).toBeGreaterThanOrEqual(24 * scale - Math.ceil(scale));
  });

  test("i quattro fotogrammi di una fase sono DIVERSI: la barra ha qualcosa da animare", () => {
    for (const phase of PHASES) {
      const frames = [0, 1, 2, 3].map((frame) => readFileSync(join(ASSETS, `wisey-tab-${phase}-${frame}@2x.png`)).toString("base64"));
      expect(new Set(frames).size).toBeGreaterThan(1);
    }
  });
});
