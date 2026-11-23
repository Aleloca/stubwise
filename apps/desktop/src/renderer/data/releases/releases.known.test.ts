import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { strangersTo } from "../../test/strangers";
import { releases, resetApi, setLatency } from "../api";
import { setSessionPersonId } from "../session";
import { state, visibleProjectIds } from "../store";
import { openPrViews } from "./visibility";

// Registro, A11 r.1414, lotto 3 (rilasci), nel prototipo: l'autore di una
// PR collegato a una persona che chi guarda non conosce, chi l'ha messa in
// «Solo analisi», chi ha mergiato un rilascio: `hidden-<n>`; e il nome git
// dell'autore, che dice la stessa persona, non esce. Una PR di un'identità
// git non collegata resta col suo nome.

const LAURA = "p-laura";

beforeEach(() => {
  resetApi();
  setLatency(0);
});
afterEach(() => resetApi());

describe("i rilasci senza id di chi non si conosce (r.1414)", () => {
  it("una PR: l'autore e chi l'ha messa in «Solo analisi», e il nome git non esce", () => {
    const visible = visibleProjectIds(LAURA);
    const pr = state.openPrs.find((p) => visible.has(p.projectId) && p.state === "open")!;
    expect(pr).toBeDefined();
    const [who] = strangersTo(LAURA);
    pr.authorId = who!;
    pr.authorName = "kevin.secret";
    pr.analysisOnly = { byId: who!, at: "2026-11-20T10:00:00Z" };
    const out = openPrViews(LAURA, pr.projectId).find((p) => p.id === pr.id)!;
    expect(out.authorId).toBe("hidden-1");
    expect(out.analysisOnly!.byId).toBe("hidden-1");
    expect(JSON.stringify(out)).not.toContain(who!);
    expect(JSON.stringify(out)).not.toContain("kevin.secret");
  });

  it("chi ha mergiato un rilascio: segnaposto", async () => {
    const visible = visibleProjectIds(LAURA);
    const r = state.releases.find((x) => visible.has(x.projectId))!;
    expect(r).toBeDefined();
    const [who] = strangersTo(LAURA);
    r.mergedById = who!;
    setSessionPersonId(LAURA);
    const out = (await releases.getRelease(r.code))!;
    expect(out.mergedById).toBe("hidden-1");
    expect(JSON.stringify(out)).not.toContain(who!);
  });
});
