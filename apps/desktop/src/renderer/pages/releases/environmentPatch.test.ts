import { describe, expect, it } from "vitest";
import type { EnvironmentInput } from "../../data/releases";
import { environmentPatch } from "./environmentPatch";

// Review F4a, I2: modificare un ambiente manda i collegamenti ai server SOLO
// se sono cambiati. Un nome nuovo non riscrive i collegamenti (che il server
// rifarebbe da capo) e non si ferma su un server che chi scrive non vede.

const before: EnvironmentInput = {
  name: "Production",
  kind: "production",
  url: null,
  servers: [
    { repositoryId: null, serverCode: "SRV-3" },
    { repositoryId: "repo-admin", serverCode: "SRV-4" },
  ],
};

describe("la modifica di un ambiente", () => {
  it("solo il nome: il nome, niente server né tipo", () => {
    expect(environmentPatch(before, { ...before, name: "Prod" })).toEqual({ name: "Prod" });
  });

  it("gli stessi server in un altro ordine o con un'altra grafia: nessun collegamento", () => {
    const same = {
      ...before,
      servers: [
        { repositoryId: "repo-admin", serverCode: "srv-4 " },
        { repositoryId: null, serverCode: "SRV-3" },
      ],
    };
    expect(environmentPatch(before, same)).toEqual({});
  });

  it("un collegamento cambiato: tutti i server dell'ambiente", () => {
    const after = { ...before, servers: [{ repositoryId: null, serverCode: "SRV-3" }] };
    expect(environmentPatch(before, after)).toEqual({ servers: after.servers });
  });

  it("indirizzo e tipo solo se cambiati", () => {
    expect(environmentPatch(before, { ...before, url: "https://x.test", kind: "staging" })).toEqual(
      {
        url: "https://x.test",
        kind: "staging",
      },
    );
  });
});
