import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { strangersTo } from "../test/strangers";
import {
  getRequest,
  getSavedFilter,
  listRequests,
  listSavedFilters,
  resetApi,
  setLatency,
} from "./api";
import { setSessionPersonId } from "./session";
import { state, visibleProjectIds } from "./store";

// Registro, A11 r.1414, lotto 3 (richieste e filtri), nel prototipo: chi
// guarda non riceve l'id di chi non conosce. Chi ha chiesto una richiesta, e
// il titolare di un filtro pubblico, diventano `hidden-<n>`; il proprio id
// resta. (I criteri per persona dei filtri: scelta chiesta a 46.)

const LAURA = "p-laura";

beforeEach(() => {
  resetApi();
  setLatency(0);
});
afterEach(() => resetApi());

describe("richieste e filtri senza id di chi non si conosce (r.1414)", () => {
  it("chi ha chiesto: segnaposto, in elenco e nel dettaglio", async () => {
    const visible = visibleProjectIds(LAURA);
    const request = state.requests.find((r) => visible.has(r.projectId))!;
    const [who] = strangersTo(LAURA);
    request.requesterIds = [LAURA, who!];
    setSessionPersonId(LAURA);
    const listed = (await listRequests(request.projectId)).find((r) => r.id === request.id)!;
    expect(listed.requesterIds).toEqual([LAURA, "hidden-1"]);
    expect(JSON.stringify(await getRequest(request.id))).not.toContain(who!);
  });

  it("il titolare di un filtro pubblico: segnaposto", async () => {
    const filter = state.filters.find((f) => f.visibility === "public")!;
    expect(filter).toBeDefined();
    const [who] = strangersTo(LAURA);
    filter.ownerId = who!;
    setSessionPersonId(LAURA);
    const listed = (await listSavedFilters()).find((f) => f.id === filter.id)!;
    expect(listed.ownerId).toBe("hidden-1");
    expect(JSON.stringify(await getSavedFilter(filter.id))).not.toContain(who!);
  });
});
