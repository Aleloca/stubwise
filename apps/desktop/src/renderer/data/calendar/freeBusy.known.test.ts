import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { strangersTo } from "../../test/strangers";
import { calendar, resetApi, setLatency } from "../api";
import { setSessionPersonId } from "../session";
import { state } from "../store";

// Registro, A11 r.1414, lotto 3 (calendario): `freeBusy` rispondeva per
// QUALSIASI id, e diceva così chi esiste e chi ha il calendario collegato
// (un «oracolo»). Per una persona che chi guarda non conosce ora risponde
// come per una che non esiste: `not_connected`, nessun intervallo.

const LAURA = "p-laura";

beforeEach(() => {
  resetApi();
  setLatency(0);
});
afterEach(() => resetApi());

describe("freeBusy senza oracolo (r.1414)", () => {
  it("uno sconosciuto col calendario collegato risponde come un id che non esiste", async () => {
    const [who] = strangersTo(LAURA);
    if (!state.googleAccounts.some((a) => a.personId === who))
      state.googleAccounts.push({
        personId: who!,
        email: "x@example.com",
        status: "connected",
        since: "2026-11-01T00:00:00Z",
      });
    setSessionPersonId(LAURA);
    const from = "2026-11-23T00:00:00Z";
    const to = "2026-11-24T00:00:00Z";
    const [stranger, nobody] = await calendar.freeBusy([who!, "p-nobody"], from, to);
    expect(stranger).toEqual({ personId: who, availability: "not_connected", busy: [] });
    expect(nobody!.availability).toBe("not_connected");
  });
});
