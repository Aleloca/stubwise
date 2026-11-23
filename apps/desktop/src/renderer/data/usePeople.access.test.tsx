import { act, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { strangersTo } from "../test/strangers";
import { renderWithData } from "../test/renderWithData";
import { writeAccess } from "./access/index";
import { resetApi, setLatency } from "./api";
import { usePeople } from "./queries";

// Revisione del lotto 2 (minor, r.1414): l'elenco delle persone dipende da chi
// guarda conosce, che cambia con ogni scrittura degli accessi (un membro
// entrato in un progetto). La cache di `usePeople` si rilegge allora da sola.

beforeEach(() => {
  resetApi();
  setLatency(0);
});
afterEach(() => resetApi());

function People() {
  const ids = usePeople().data?.map((p) => p.id) ?? [];
  return <ul data-people={ids.join(",")} />;
}

describe("usePeople e le scritture degli accessi (r.1414)", () => {
  it("uno sconosciuto che entra in un progetto visibile compare senza ricaricare", async () => {
    const [who] = strangersTo("p-laura");
    renderWithData(<People />, { personId: "p-laura" });
    const list = () => document.querySelector("[data-people]")!.getAttribute("data-people")!;
    await waitFor(() => expect(list()).toContain("p-laura"));
    expect(list()).not.toContain(who!);
    act(() =>
      writeAccess((s) => {
        const like = s.memberships.find((m) => m.projectId === "prj-acq")!;
        s.memberships.push({ ...like, personId: who! });
      }),
    );
    await waitFor(() => expect(list()).toContain(who!));
  });
});
