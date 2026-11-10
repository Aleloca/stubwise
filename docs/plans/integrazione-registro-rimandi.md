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
- Abbinare un commit per **username** del provider *(S)*: nessuna tabella lega
  un utente al suo login GitHub, quindi lo username (letto dalle noreply) si
  mostra ma non abbina; si abbina per email (account o `git_identities`).
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
- **Produzione 2.1.287 e tool nativi** *(M, 10 nov 2026)*: l'init espone gli
  stessi tool nativi del 2.1.322 (CronCreate, RemoteTrigger, SendMessage,
  PushNotification, ToolSearch…; traccia di `streaming-cli.test`,
  `apps/worker/src/sessions/fixtures/interrupt-then-message.jsonl`);
  eseguibilità non verificata (il binario non c'è e non si scarica).
  Decisione del maintainer del 10 nov: correzione solo col rilascio del pin
  2.1.322, insieme all'elenco esplicito dei nativi per run (commit
  «fix(worker): elenco esplicito dei tool nativi per ogni run del CLI»,
  `docs/invariants/agent-sessions.md`, «I tool NATIVI di ogni run»). Si
  chiude con quel rilascio.

## Chiuse

(Le voci fatte si spostano qui con il riferimento che le chiude.)

- Area 3, la riga di Claude nel Planning di progetto per chi NON può
  assegnarlo *(O, 10 nov 2026)*: c'è per chiunque veda il Planning, col suo
  carico, in sola lettura col motivo e fuori dai bersagli — commit
  «fix(desktop): la riga di Claude nel Planning, in sola lettura»,
  `apps/desktop/docs/integration-area3e.md`.

- Area 3, 3e.2 **Claude assegnabile, renderer** *(M)*: riga e carico nel
  Planning, assegnatario solo dove `claudeAssignableProjectIds` lo dice, la sua
  frase per `claude_assign_forbidden` — commit «feat(desktop): Claude
  assegnabile (3e.2)», `apps/desktop/docs/integration-area3e.md`.
- Polso e «aspetta te» con Claude *(O)*: «Claude al lavoro» (sessioni `ai_job`
  dal vivo) e «Claude aspetta te» (voci di Claude in «Da decidere») nel polso e
  sulle tessere — stesso commit.

- Area 3, 3e.1 **Claude assegnabile, server** *(M)*: utente di sistema (0125,
  `users.is_agent`), niente accesso né notifiche, assegnarlo avvia il run con le
  regole di `run-ai` e chiede `runs.start` — commit «feat(area3): Claude
  assegnabile (3e.1)».
- Area 3, **«Link a person» nello standup, renderer** *(O)*: sul web
  `POST /api/users/:id/git-identities` con la riconferma, dal desktop il gesto
  apre il web sulla stessa pagina; la riga senza persona mostra email e
  username — commit «feat(desktop): Link a person nello standup»,
  `apps/desktop/docs/integration-area3e.md`.
- Area 3, **«Link a person» nello standup, server** *(S)*: i commit si
  attribuiscono anche via `git_identities`; le righe senza persona sono per
  email e portano `authorEmail` e `authorUsername` — commit «feat(area3):
  collegare un autore di commit allo standup».
