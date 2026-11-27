import { describe, expect, it } from "vitest";

import { REDACTED_FIELDS, redactPaths, redactSecrets } from "./redact.js";

/**
 * Un segreto che viaggia DENTRO una lettura ordinaria (la chiave d'ingestione
 * di un progetto, il token di un invito) non arriva al modello: lo si
 * nasconde prima di mostrare la risposta (lotto 6, decisione di 46 e del
 * maintainer).
 */
describe("redactSecrets", () => {
  it("nasconde i campi segreti a ogni profondità, e lascia il resto com'è", () => {
    const input = {
      id: "p1",
      name: "Acme",
      ingestionKey: "ik_123",
      widgets: [{ key: "pubblica", token: "t_1" }],
      nested: { deep: { webhookSecret: "whsec", colorToken: "blue" } },
      list: [1, "due", null],
    };
    expect(redactSecrets(input)).toEqual({
      id: "p1",
      name: "Acme",
      ingestionKey: "[nascosto: si vede dall'app]",
      widgets: [{ key: "pubblica", token: "[nascosto: si vede dall'app]" }],
      nested: { deep: { webhookSecret: "[nascosto: si vede dall'app]", colorToken: "blue" } },
      list: [1, "due", null],
    });
    // L'originale non cambia.
    expect(input.ingestionKey).toBe("ik_123");
  });

  it("un segreto vuoto o null resta com'è (non c'è niente da nascondere)", () => {
    expect(redactSecrets({ token: null, secret: "" })).toEqual({ token: null, secret: "" });
  });

  it("l'elenco dei campi nascosti", () => {
    expect([...REDACTED_FIELDS].sort()).toEqual(
      ["apiKey", "clientSecret", "ingestionKey", "password", "s3AccessKey", "s3SecretKey", "secret", "slackBotToken", "slackSigningSecret", "token", "webhookSecret", "webhookUrl"].sort(),
    );
  });
});

describe("redactPaths (revisione del lotto 6, I2)", () => {
  it("nasconde i percorsi dichiarati dalla voce del catalogo, e solo quelli", () => {
    const data = [{ id: "w1", url: "https://hooks.slack.com/services/T/B/x" }, { id: "w2", url: null }];
    expect(redactPaths(data, ["[].url"])).toEqual([{ id: "w1", url: "[nascosto: si vede dall'app]" }, { id: "w2", url: null }]);
    expect(redactPaths({ url: "https://discord.com/api/webhooks/1/x", name: "n" }, ["url"])).toEqual({ url: "[nascosto: si vede dall'app]", name: "n" });
    expect(redactPaths({ items: [{ url: "u" }] }, ["items.[].url"])).toEqual({ items: [{ url: "[nascosto: si vede dall'app]" }] });
    // Un percorso che non c'è non cambia niente.
    expect(redactPaths({ a: 1 }, ["[].url", "b.c"])).toEqual({ a: 1 });
  });
});
