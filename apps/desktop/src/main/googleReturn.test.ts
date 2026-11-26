import { describe, expect, it, vi } from "vitest";
import { GOOGLE_RETURN_TTL_MS, createGoogleReturn } from "./googleReturn";

// Lotto 4, §6: il ritorno dal consenso di Google al desktop,
// `stubwise://google?outcome=<esito>&state=<returnState>`. Il main tiene UNA
// richiesta pendente (10 minuti), monouso; l'URL porta solo l'esito e lo
// state, e tutto il resto si ignora senza avvisi. Al renderer va
// `{ state, outcome }`: l'esito non è un'autorità, il renderer conferma `ok`
// rileggendo le caselle.

function setup(start = 1_000) {
  let t = start;
  const notify = vi.fn();
  const r = createGoogleReturn({ notify, now: () => t });
  return { r, notify, advance: (ms: number) => (t += ms) };
}

describe("il ritorno di Google al desktop", () => {
  it("lo state pendente e un esito noto: un avviso al renderer, una volta sola", () => {
    const { r, notify } = setup();
    const { state } = r.prepare();
    expect(state).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(r.handleGoogleUrl(`stubwise://google?outcome=domain_mismatch&state=${state}`)).toEqual({
      state,
      outcome: "domain_mismatch",
    });
    expect(notify).toHaveBeenCalledWith({ state, outcome: "domain_mismatch" });
    // Monouso.
    expect(r.handleGoogleUrl(`stubwise://google?outcome=ok&state=${state}`)).toBeNull();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("si ignora: state sconosciuto, esito fuori elenco, scaduto, annullato, un altro hostname", () => {
    const { r, notify, advance } = setup();
    const { state } = r.prepare();
    expect(r.handleGoogleUrl("stubwise://google?outcome=ok&state=nope-nope-nope-nope")).toBeNull();
    expect(r.handleGoogleUrl(`stubwise://google?outcome=granted&state=${state}`)).toBeNull();
    expect(r.handleGoogleUrl(`stubwise://auth?outcome=ok&state=${state}`)).toBeNull();
    expect(r.handleGoogleUrl(`https://google?outcome=ok&state=${state}`)).toBeNull();
    expect(r.handleGoogleUrl("not a url")).toBeNull();
    advance(GOOGLE_RETURN_TTL_MS + 1);
    expect(r.handleGoogleUrl(`stubwise://google?outcome=ok&state=${state}`)).toBeNull();
    const again = r.prepare();
    r.cancel();
    expect(r.handleGoogleUrl(`stubwise://google?outcome=ok&state=${again.state}`)).toBeNull();
    expect(notify).not.toHaveBeenCalled();
  });

  it("una richiesta nuova sostituisce la precedente", () => {
    const { r, notify } = setup();
    const first = r.prepare();
    const second = r.prepare();
    expect(second.state).not.toBe(first.state);
    expect(r.handleGoogleUrl(`stubwise://google?outcome=ok&state=${first.state}`)).toBeNull();
    expect(r.handleGoogleUrl(`stubwise://google?outcome=ok&state=${second.state}`)).toEqual({
      state: second.state,
      outcome: "ok",
    });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("i parametri in più non passano al renderer", () => {
    const { r, notify } = setup();
    const { state } = r.prepare();
    r.handleGoogleUrl(`stubwise://google?outcome=ok&state=${state}&code=secret&email=a@b.c`);
    expect(notify).toHaveBeenCalledWith({ state, outcome: "ok" });
  });
});
