// Codifiche della cassaforte: base64url per i campi binari delle buste JSON,
// base32 (RFC 4648, senza padding) per il kit di recupero stampabile, e la
// lettura di una busta `{ v: 1, ... }`. Nessuna dipendenza: deve girare
// uguale in Node ≥ 22 e nel browser.

/** Versione del formato delle buste cifrate. */
export const ENVELOPE_VERSION = 1;

/**
 * Copia in un `Uint8Array` su un `ArrayBuffer` proprio: WebCrypto accetta
 * solo `BufferSource` su `ArrayBuffer` (non `SharedArrayBuffer`), e i tipi
 * di TypeScript lo pretendono.
 */
export function bytes(input: ArrayBuffer | Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(input.byteLength);
  out.set(input instanceof Uint8Array ? input : new Uint8Array(input));
  return out;
}

export function utf8(text: string): Uint8Array<ArrayBuffer> {
  return bytes(new TextEncoder().encode(text));
}

export function fromUtf8(data: ArrayBuffer | Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(data);
}

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function encodeBits(data: Uint8Array, alphabet: string, bitsPerChar: number): string {
  let out = "";
  let buffer = 0;
  let count = 0;
  const mask = (1 << bitsPerChar) - 1;
  for (const byte of data) {
    buffer = (buffer << 8) | byte;
    count += 8;
    while (count >= bitsPerChar) {
      count -= bitsPerChar;
      out += alphabet[(buffer >> count) & mask];
    }
    buffer &= (1 << count) - 1;
  }
  if (count > 0) out += alphabet[(buffer << (bitsPerChar - count)) & mask];
  return out;
}

/**
 * Decodifica STRETTA: rifiuta caratteri fuori alfabeto e bit di coda non
 * nulli, così ogni byte sequence ha una sola rappresentazione — un
 * carattere cambiato nel kit cambia sempre i byte e quindi il checksum.
 */
function decodeBits(text: string, alphabet: string, bitsPerChar: number, label: string): Uint8Array<ArrayBuffer> {
  const out: number[] = [];
  let buffer = 0;
  let count = 0;
  for (const ch of text) {
    const value = alphabet.indexOf(ch);
    if (value < 0) throw new Error(`${label}: carattere non valido`);
    buffer = (buffer << bitsPerChar) | value;
    count += bitsPerChar;
    if (count >= 8) {
      count -= 8;
      out.push((buffer >> count) & 0xff);
    }
    buffer &= (1 << count) - 1;
  }
  if (count >= bitsPerChar || buffer !== 0) throw new Error(`${label}: coda non valida`);
  return new Uint8Array(out);
}

export function toBase64Url(data: Uint8Array | ArrayBuffer): string {
  return encodeBits(bytes(data), B64URL, 6);
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  return decodeBits(text, B64URL, 6, "base64url");
}

export function toBase32(data: Uint8Array | ArrayBuffer): string {
  return encodeBits(bytes(data), B32, 5);
}

export function fromBase32(text: string): Uint8Array<ArrayBuffer> {
  return decodeBits(text, B32, 5, "base32");
}

/** Serializza una busta: `v: 1` più i campi binari in base64url. */
export function formatEnvelope(fields: Record<string, Uint8Array | ArrayBuffer>): string {
  const out: Record<string, string | number> = { v: ENVELOPE_VERSION };
  for (const [name, value] of Object.entries(fields)) out[name] = toBase64Url(value);
  return JSON.stringify(out);
}

/**
 * Legge una busta e ne decodifica i campi richiesti. Lancia su JSON non
 * valido, versione diversa da 1, campo mancante o non base64url.
 */
export function parseEnvelope<K extends string>(
  text: string,
  fields: readonly K[],
): Record<K, Uint8Array<ArrayBuffer>> {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null) throw new Error("busta non valida");
  const record = parsed as Record<string, unknown>;
  if (record.v !== ENVELOPE_VERSION) throw new Error("versione della busta non supportata");
  const out = {} as Record<K, Uint8Array<ArrayBuffer>>;
  for (const name of fields) {
    const value = record[name];
    if (typeof value !== "string") throw new Error(`busta non valida: campo ${name}`);
    out[name] = fromBase64Url(value);
  }
  return out;
}
