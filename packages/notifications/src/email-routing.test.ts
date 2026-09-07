import { describe, expect, it } from "vitest";
import {
  matchRoutes,
  normalizeAddress,
  normalizeRouteValue,
  parseAddressList,
  type EmailForRouting,
  type EmailRoute,
} from "./email-routing.js";

const PROJECT_A = "11111111-1111-4111-8111-111111111111";
const PROJECT_B = "22222222-2222-4222-8222-222222222222";

/** Un messaggio "neutro": nessun campo che possa combaciare per caso. */
function message(overrides: Partial<EmailForRouting> = {}): EmailForRouting {
  return {
    fromAddress: "nobody@example.org",
    toAddresses: [],
    labels: [],
    subject: "",
    text: "",
    ...overrides,
  };
}

function route(projectId: string, kind: EmailRoute["kind"], value: string): EmailRoute {
  return { projectId, kind, value };
}

describe("normalizeAddress", () => {
  it("estrae l'indirizzo da un header con nome visualizzato e lo mette in minuscolo", () => {
    expect(normalizeAddress("Mario Rossi <Mario.Rossi@Acme.COM>")).toBe("mario.rossi@acme.com");
    expect(normalizeAddress("  BARE@Acme.com ")).toBe("bare@acme.com");
    expect(normalizeAddress('"Rossi, Mario" <m@acme.com>')).toBe("m@acme.com");
  });

  it("restituisce stringa vuota per un valore che non contiene un indirizzo", () => {
    expect(normalizeAddress("")).toBe("");
    expect(normalizeAddress("   ")).toBe("");
  });
});

describe("parseAddressList", () => {
  it("spezza un header To/Cc rispettando le virgole dentro i nomi fra virgolette", () => {
    expect(parseAddressList('"Rossi, Mario" <m@acme.com>, Anna <a@acme.com>')).toEqual([
      "m@acme.com",
      "a@acme.com",
    ]);
  });

  it("ignora le voci vuote e i doppioni", () => {
    expect(parseAddressList("a@acme.com, , A@ACME.COM")).toEqual(["a@acme.com"]);
  });

  it("su un header assente o vuoto restituisce una lista vuota", () => {
    expect(parseAddressList(undefined)).toEqual([]);
    expect(parseAddressList("")).toEqual([]);
  });
});

describe("normalizeRouteValue", () => {
  it("mette in minuscolo e toglie gli spazi ai bordi", () => {
    expect(normalizeRouteValue("keyword", "  Preventivo Portale ")).toBe("preventivo portale");
    expect(normalizeRouteValue("gmail_label", " Label_42 ")).toBe("label_42");
  });

  it("di un indirizzo mittente tiene solo l'indirizzo", () => {
    expect(normalizeRouteValue("sender_address", "Mario <Mario@Acme.com>")).toBe("mario@acme.com");
  });

  it("di un dominio toglie una eventuale chiocciola iniziale", () => {
    expect(normalizeRouteValue("sender_domain", "@Acme.com")).toBe("acme.com");
  });
});

describe("matchRoutes", () => {
  it("nessuna regola configurata: fuori perimetro", () => {
    const result = matchRoutes(message({ fromAddress: "a@acme.com" }), []);
    expect(result).toEqual({
      inScope: false,
      projectId: null,
      candidateProjectIds: [],
      matchedRuleCount: {},
    });
  });

  it("nessuna regola combacia: fuori perimetro (niente progetto, niente candidati)", () => {
    const result = matchRoutes(message({ fromAddress: "a@altro.org" }), [
      route(PROJECT_A, "sender_domain", "acme.com"),
    ]);
    expect(result.inScope).toBe(false);
    expect(result.projectId).toBeNull();
    expect(result.candidateProjectIds).toEqual([]);
  });

  it("dominio del mittente (From)", () => {
    const result = matchRoutes(message({ fromAddress: "Mario <Mario@Acme.com>" }), [
      route(PROJECT_A, "sender_domain", "acme.com"),
    ]);
    expect(result.projectId).toBe(PROJECT_A);
    expect(result.inScope).toBe(true);
    expect(result.matchedRuleCount).toEqual({ [PROJECT_A]: 1 });
  });

  it("dominio su un destinatario (To)", () => {
    const result = matchRoutes(
      message({ fromAddress: "x@altro.org", toAddresses: ["ufficio@ACME.com"] }),
      [route(PROJECT_A, "sender_domain", "acme.com")],
    );
    expect(result.projectId).toBe(PROJECT_A);
  });

  it("dominio su un destinatario in copia (Cc)", () => {
    const result = matchRoutes(
      message({
        fromAddress: "x@altro.org",
        toAddresses: ["y@altro.org"],
        ccAddresses: ["Anna <anna@acme.com>"],
      }),
      [route(PROJECT_A, "sender_domain", "acme.com")],
    );
    expect(result.projectId).toBe(PROJECT_A);
  });

  it("il dominio è quello dopo la chiocciola, non un pezzo di stringa qualunque", () => {
    const result = matchRoutes(message({ fromAddress: "acme.com.bot@spam.org" }), [
      route(PROJECT_A, "sender_domain", "acme.com"),
    ]);
    expect(result.inScope).toBe(false);
  });

  it("un sottodominio NON combacia col dominio nudo", () => {
    const result = matchRoutes(message({ fromAddress: "a@mail.acme.com" }), [
      route(PROJECT_A, "sender_domain", "acme.com"),
    ]);
    expect(result.inScope).toBe(false);
  });

  it("indirizzo esatto su From, To e Cc", () => {
    const rules = [route(PROJECT_A, "sender_address", "cliente@acme.com")];
    expect(matchRoutes(message({ fromAddress: "Cliente@Acme.com" }), rules).projectId).toBe(
      PROJECT_A,
    );
    expect(
      matchRoutes(message({ toAddresses: ["cliente@acme.com"] }), rules).projectId,
    ).toBe(PROJECT_A);
    expect(
      matchRoutes(message({ ccAddresses: ["cliente@acme.com"] }), rules).projectId,
    ).toBe(PROJECT_A);
    // Stesso dominio ma altra casella: l'indirizzo esatto non combacia.
    expect(matchRoutes(message({ fromAddress: "altro@acme.com" }), rules).inScope).toBe(false);
  });

  it("etichetta Gmail, confrontata senza distinzione di maiuscole", () => {
    const result = matchRoutes(message({ labels: ["INBOX", "Label_42"] }), [
      route(PROJECT_A, "gmail_label", "label_42"),
    ]);
    expect(result.projectId).toBe(PROJECT_A);
  });

  it("parola chiave nell'oggetto", () => {
    const result = matchRoutes(message({ subject: "Re: Preventivo ACME per il portale" }), [
      route(PROJECT_A, "keyword", "preventivo"),
    ]);
    expect(result.projectId).toBe(PROJECT_A);
  });

  it("parola chiave nel testo del corpo", () => {
    const result = matchRoutes(
      message({ subject: "Aggiornamento", text: "Ci serve il PORTALE clienti entro venerdì." }),
      [route(PROJECT_A, "keyword", "portale clienti")],
    );
    expect(result.projectId).toBe(PROJECT_A);
  });

  it("senza il testo del corpo la keyword cerca nel solo oggetto (pre-filtro sui metadati)", () => {
    const rules = [route(PROJECT_A, "keyword", "portale")];
    // `text` omesso: è il pre-filtro del poller, che decide se scaricare il
    // corpo. Qui l'oggetto non basta → fuori perimetro.
    expect(matchRoutes(message({ subject: "Aggiornamento" }), rules).inScope).toBe(false);
    // Lo stesso messaggio col corpo scaricato entra invece in perimetro.
    expect(
      matchRoutes(message({ subject: "Aggiornamento", text: "il portale" }), rules).projectId,
    ).toBe(PROJECT_A);
  });

  it("due regole soddisfatte battono una sola: vince il progetto con più regole", () => {
    const result = matchRoutes(
      message({ fromAddress: "cliente@acme.com", subject: "Preventivo portale" }),
      [
        route(PROJECT_A, "sender_domain", "acme.com"),
        route(PROJECT_A, "keyword", "preventivo"),
        route(PROJECT_B, "keyword", "portale"),
      ],
    );
    expect(result.projectId).toBe(PROJECT_A);
    expect(result.candidateProjectIds).toEqual([]);
    expect(result.matchedRuleCount).toEqual({ [PROJECT_A]: 2, [PROJECT_B]: 1 });
  });

  it("parità: nessun progetto risolto, ma i candidati sono registrati", () => {
    const result = matchRoutes(
      message({ fromAddress: "cliente@acme.com", subject: "Preventivo portale" }),
      [
        route(PROJECT_A, "keyword", "preventivo"),
        route(PROJECT_B, "keyword", "portale"),
      ],
    );
    expect(result.inScope).toBe(true);
    expect(result.projectId).toBeNull();
    expect(result.candidateProjectIds).toEqual([PROJECT_A, PROJECT_B].sort());
    expect(result.matchedRuleCount).toEqual({ [PROJECT_A]: 1, [PROJECT_B]: 1 });
  });

  it("i candidati in parità sono ordinati in modo stabile, qualunque sia l'ordine delle regole", () => {
    const msg = message({ subject: "preventivo portale" });
    const first = matchRoutes(msg, [
      route(PROJECT_B, "keyword", "portale"),
      route(PROJECT_A, "keyword", "preventivo"),
    ]);
    const second = matchRoutes(msg, [
      route(PROJECT_A, "keyword", "preventivo"),
      route(PROJECT_B, "keyword", "portale"),
    ]);
    expect(first.candidateProjectIds).toEqual(second.candidateProjectIds);
  });

  it("la stessa regola ripetuta conta UNA volta sola", () => {
    const result = matchRoutes(message({ fromAddress: "a@acme.com" }), [
      route(PROJECT_A, "sender_domain", "acme.com"),
      route(PROJECT_A, "sender_domain", "ACME.com"),
    ]);
    expect(result.matchedRuleCount).toEqual({ [PROJECT_A]: 1 });
  });

  it("una regola con valore vuoto non fa entrare tutto in perimetro", () => {
    const result = matchRoutes(message({ subject: "qualunque cosa" }), [
      route(PROJECT_A, "keyword", "   "),
    ]);
    expect(result.inScope).toBe(false);
  });

  it("il valore della regola è normalizzato anche se arriva con maiuscole dal chiamante", () => {
    const result = matchRoutes(message({ subject: "Il PREVENTIVO" }), [
      route(PROJECT_A, "keyword", "Preventivo"),
    ]);
    expect(result.projectId).toBe(PROJECT_A);
  });
});
