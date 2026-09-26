import { describe, expect, it } from "vitest";
import {
  closedReason,
  closedReasonProjectId,
  OUTCOMES_ON_OTHER_TABLES,
  PROPOSAL_OUTCOME_TYPES,
  SUCCESSFUL_PROPOSAL_OUTCOMES,
} from "./closed-reason.js";

describe("closedReason", () => {
  it("ogni esito mappato dà la sua chiave, e solo `reassigned_to` chiede il progetto", () => {
    // Il VALORE delle chiavi, non «è non nullo»: un'etichetta sbagliata su una
    // card chiusa è un'informazione errata, non una mancante — ed è il difetto
    // che questo batch esiste per togliere.
    expect(closedReason({ type: "reassigned_to", projectId: "p1" })).toEqual({
      key: "closedReason.reassignedTo",
      needsProject: true,
      failed: false,
    });
    expect(closedReason({ type: "reassign_failed" })?.key).toBe("closedReason.reassignFailed");
    expect(closedReason({ type: "reassign_no_signal" })?.key).toBe("closedReason.reassignNoSignal");
    expect(closedReason({ type: "reassign_target_gone" })?.key).toBe(
      "closedReason.reassignTargetGone",
    );
    // ⚠️ `superseded_by_message`, non `superseded_in_thread`: il primo si
    // scrive su `email_proposals` (la tabella che il chiamante legge), il
    // secondo sul messaggio PADRE. Era l'errore della prima stesura.
    expect(closedReason({ type: "superseded_by_message" })?.key).toBe(
      "closedReason.supersededByMessage",
    );

    // Solo la riattribuzione porta un progetto da nominare: se un domani ne
    // arrivasse un secondo, questa riga lo fa notare invece di lasciarlo
    // passare.
    const withProject = PROPOSAL_OUTCOME_TYPES.filter(
      (type) => closedReason({ type })?.needsProject === true,
    );
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
    expect(closedReason({ type: "exists" })).toBeNull();
    expect(closedReason({ type: "commented", ticketId: "t1" })).toBeNull();
    expect(closedReason({ type: "reminder" })).toBeNull();
    // Più azioni confermate insieme: registrato come esito riuscito, non ignoto.
    expect(SUCCESSFUL_PROPOSAL_OUTCOMES).toContain("multiple");
    expect(closedReason({ type: "multiple", results: [{ type: "backlog_item" }] })).toBeNull();
  });
});

/**
 * ⚠️ LA RADICE DEL DIFETTO DEL 21 SET, e il solo test che lo avrebbe preso.
 *
 * La prima stesura mappava `superseded_in_thread`, `triage_dismissed` e
 * `declined` — tutti e tre scritti su tabelle DIVERSE da `email_proposals`,
 * cioè irraggiungibili dall'unico chiamante — mentre il caso più frequente,
 * `superseded_by_message`, non era mappato. I test c'erano e passavano tutti:
 * verificavano la FORMA della mappa (ogni chiave dà la sua etichetta), non la
 * sua CORRISPONDENZA con ciò che finisce davvero su quella tabella.
 *
 * È la stessa famiglia del test che passava perché un helper generava id
 * casuali (CLAUDE.md, mutation testing, punto (c)): attraversava il codice
 * senza metterlo nelle condizioni di sbagliare.
 */
describe("la mappa e la tabella che l'unico chiamante legge", () => {
  it("nessuna chiave spiegata è IRRAGGIUNGIBILE", () => {
    // L'asserzione che avrebbe fallito prima del fix. Una chiave che non può
    // arrivare fa credere a chi legge che quel caso sia coperto.
    const spiegati = [
      "reassigned_to",
      "reassign_failed",
      "reassign_no_signal",
      "reassign_target_gone",
      "superseded_by_message",
    ];
    for (const type of spiegati) {
      expect(closedReason({ type })).not.toBeNull();
      expect(PROPOSAL_OUTCOME_TYPES).toContain(type);
    }
  });

  it("ogni esito che finisce su `email_proposals` è spiegato O escluso di proposito", () => {
    // Un esito NUOVO che non stia in nessuno dei due insiemi è una svista,
    // non una scelta — ed è così che ci si accorge di lui.
    for (const type of PROPOSAL_OUTCOME_TYPES) {
      const spiegato = closedReason({ type }) !== null;
      const escluso = (SUCCESSFUL_PROPOSAL_OUTCOMES as readonly string[]).includes(type);
      expect(spiegato !== escluso).toBe(true);
    }
  });

  it("gli esiti che vivono su ALTRE tabelle non rientrano nella mappa", () => {
    // Nominati apposta (vedi `OUTCOMES_ON_OTHER_TABLES`): tacerli è come è
    // nato il difetto — qualcuno li vede in un elenco di «esiti di una
    // proposta chiusa» e li mappa.
    for (const type of OUTCOMES_ON_OTHER_TABLES) {
      expect(closedReason({ type })).toBeNull();
      expect(PROPOSAL_OUTCOME_TYPES).not.toContain(type);
    }
  });

  it("`failed` è un CAMPO, non una chiave i18n da confrontare", () => {
    // Le chiavi i18n in questo repo si rinominano: dedurre il guasto dal nome
    // della chiave spegnerebbe in silenzio l'unica distinzione che il client
    // fa. Solo la riattribuzione fallita è un guasto.
    const guasti = PROPOSAL_OUTCOME_TYPES.filter((type) => closedReason({ type })?.failed === true);
    expect(guasti).toEqual(["reassign_failed"]);
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
