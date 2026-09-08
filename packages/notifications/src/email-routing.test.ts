import { describe, expect, it } from "vitest";
import {
  admit,
  containsWholeWord,
  matchRoutes,
  normalizeAddress,
  normalizeRouteValue,
  parseAddressList,
  type AdmissionConfig,
  type EmailForRouting,
  type EmailRoute,
} from "./email-routing.js";

const PROJECT_A = "11111111-1111-4111-8111-111111111111";
const PROJECT_B = "22222222-2222-4222-8222-222222222222";
const PROJECT_C = "33333333-3333-4333-8333-333333333333";

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
      scopeProjectIds: [],
    });
  });

  it("nessuna regola combacia: fuori perimetro (niente progetto, niente candidati, perimetro vuoto)", () => {
    const result = matchRoutes(message({ fromAddress: "a@altro.org" }), [
      route(PROJECT_A, "sender_domain", "acme.com"),
    ]);
    expect(result.inScope).toBe(false);
    expect(result.projectId).toBeNull();
    expect(result.candidateProjectIds).toEqual([]);
    expect(result.scopeProjectIds).toEqual([]);
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

  it("scopeProjectIds elenca TUTTI i progetti con almeno un match, non solo il vincitore", () => {
    // PROJECT_A soddisfa 2 regole, PROJECT_B e PROJECT_C una sola: il
    // vincitore resta PROJECT_A, ma il perimetro include anche B e C.
    const result = matchRoutes(
      message({ fromAddress: "cliente@acme.com", subject: "Preventivo portale urgente" }),
      [
        route(PROJECT_A, "sender_domain", "acme.com"),
        route(PROJECT_A, "keyword", "preventivo"),
        route(PROJECT_B, "keyword", "portale"),
        route(PROJECT_C, "keyword", "urgente"),
      ],
    );
    expect(result.inScope).toBe(true);
    expect(result.projectId).toBe(PROJECT_A);
    expect(result.candidateProjectIds).toEqual([]);
    expect(result.matchedRuleCount).toEqual({ [PROJECT_A]: 2, [PROJECT_B]: 1, [PROJECT_C]: 1 });
    // Ordinato per conteggio decrescente, poi per id crescente a parità.
    expect(result.scopeProjectIds).toEqual([PROJECT_A, PROJECT_B, PROJECT_C]);
  });

  it("parità al vertice: candidateProjectIds resta solo i pari merito in testa, scopeProjectIds include anche un terzo progetto minore", () => {
    // PROJECT_A e PROJECT_B soddisfano 2 regole ciascuno (parità al vertice),
    // PROJECT_C ne soddisfa una sola: entra in scopeProjectIds ma non in
    // candidateProjectIds, che resta il comportamento INVARIATO della parità.
    const result = matchRoutes(
      message({ fromAddress: "cliente@acme.com", subject: "Preventivo portale urgente" }),
      [
        route(PROJECT_A, "sender_domain", "acme.com"),
        route(PROJECT_A, "keyword", "preventivo"),
        route(PROJECT_B, "sender_address", "cliente@acme.com"),
        route(PROJECT_B, "keyword", "portale"),
        route(PROJECT_C, "keyword", "urgente"),
      ],
    );
    expect(result.inScope).toBe(true);
    expect(result.projectId).toBeNull();
    expect(result.candidateProjectIds).toEqual([PROJECT_A, PROJECT_B]);
    expect(result.matchedRuleCount).toEqual({ [PROJECT_A]: 2, [PROJECT_B]: 2, [PROJECT_C]: 1 });
    expect(result.scopeProjectIds).toEqual([PROJECT_A, PROJECT_B, PROJECT_C]);
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

  it("una keyword combacia su un confine di parola, non come una sottostringa qualunque", () => {
    const rule = [route(PROJECT_A, "keyword", "api")];
    // "api" è incollata dentro "capitale": non è la parola "api".
    expect(matchRoutes(message({ subject: "Bilancio del capitale sociale" }), rule).inScope).toBe(
      false,
    );
    // "api" è una parola a sé, delimitata da spazi/punteggiatura.
    expect(matchRoutes(message({ subject: "Questa API è lenta" }), rule).projectId).toBe(
      PROJECT_A,
    );
  });
});

describe("containsWholeWord", () => {
  it("non combacia se la parola è incollata a lettere accentate o Unicode", () => {
    // Confine ASCII (`\b`) tratterebbe l'inizio/fine di "città" come un
    // confine: qui non deve esserlo, perché "tà" non è "api".
    expect(containsWholeWord("città", "tà")).toBe(false);
    expect(containsWholeWord("l'apice", "api")).toBe(false);
  });

  it("combacia agli estremi della stringa e su punteggiatura", () => {
    expect(containsWholeWord("api", "api")).toBe(true);
    expect(containsWholeWord("chiamata: api, subito", "api")).toBe(true);
    expect(containsWholeWord("(api)", "api")).toBe(true);
  });

  it("una frase con spazi interni combacia solo sul confine dell'INTERA frase", () => {
    expect(containsWholeWord("il portale clienti è lento", "portale clienti")).toBe(true);
    // "clienti" da solo, senza "portale" davanti, non è la frase cercata.
    expect(containsWholeWord("nuovi clienti in arrivo", "portale clienti")).toBe(false);
  });

  it("una needle vuota non combacia mai (niente 'combacia con tutto')", () => {
    expect(containsWholeWord("qualunque cosa", "")).toBe(false);
  });
});

describe("admit", () => {
  function admissionConfig(overrides: Partial<AdmissionConfig> = {}): AdmissionConfig {
    return {
      admitWorkspaceDomains: true,
      workspaceDomains: [],
      denyLabels: ["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "SPAM"],
      denyAutomated: true,
      routes: [],
      ...overrides,
    };
  }

  /**
   * Il dominio della casella che RICEVE (Task 2, fase 6c): un valore FISSO
   * per i test che non lo mettono alla prova, scelto apposta DIVERSO da ogni
   * dominio che compare nei messaggi/regole di questo file — così non entra
   * mai per caso in `workspaceDomains` o fra i destinatari sotto test.
   */
  const RECEIVING_DOMAIN = "lanostracasella.example";

  it("mittente di un dominio Workspace registrato: ammesso workspace_domain", () => {
    const result = admit(
      message({ fromAddress: "Anna <anna@nostroworkspace.com>" }),
      admissionConfig({ workspaceDomains: ["nostroworkspace.com"] }),
      RECEIVING_DOMAIN,
    );
    expect(result).toEqual({ admitted: true, reason: "workspace_domain" });
  });

  it("dominio Workspace in copia (Cc): ammesso workspace_domain", () => {
    const result = admit(
      message({
        fromAddress: "cliente@esterno.org",
        toAddresses: ["x@esterno.org"],
        ccAddresses: ["Anna <anna@nostroworkspace.com>"],
      }),
      admissionConfig({ workspaceDomains: ["nostroworkspace.com"] }),
      RECEIVING_DOMAIN,
    );
    expect(result).toEqual({ admitted: true, reason: "workspace_domain" });
  });

  // --- Task 2 (8 set 2026), decisione del maintainer: l'esito non deve
  // dipendere da come il mittente ha compilato i campi. Un secondo dominio
  // di lavoro fra i destinatari ammette che sia in `to` o in `cc`,
  // ESCLUSO il dominio della casella che sta ricevendo — altrimenti OGNI
  // email diretta a quella casella ammetterebbe da sola, visto che la
  // casella è sempre fra i propri `to`. La tabella qui sotto è quella del
  // maintainer, verbatim (indirizzi reali dell'esempio compresi). ---

  it("il dominio Workspace in To (diretto, non in copia) ora ammette: l'esito non dipende dal campo usato", () => {
    const result = admit(
      message({
        fromAddress: "cliente@esterno.org",
        toAddresses: ["Anna <anna@nostroworkspace.com>"],
      }),
      admissionConfig({ workspaceDomains: ["nostroworkspace.com"] }),
      RECEIVING_DOMAIN,
    );
    expect(result).toEqual({ admitted: true, reason: "workspace_domain" });
  });

  it("cliente esterno → solo la casella ricevente (it@farmakom.it) fra i destinatari: NON ammessa (nessun SECONDO dominio di lavoro coinvolto)", () => {
    const result = admit(
      message({
        fromAddress: "cliente@esterno.org",
        toAddresses: ["it@farmakom.it"],
      }),
      admissionConfig({ workspaceDomains: ["farmakom.it"] }),
      "farmakom.it",
    );
    expect(result).toEqual({ admitted: false, reason: "no_match" });
  });

  it("cliente esterno → it@farmakom.it con a.locatelli@thecove.it IN COPIA: AMMESSA", () => {
    const result = admit(
      message({
        fromAddress: "cliente@esterno.org",
        toAddresses: ["it@farmakom.it"],
        ccAddresses: ["a.locatelli@thecove.it"],
      }),
      admissionConfig({ workspaceDomains: ["farmakom.it", "thecove.it"] }),
      "farmakom.it",
    );
    expect(result).toEqual({ admitted: true, reason: "workspace_domain" });
  });

  it("cliente esterno → entrambi fra i destinatari DIRETTI (to): AMMESSA — è il caso che prima falliva", () => {
    const result = admit(
      message({
        fromAddress: "cliente@esterno.org",
        toAddresses: ["it@farmakom.it", "a.locatelli@thecove.it"],
      }),
      admissionConfig({ workspaceDomains: ["farmakom.it", "thecove.it"] }),
      "farmakom.it",
    );
    expect(result).toEqual({ admitted: true, reason: "workspace_domain" });
  });

  it("due indirizzi ENTRAMBI dello STESSO dominio della casella ricevente: NON ammessa (nessun secondo dominio di lavoro coinvolto)", () => {
    const result = admit(
      message({
        fromAddress: "cliente@esterno.org",
        toAddresses: ["it@farmakom.it"],
        ccAddresses: ["altro@farmakom.it"],
      }),
      admissionConfig({ workspaceDomains: ["farmakom.it"] }),
      "farmakom.it",
    );
    expect(result).toEqual({ admitted: false, reason: "no_match" });
  });

  it("mittente di un dominio di lavoro: ammette comunque, indipendentemente dai destinatari (invariato)", () => {
    const result = admit(
      message({ fromAddress: "collega@farmakom.it", toAddresses: ["cliente@esterno.org"] }),
      admissionConfig({ workspaceDomains: ["farmakom.it"] }),
      "farmakom.it",
    );
    expect(result).toEqual({ admitted: true, reason: "workspace_domain" });
  });

  it("regola di progetto che combacia, senza che il dominio sia un dominio Workspace: ammesso project_rule", () => {
    const result = admit(
      message({ fromAddress: "cliente@acme.com" }),
      admissionConfig({
        workspaceDomains: ["nostroworkspace.com"],
        routes: [route(PROJECT_A, "sender_domain", "acme.com")],
      }),
      RECEIVING_DOMAIN,
    );
    expect(result).toEqual({ admitted: true, reason: "project_rule" });
  });

  // --- Task 1 (8 set 2026): le esclusioni valgono SOLO per l'ammissione per
  // dominio di lavoro. Una regola di progetto è una scelta deliberata su un
  // mittente preciso e ammette SEMPRE, esclusioni comprese. ---

  it("regola di progetto + CATEGORY_PROMOTIONS: AMMESSA (le esclusioni non limitano una regola di progetto)", () => {
    const result = admit(
      message({ fromAddress: "cliente@cliente.com", labels: ["CATEGORY_PROMOTIONS"] }),
      admissionConfig({
        // Un dominio Workspace DIVERSO da quello del mittente: qui ammette
        // solo la regola di progetto, non il dominio di lavoro.
        workspaceDomains: ["nostroworkspace.com"],
        routes: [route(PROJECT_A, "sender_domain", "cliente.com")],
      }),
      RECEIVING_DOMAIN,
    );
    expect(result).toEqual({ admitted: true, reason: "project_rule" });
  });

  it("regola di progetto + List-Unsubscribe: AMMESSA (le esclusioni non limitano una regola di progetto)", () => {
    const result = admit(
      message({
        fromAddress: "cliente@cliente.com",
        headers: { "list-unsubscribe": "<https://example.org/unsub>" },
      }),
      admissionConfig({
        workspaceDomains: ["nostroworkspace.com"],
        routes: [route(PROJECT_A, "sender_domain", "cliente.com")],
      }),
      RECEIVING_DOMAIN,
    );
    expect(result).toEqual({ admitted: true, reason: "project_rule" });
  });

  it("dominio di lavoro (SENZA regola di progetto che combaci) + CATEGORY_PROMOTIONS: rifiutata (le esclusioni valgono per l'ammissione larga)", () => {
    const result = admit(
      message({ fromAddress: "cliente@acme.com", labels: ["CATEGORY_PROMOTIONS"] }),
      admissionConfig({ workspaceDomains: ["acme.com"] }),
      RECEIVING_DOMAIN,
    );
    expect(result).toEqual({ admitted: false, reason: "denied_label" });
  });

  it("il confronto sulle etichette escluse non distingue le maiuscole", () => {
    const result = admit(
      message({ fromAddress: "cliente@acme.com", labels: ["category_promotions"] }),
      admissionConfig({ denyLabels: ["CATEGORY_PROMOTIONS"] }),
      RECEIVING_DOMAIN,
    );
    expect(result).toEqual({ admitted: false, reason: "denied_label" });
  });

  it("List-Unsubscribe presente (anche vuoto): rifiutato automated", () => {
    const result = admit(
      message({
        fromAddress: "anna@nostroworkspace.com",
        headers: { "list-unsubscribe": "" },
      }),
      admissionConfig({ workspaceDomains: ["nostroworkspace.com"] }),
      RECEIVING_DOMAIN,
    );
    expect(result).toEqual({ admitted: false, reason: "automated" });
  });

  it("List-Id presente: rifiutato automated", () => {
    const result = admit(
      message({
        fromAddress: "anna@nostroworkspace.com",
        headers: { "list-id": "<newsletter.acme.com>" },
      }),
      admissionConfig({ workspaceDomains: ["nostroworkspace.com"] }),
      RECEIVING_DOMAIN,
    );
    expect(result).toEqual({ admitted: false, reason: "automated" });
  });

  it("Precedence: bulk (case-insensitive): rifiutato automated", () => {
    const result = admit(
      message({
        fromAddress: "anna@nostroworkspace.com",
        headers: { precedence: "Bulk" },
      }),
      admissionConfig({ workspaceDomains: ["nostroworkspace.com"] }),
      RECEIVING_DOMAIN,
    );
    expect(result).toEqual({ admitted: false, reason: "automated" });
  });

  it.each(["bulk", "list", "junk"])("Precedence: %s rifiuta automated", (value) => {
    const result = admit(
      message({ fromAddress: "anna@nostroworkspace.com", headers: { precedence: value } }),
      admissionConfig({ workspaceDomains: ["nostroworkspace.com"] }),
      RECEIVING_DOMAIN,
    );
    expect(result).toEqual({ admitted: false, reason: "automated" });
  });

  it("Auto-Submitted: no NON rifiuta (deve passare oltre a quel controllo)", () => {
    const result = admit(
      message({
        fromAddress: "anna@nostroworkspace.com",
        headers: { "auto-submitted": "no" },
      }),
      admissionConfig({ workspaceDomains: ["nostroworkspace.com"] }),
      RECEIVING_DOMAIN,
    );
    expect(result).toEqual({ admitted: true, reason: "workspace_domain" });
  });

  it("Auto-Submitted diverso da no rifiuta automated", () => {
    const result = admit(
      message({
        fromAddress: "anna@nostroworkspace.com",
        headers: { "auto-submitted": "auto-generated" },
      }),
      admissionConfig({ workspaceDomains: ["nostroworkspace.com"] }),
      RECEIVING_DOMAIN,
    );
    expect(result).toEqual({ admitted: false, reason: "automated" });
  });

  it("nessun header automatico presente: non rifiuta per quel motivo", () => {
    const result = admit(
      message({ fromAddress: "anna@nostroworkspace.com", headers: {} }),
      admissionConfig({ workspaceDomains: ["nostroworkspace.com"] }),
      RECEIVING_DOMAIN,
    );
    expect(result).toEqual({ admitted: true, reason: "workspace_domain" });
  });

  it("headers assente (chiamante che non lo passa): denyAutomated acceso non rifiuta", () => {
    const result = admit(
      message({ fromAddress: "anna@nostroworkspace.com" }),
      admissionConfig({ workspaceDomains: ["nostroworkspace.com"] }),
      RECEIVING_DOMAIN,
    );
    expect(result).toEqual({ admitted: true, reason: "workspace_domain" });
  });

  it("denyAutomated spento: gli header automatici non rifiutano più", () => {
    const result = admit(
      message({
        fromAddress: "anna@nostroworkspace.com",
        headers: { "list-unsubscribe": "<https://example.org>" },
      }),
      admissionConfig({ workspaceDomains: ["nostroworkspace.com"], denyAutomated: false }),
      RECEIVING_DOMAIN,
    );
    expect(result).toEqual({ admitted: true, reason: "workspace_domain" });
  });

  it("nessun dominio Workspace, nessuna regola: rifiutato no_match", () => {
    const result = admit(message({ fromAddress: "chiunque@altro.org" }), admissionConfig(), RECEIVING_DOMAIN);
    expect(result).toEqual({ admitted: false, reason: "no_match" });
  });

  it("interruttore admitWorkspaceDomains spento: coincide con inScope di matchRoutes sullo stesso messaggio/regole", () => {
    const routes = [route(PROJECT_A, "sender_domain", "acme.com")];
    const config = admissionConfig({
      admitWorkspaceDomains: false,
      workspaceDomains: ["nostroworkspace.com"],
      routes,
    });

    // Un dominio Workspace da solo, senza regola di progetto, NON ammette più
    // con l'interruttore spento: identico a inScope di oggi.
    const workspaceOnly = message({ fromAddress: "anna@nostroworkspace.com" });
    expect(admit(workspaceOnly, config, RECEIVING_DOMAIN).admitted).toBe(matchRoutes(workspaceOnly, routes).inScope);
    expect(admit(workspaceOnly, config, RECEIVING_DOMAIN)).toEqual({ admitted: false, reason: "no_match" });

    // Una regola di progetto continua ad ammettere, identica a inScope.
    const ruleMatch = message({ fromAddress: "cliente@acme.com" });
    expect(admit(ruleMatch, config, RECEIVING_DOMAIN).admitted).toBe(matchRoutes(ruleMatch, routes).inScope);
    expect(admit(ruleMatch, config, RECEIVING_DOMAIN)).toEqual({ admitted: true, reason: "project_rule" });

    // Nessuna regola, nessun match: entrambi fuori.
    const noMatch = message({ fromAddress: "chiunque@altro.org" });
    expect(admit(noMatch, config, RECEIVING_DOMAIN).admitted).toBe(matchRoutes(noMatch, routes).inScope);

    // Rinforzo (Task 1): i tre messaggi sopra sono tutti "puliti" — nessuna
    // etichetta esclusa, nessun header automatico — quindi non esercitano
    // MAI il codice delle esclusioni, e l'equivalenza con `inScope` sarebbe
    // vera anche con un `admit` scritto male. Qui invece sì.

    // Una regola di progetto combacia ANCHE con un'etichetta esclusa e un
    // header automatico: ammette lo stesso (Task 1), esattamente come
    // `inScope` di `matchRoutes` — che le esclusioni non le conosce affatto.
    const ruleMatchWithExclusions = message({
      fromAddress: "cliente@acme.com",
      labels: ["CATEGORY_PROMOTIONS"],
      headers: { "list-unsubscribe": "<https://example.org/unsub>" },
    });
    expect(admit(ruleMatchWithExclusions, config, RECEIVING_DOMAIN).admitted).toBe(
      matchRoutes(ruleMatchWithExclusions, routes).inScope,
    );
    expect(admit(ruleMatchWithExclusions, config, RECEIVING_DOMAIN)).toEqual({
      admitted: true,
      reason: "project_rule",
    });

    // Nessuna regola di progetto E un'etichetta esclusa: `admitted` resta
    // `false` come `inScope`, ma stavolta il motivo passa DAVVERO dal ramo
    // delle esclusioni (`denied_label`), non solo da `no_match` per
    // l'assenza di qualunque match.
    const noMatchWithDenyLabel = message({
      fromAddress: "chiunque@altro.org",
      labels: ["CATEGORY_PROMOTIONS"],
    });
    expect(admit(noMatchWithDenyLabel, config, RECEIVING_DOMAIN).admitted).toBe(
      matchRoutes(noMatchWithDenyLabel, routes).inScope,
    );
    expect(admit(noMatchWithDenyLabel, config, RECEIVING_DOMAIN)).toEqual({
      admitted: false,
      reason: "denied_label",
    });
  });

  // --- Composizione Task 1 + Task 2: verifica che le due fix non collidano.
  // Un secondo dominio di lavoro fra i destinatari ammetterebbe (Task 2), ma
  // qui NESSUNA regola di progetto combacia — quindi il messaggio passa dal
  // ramo "dominio di lavoro", dove le esclusioni (Task 1) restano attive: la
  // scorciatoia di Task 1 ("le esclusioni non si applicano") vale SOLO per
  // project_rule, mai per workspace_domain, anche quando il secondo dominio
  // arriva da un destinatario invece che dal mittente. ---
  it("un secondo dominio di lavoro fra i destinatari + un'etichetta esclusa: RIFIUTATA (le esclusioni si applicano al ramo dominio di lavoro)", () => {
    const result = admit(
      message({
        fromAddress: "cliente@esterno.org",
        toAddresses: ["it@farmakom.it", "a.locatelli@thecove.it"],
        labels: ["CATEGORY_PROMOTIONS"],
      }),
      admissionConfig({ workspaceDomains: ["farmakom.it", "thecove.it"] }),
      "farmakom.it",
    );
    expect(result).toEqual({ admitted: false, reason: "denied_label" });
  });
});
