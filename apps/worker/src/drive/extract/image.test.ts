import { describe, expect, it } from "vitest";
import { imageSize } from "./image.js";

// Le dimensioni di un'immagine dall'intestazione, in JS, PRIMA di passarla a
// tesseract: oltre i 40 megapixel non si legge.
function png(w: number, h: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const v = new DataView(b.buffer);
  v.setUint32(16, w);
  v.setUint32(20, h);
  return b;
}
function jpeg(w: number, h: number): Uint8Array {
  // SOI, un APP0 da 16 byte, poi SOF0 con altezza e larghezza.
  const app0 = [0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0)];
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 3];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof, ...new Array(10).fill(0)]);
}
function gif(w: number, h: number): Uint8Array {
  return new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, w & 255, w >> 8, h & 255, h >> 8, 0, 0, 0]);
}
function webpVp8x(w: number, h: number): Uint8Array {
  const b = new Uint8Array(30);
  b.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58]);
  const w1 = w - 1;
  const h1 = h - 1;
  b.set([w1 & 255, (w1 >> 8) & 255, (w1 >> 16) & 255, h1 & 255, (h1 >> 8) & 255, (h1 >> 16) & 255], 24);
  return b;
}

describe("imageSize", () => {
  it("PNG, JPEG, GIF e WebP", () => {
    expect(imageSize(png(4000, 3000))).toEqual({ width: 4000, height: 3000 });
    expect(imageSize(jpeg(1024, 768))).toEqual({ width: 1024, height: 768 });
    expect(imageSize(gif(320, 200))).toEqual({ width: 320, height: 200 });
    expect(imageSize(webpVp8x(10000, 5000))).toEqual({ width: 10000, height: 5000 });
  });
  it("un'intestazione che non si capisce è null", () => {
    expect(imageSize(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(imageSize(png(4000, 3000).slice(0, 20))).toBeNull();
  });
});
