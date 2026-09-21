import { describe, expect, it } from "vitest";
import { closedReason, closedReasonProjectId } from "./closed-reason.js";

describe("closedReason", () => {
  it("ogni esito mappato dà la sua chiave, e solo `reassigned_to` chiede il progetto", () => {
    // Il VALORE delle chiavi, non «è non nullo»: un'etichetta sbagliata su una
    // card chiusa è un'informazione errata, non una mancante — ed è il difetto
    // che questo batch esiste per togliere.
    expect(closedReason({ type: "reassigned_to", projectId: "p1" })).toEqual({
      key: "closedReason.reassignedTo",
      needsProject: true,
    });
    expect(closedReason({ type: "reassign_failed" })?.key).toBe("closedReason.reassignFailed");
    expect(closedReason({ type: "reassign_no_signal" })?.key).toBe("closedReason.reassignNoSignal");
    expect(closedReason({ type: "reassign_target_gone" })?.key).toBe(
      "closedReason.reassignTargetGone",
    );
    expect(closedReason({ type: "superseded_in_thread" })?.key).toBe(
      "closedReason.supersededInThread",
    );
    expect(closedReason({ type: "declined" })?.key).toBe("closedReason.declined");
    expect(closedReason({ type: "triage_dismissed" })?.key).toBe("closedReason.triageDismissed");

    // Solo la riattribuzione porta un progetto da nominare: se un domani ne
    // arrivasse un secondo, questa riga lo fa notare invece di lasciarlo
    // passare.
    const withProject = Object.keys({
      reassigned_to: 1,
      reassign_failed: 1,
      reassign_no_signal: 1,
      reassign_target_gone: 1,
      superseded_in_thread: 1,
      declined: 1,
      triage_dismissed: 1,
    }).filter((type) => closedReason({ type })?.needsProject === true);
    expect(withProject).toEqual(["reassigned_to"]);
  });

  it("⚠️ un esito SCRITTO A MANO non rompe niente: `null`, e chi legge mostra lo stato nudo", () => {
    // NON è un caso inventato. In produzione esistono righe con questi due
    // valori: nessun codice li produce — li ha scritti un maintainer chiudendo
    // a mano l'arretrato del 17 settembre. Una mappa esaustiva (un `Record`
    // tipato, uno `switch` senza default) andrebbe in crash sul dato vero al
    // primo caricamento della pagina, e sarebbe un guasto peggiore del
    // problema che questo batch risolve.
    expect(closedReason({ type: "bulk_closed_automated" })).toBeNull();
    expect(closedReason({ type: "bulk_closed_stale_routing" })).toBeNull();
    // E lo stesso per un esito di una versione FUTURA, che è lo stesso caso
    // visto dall'altro capo del tempo.
    expect(closedReason({ type: "qualcosa_che_non_esiste_ancora" })).toBeNull();
  });

  it("esiti assenti o malformati: `null`, mai un'eccezione", () => {
    // `outcome` è un jsonb senza CHECK sulla forma: può mancare, essere `null`
    // (il caso NORMALE — chiusa per mancanza di segnale), o portare un `type`
    // che non è una stringa.
    expect(closedReason(null)).toBeNull();
    expect(closedReason(undefined)).toBeNull();
    expect(closedReason({})).toBeNull();
    expect(closedReason({ type: 42 })).toBeNull();
    expect(closedReason({ type: "" })).toBeNull();
  });

  it("gli esiti delle card ANDATE A BUON FINE non sono mappati, ed è deliberato", () => {
    // Per quelle «Eseguita» dice già ciò che serve: un perché in più sarebbe
    // rumore. Se un domani qualcuno li mappasse, questo test glielo fa notare
    // prima che la pagina si riempia di etichette.
    expect(closedReason({ type: "backlog_item", jobId: "j1" })).toBeNull();
    expect(closedReason({ type: "milestone", milestoneId: "m1" })).toBeNull();
    expect(closedReason({ type: "commented", ticketId: "t1" })).toBeNull();
    expect(closedReason({ type: "reminder" })).toBeNull();
  });
});

describe("closedReasonProjectId", () => {
  it("torna l'id quando c'è, e `null` in ogni altro caso", () => {
    expect(closedReasonProjectId({ type: "reassigned_to", projectId: "p1" })).toBe("p1");
    // Una riattribuzione il cui esito NON porta il progetto: succede su una
    // riga scritta a mano, o da una versione precedente. Chi rende deve
    // ricadere sull'etichetta senza nome.
    expect(closedReasonProjectId({ type: "reassigned_to" })).toBeNull();
    expect(closedReasonProjectId({ type: "reassigned_to", projectId: 7 })).toBeNull();
    expect(closedReasonProjectId(null)).toBeNull();
    expect(closedReasonProjectId(undefined)).toBeNull();
  });
});
