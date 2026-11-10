# Registro dei rimandi dell'integrazione del prototipo desktop

Unico posto in cui sta **tutto ciò che è stato rimandato a una fase successiva**
durante l'integrazione del prototipo (`apps/desktop`) col backend vero, insieme
alle **decisioni già prese** su quelle cose. Le tabelle di parità
(`apps/desktop/docs/integration-*.md`) dicono cosa è stato fatto in una fetta;
questo registro dice cosa **deve entrare** nelle fasi che verranno.

**Regola (maintainer, 10 nov 2026)**: chi apre il design di una fase o di
un'area lo parte da qui. Ogni voce della sua area entra nel design (o resta qui
con un motivo scritto); alla chiusura della fase le voci fatte si spostano in
«Chiuse», con il commit o la tabella di parità che le chiude. Una decisione già
presa e scritta qui non si ridecide senza il maintainer.

Legenda: *(M)* decisione del maintainer, *(O)* scelta dell'orchestratrice,
*(S)* limite del server da colmare.

---

## Area 3 — Claude come collega (in corso)

- 3e **Claude assegnabile, renderer (3e.2)** *(M)*: riga Claude nel Planning
  con il suo carico; Claude fra gli assegnatari solo dove la sua riga di
  `/api/people` lo dice (`claudeAssignableProjectIds`, calcolato dal server). Il
  server è fatto (3e.1, sotto in «Chiuse»).
- «Annulla il lavoro» DOPO il push *(O, 10 nov 2026)*: non vale più, la PR si
  apre comunque (il lavoro è già sul remoto). Accettato; da riguardare se un
  giorno serve «annulla e chiudi la PR».
- «Annulla il lavoro» col runner classico (`AGENT_STREAMING=false`) *(S)*: il
  CLI non si uccide a metà, vale solo il controllo fra i passi.
- Standup per persona *(S)*: `tasksDeleted` sempre vuoto (il server non tiene
  le task eliminate) e `viaClaude` sempre falso (nessun evento dice se un
  cambio l'ha fatto Claude per una persona).
- Il dettaglio della sessione non porta il piano né il suo digest *(S)*: il
  digest da rimandare ad approve/reject si legge da `/work` o da «Da decidere».
- Polso e «aspetta te» con Claude: «Claude al lavoro», «Claude aspetta te» nel
  polso dei progetti e nel portafoglio *(O)* (oggi esclusi, `integration-slice4.md`).
- «Link a person» nello standup *(S)*: il server deve legare i commit anche via
  `git_identities`/username e dare `authorEmail` alle righe senza persona; dal
  desktop il gesto (con riconferma) apre il web.
- Chi ha avviato una sessione e chi ha risposto a una domanda (e quando) *(S)*:
  oggi non arrivano.
- Consumi per task (`usage`) e blocco d'istanza (`blocked`) in `/work` *(S)*.
- Allegati nei messaggi a una sessione *(S)*: il server non li accetta.
- `generatedAt` dei report giornalieri *(S)*.
- Report giornaliero per progetto (oggi si rigenerano tutti i progetti del
  giorno) *(O, differenza dal prototipo)*.

## Fase «Chat con Claude e azioni» (dopo l'area 3)

Design: `docs/plans/2026-11-10-integrazione-claude-chat-design.md`.

- Classi A/B/C/D come il prototipo, calcolate dal server *(M)*.
- Prima versione: azioni delle sole aree integrate (task, commenti, richieste,
  traguardi, filtri, avvio del lavoro, azioni della pagina) *(M)*.
- Fuori portata: risponde il modello; per un'azione non in catalogo dice che non
  può e dove si fa a mano *(M)*.
- **Conversazioni pubbliche e continuazione**, `claude.public.view`, conferma dei
  progetti, messaggi privati se Claude tocca un progetto nuovo: fetta a sé dopo
  la prima versione *(M)*.
- Citazioni, menzioni, «Claude can help you…» (suggerimenti nelle pagine),
  riquadro come chat, ⌘J/⌘K «Ask Claude» *(O)*.
- Azioni delle altre aree: entrano **con la loro area** (sotto) *(O)*.
- **Limiti della fetta 1 (runner)** *(S, stubwise-80)*: i tool di lettura sono
  sei (progetti, cerca/leggi task, leggi richiesta, cerca docs, brief +
  registro decisioni). Non leggono commenti e storia della task, la pagina
  Docs intera, il codice o il grafo; restituiscono il JSON delle rotte
  compattato (senza chiavi da segreto, tetto 12.000 caratteri), non le viste
  delle pagine. Si allargano aggiungendo rotte di LETTURA a
  `CHAT_TOOL_READ_ROUTES` (col test del registro) e un tool al ponte.
- Il contesto della pagina arriva al modello come `tipo: id`, non come il suo
  contenuto: Claude lo legge con i tool se serve *(S)*.
- Conversazioni senza chiusura per inattività e senza retention: restano
  finché l'autore non le archivia o le elimina (eventi compresi) *(S)*.
- Budget del mese finito: in chat nessuno lo scavalca (una conversazione non ha
  un progetto, quindi nessun `plans.approve`) *(S)*.
- **Limiti della fetta 2 (renderer, destinazione)** *(S, stubwise-80)*:
  - «#» propone task e progetti, non richieste né pagine Docs; «@» le persone.
  - «/» ha i soli comandi che si risolvono leggendo (`/status`, `/today`,
    `/explain`, `/docs`); niente skill dei plugin del progetto (il server non
    le espone).
  - Le citazioni registrate su un messaggio non esistono sul server: Claude
    cita col codice nel testo, che la pagina risolve (`resolveCodes`, task e
    richieste).
  - Il contesto è UNO per conversazione: un messaggio col chip di una pagina
    lo sostituisce (l'ultimo vince) e il turno lo ripete al modello; il
    contesto di progetto scelto all'inizio si perde dopo un messaggio con un
    chip di task.
  - La riga di benvenuto dice la promessa di sola lettura
    (`landing.introRead`) finché le azioni in chat non entrano.

## Area 4 — Chat

- Canale «general» creato col progetto *(da `integration-slice4.md`)*.
- Domande della Chat e di Claude in chat in «Da decidere».
- @Claude nella chat (regole proprie del prototipo: tutto proposte, niente
  «Annulla»).

## Area 5 — Docs e Drive

- Docs del progetto e Drive (sezioni «in arrivo»); modulo Docs dei progetti.

## Area 6 — Posta e Calendario

- Blocchi della Home «Eventi in arrivo» e «Posta importante» (oggi nascosti e
  conservati al salvataggio).
- Azione di Claude «bozza del corpo dell'email».

## Area 7 — Automazioni

- Blocco della Home delle automazioni.
- Effetti che il prototipo ha e la build app spegne: segnali alle automazioni
  alla chiusura di un traguardo e alla conversione di una richiesta.
- Azioni di Claude: crea automazione in bozza, salva/elimina bozza, prova.

## Area 8 — Rilasci, ambienti, avvisi, Support, Servers

- Blocchi della Home «Rilasci» (anche l'extra di `resolveHome` per
  `release.merge`) e «Clienti in attesa».
- Origine di una richiesta da Support; «View conversation» delle task del widget.
- Adozione delle PR e rilascio (merge) — confine di prodotto invariato.
- Azioni di Claude: iscrizioni agli avvisi, bozze di risposta di supporto e
  delle note di rilascio della PR.

## Area 9 — Amministrazione, preferenze, accesso

- **Riconferma dal desktop** *(S/O)*: un PAT non soddisfa mai la riconferma, e
  l'area 9 ne è piena. Decidere come riconfermare dal desktop (es. il login dal
  browser esteso alla riconferma) prima di integrarla.
- Registro delle modifiche dell'istanza vero (oggi i ruoli di reparto lasciano
  solo una riga di log).
- Archiviati, interruttori di brief e report, pausa della coda e lavoro fermo.
- Le altre impostazioni di progetto (AI, repository, membri, integrazione,
  widget, regole mail, server, ambienti, plugin, elimina).
- Preferenze, persone e accessi, istanza (compresa la pagina Google, con
  l'origine vera dell'istanza al posto di `INSTANCE_ORIGIN` finto).
- Inbox: «Restore», «Move to New» e «segna come non letta» *(S)*.
- Tentativi rimasti del secondo fattore *(S)*.
- Permessi di progetto dati da un reparto (`department-permissions`): non
  previsti dal server, da decidere col maintainer se servono.
- Azioni di Claude dell'area 9 (membri, ruoli, impostazioni senza segreti), con
  la riconferma.

## Area 10 — Integrazione di Claude

- **Elimina task** (il server non la ha: regole per figlie, collegamenti, codice
  mai riusato) e le task eliminate nella cronologia e nello standup.

## Area 11 — Documentazione di prodotto

- Origine di una richiesta dalla documentazione di prodotto.
- Azioni di Claude dell'area 11.

## Trasversali

- **Ritiro del web vecchio** e passaggio di `/app` alla radice (decisione aperta
  del design della fetta 1); con il ritiro: togliere `tickets.status` enum,
  `saved_views`, `/api/projects/pulse` se nessuno lo legge più.
- **MCP** (`@stubwise/mcp`): imparare stati per progetto, reparti, taglie, codici
  R<n>, Home e filtri.
- Download degli allegati dal desktop (oggi 302 presigned non passa dal proxy).
- Elenchi oltre le 2000 righe (oggi troncati e dichiarati); una rotta aggregata
  per il polso del portafoglio.
- **CLI `claude` del worker aggiornato con regolarità** *(M)*, ogni volta col
  giro completo dei golden e i testi del limite riverificati.
- App mobile: riceve il fix del reader dei traguardi (e gli altri cambi delle
  risposte) solo con una nuova build.
- Prova a mano complessiva: `apps/desktop/docs/integration-manual-tests.md`.

## Chiuse

(Le voci fatte si spostano qui con il riferimento che le chiude.)

- Area 3, 3e.1 **Claude assegnabile, server** *(M)*: utente di sistema (0125,
  `users.is_agent`), niente accesso né notifiche, assegnarlo avvia il run con le
  regole di `run-ai` e chiede `runs.start` — commit «feat(area3): Claude
  assegnabile (3e.1)».
