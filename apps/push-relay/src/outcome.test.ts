import { describe, expect, it } from "vitest";
import { reasonCode } from "./outcome.js";

/**
 * PROPERTY TEST della barriera anti-token.
 *
 * Gli altri test attaccano `reasonCode` con casi SCELTI a mano: il token intero
 * nel corpo, un frammento a un bordo, un token corto travestito da codice.
 * Vanno bene per i guasti che qualcuno ha già immaginato — ed è così che è
 * arrivato il bug della contenenza totale, sfuggito proprio perché nessuno
 * aveva scelto quel caso.
 *
 * Qui invece si genera un campione ampio e DETERMINISTICO (seed fisso, nessuna
 * flakiness) e si verifica l'invariante che il file promette: **ciò che esce da
 * `reasonCode` non condivide col token nessuna sequenza di 6 caratteri**. La
 * verifica usa un controllo scritto in modo indipendente dall'implementazione:
 * se un domani qualcuno tocca la soglia o riscrive la scansione, è questo
 * confronto a dire se la garanzia regge ancora.
 */

/** LCG (numerical recipes): deterministico e sufficiente per generare casi. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const RUN = 6;

/**
 * Controllo INDIPENDENTE: `a` e `b` condividono una sequenza di `RUN`
 * caratteri (o, se una delle due è più corta, di quanto è lunga)?
 */
function sharesRun(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  const n = Math.min(RUN, x.length, y.length);
  if (n === 0) return false;
  for (let i = 0; i + n <= x.length; i += 1) {
    if (y.includes(x.slice(i, i + n))) return true;
  }
  return false;
}

const HEX = "0123456789abcdef";
const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const CODE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_";

function pick(rng: () => number, alphabet: string, length: number): string {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += alphabet[Math.floor(rng() * alphabet.length)];
  }
  return out;
}

/** I casi generati: token di forme realistiche, codici a volte contaminati. */
function generate(rng: () => number): { token: string; code: string } {
  const shape = Math.floor(rng() * 3);
  const token =
    shape === 0
      ? pick(rng, HEX, 64) // APNs
      : shape === 1
        ? pick(rng, BASE64URL, 20 + Math.floor(rng() * 120)) // FCM
        : pick(rng, BASE64URL, 1 + Math.floor(rng() * 12)); // token corto, legale

  // Un codice ben formato, che in metà dei casi si porta dentro una fetta del
  // token in una posizione qualsiasi: è il modo in cui un frammento potrebbe
  // davvero arrivare da un corpo d'errore ostile.
  const head = pick(rng, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", 1);
  const clean = head + pick(rng, CODE_CHARS, Math.floor(rng() * 30));
  if (rng() < 0.5) return { token, code: clean };

  const sliceLen = 1 + Math.floor(rng() * Math.min(20, token.length));
  const sliceAt = Math.floor(rng() * (token.length - sliceLen + 1));
  const fragment = token.slice(sliceAt, sliceAt + sliceLen);
  const where = Math.floor(rng() * 3);
  const contaminated =
    where === 0 ? head + fragment + clean : where === 1 ? head + clean + fragment : head + fragment;
  return { token, code: contaminated };
}

describe("reasonCode — invariante su campione deterministico", () => {
  const rng = seededRandom(20260903);
  const cases = Array.from({ length: 400 }, () => generate(rng));

  it("genera sia casi contaminati sia casi puliti (il campione è utile)", () => {
    const contaminated = cases.filter(({ token, code }) => sharesRun(code, token)).length;
    expect(contaminated).toBeGreaterThan(20);
    expect(contaminated).toBeLessThan(cases.length - 20);
  });

  it.each(cases.map((c, i) => [i, c.token, c.code] as const))(
    "caso %i: ciò che esce non condivide 6 caratteri col token",
    (_i, token, code) => {
      const out = reasonCode(code, token);
      if (out === null) return; // rifiutato: nessuna fuga possibile
      expect(sharesRun(out, token)).toBe(false);
    },
  );
});
