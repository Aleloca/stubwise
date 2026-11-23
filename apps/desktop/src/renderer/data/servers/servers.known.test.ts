import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { strangersTo } from "../../test/strangers";
import { resetApi, servers, setLatency } from "../api";
import { isFullAdmin } from "../access/index";
import { PEOPLE } from "../seed/people";
import { setSessionPersonId } from "../session";
import { state } from "../store";

// Registro, A11 r.1414, lotto 3 (server), nel prototipo: chi ha avviato
// l'analisi a mano di un server, se chi guarda non lo conosce, è
// `{ id: hidden-<n>, name: "" }` (la pagina scrive «Someone»).

beforeEach(() => {
  resetApi();
  setLatency(0);
});
afterEach(() => resetApi());

describe("i server senza id di chi non si conosce (r.1414)", () => {
  it("l'analisi a mano: chi l'ha avviata, segnaposto e senza nome", async () => {
    // Un'analisi del seme, fatta «a mano» (le manuali nascono a runtime).
    const analysis = state.serverAnalyses[0]!;
    expect(analysis).toBeDefined();
    // Chi guarda: una persona (non full admin) che apre quel server e ha qualcuno che non conosce.
    let viewer: string | undefined;
    for (const p of PEOPLE) {
      if (isFullAdmin(p.id) || p.id === "p-claude") continue;
      setSessionPersonId(p.id);
      const ok = await servers.getServer(analysis.serverCode).then(
        () => true,
        () => false,
      );
      if (!ok) continue;
      try {
        strangersTo(p.id);
        resetApi();
        viewer = p.id;
        break;
      } catch {
        resetApi();
      }
    }
    expect(viewer).toBeDefined();
    const [who] = strangersTo(viewer!);
    state.serverAnalyses.find((a) => a.id === analysis.id)!.startedBy = who!;
    setSessionPersonId(viewer!);
    const detail = await servers.getServer(analysis.serverCode);
    expect(detail.manualAnalysis!.startedBy).toEqual({ id: "hidden-1", name: "" });
    expect(JSON.stringify(detail)).not.toContain(who!);
  });
});
