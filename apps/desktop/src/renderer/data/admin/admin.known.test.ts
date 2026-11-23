import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { strangersTo } from "../../test/strangers";
import { admin, resetApi, setLatency } from "../api";
import { grantInstancePermission } from "../viewer";
import { setSessionPersonId } from "../session";
import { state } from "../store";

// Registro, A11 r.1414, lotto 3 (Amministrazione: inviti e concessioni), nel
// prototipo: chi ha invitato, se chi guarda non lo conosce, è `hidden-<n>`
// e senza nome. La directory delle persone resta fuori dalla regola.

const LAURA = "p-laura";

beforeEach(() => {
  resetApi();
  setLatency(0);
});
afterEach(() => resetApi());

describe("inviti senza id né nome di chi non si conosce (r.1414)", () => {
  it("chi ha invitato: segnaposto, senza nome", async () => {
    const invite = state.invites[0]!;
    expect(invite).toBeDefined();
    const [who] = strangersTo(LAURA);
    invite.invitedById = who!;
    grantInstancePermission(LAURA, "users.invite");
    setSessionPersonId(LAURA);
    const out = (await admin.listInvites()).find((i) => i.id === invite.id);
    expect(out).toBeDefined();
    expect(out!.invitedById).toBe("hidden-1");
    expect(out!.invitedByName).toBe("");
    expect(JSON.stringify(out)).not.toContain(who!);
  });
});
