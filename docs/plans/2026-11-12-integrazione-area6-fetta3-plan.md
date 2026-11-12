# Integrazione area 6, fetta 3: scrivere (piano)

> Design: `docs/plans/2026-11-12-integrazione-area6-design.md` (§Fette, D6,
> D7). Specifica: il prototipo (`apps/desktop/src/renderer/data/mail/
> {compose,send}.ts`, `model.ts` `MailDraft`/`MailSendResult`/
> `MailDraftRestore`, il Composer) e le forme che stubwise-94 ha mandato il
> 12 nov 2026. Esecutori: stubwise-72 (server, worker, api-client),
> stubwise-94 (renderer). Branch `feat/area6-f3`, da `feat/area6-f2`
> (60ee9aa0). Invarianti: `docs/invariants/mail-calendar.md` («Nessuna
> scrittura verso Google senza un gesto», la proposta condivisa),
> `agent-sessions.md` (le azioni di Claude), la regola «almeno B».
> Registro, voci che entrano: l'azione di Claude «bozza del corpo
> dell'email». Restano dopo: i file Google come link (F5), lo slot «Scrivigli
> anche per email» di Support (area 8).

## Cosa fa

Rispondi, Rispondi a tutti, Inoltra, Nuova; destinatari suggeriti; allegati
(dal Drive del progetto o dal disco); bozze di **Gmail** (D7 = b); l'invio
trattenuto **10 secondi dal server** (D6), con Annulla, «in invio»,
«Riprova»; la bozza di Claude in streaming; l'azione di Claude «bozza del
corpo dell'email» (`mailBody`).

## Le regole che non si piegano

- **Nessuna scrittura verso Google senza un gesto della persona.** Salva,
  Invia, Elimina la bozza, Conferma la proposta di Claude: ognuno è una rotta
  chiamata da un gesto. Il worker manda un'email SOLO perché una persona ha
  premuto Invia (la riga d'invio porta chi e quando), allo scadere dei 10 s, e
  non ritenta MAI da solo un invio fallito.
- **Il testo delle email ricevute è contenuto NON fidato**, anche per la
  bozza di Claude e per `mailBody`: va al modello fra delimitatori e come
  DATI, e il testo generato resta testo (non esegue, non chiama tool, non
  spedisce). Una conversazione di Claude che legge la posta è segnata (la
  regola «almeno B»).
- **La posta resta personale**: bozze, invii in corso e falliti li vede solo
  chi scrive; si scrive solo dalle PROPRIE caselle; un invio partito diventa
  un messaggio come gli altri per chi ha quella posta nelle sue caselle.
- Scope: `gmail.modify` basta (bozze, `drafts.send`); una casella di prima
  (con `gmail.readonly`) riceve 409 `google_scope_missing` con `missing`.

## [DECIDE] per il maintainer

**A — La firma delle email mandate da Stubwise.** L'API non mette la firma di
Gmail: la si legge solo con lo scope `gmail.settings.basic`, che oggi non
chiediamo.
- (a, consigliata) Nessuna firma automatica in questa fetta: chi scrive la
  mette nel testo; la firma per casella nelle Preferenze va nel registro.
- (b) Chiedere `gmail.settings.basic` (un riconsenso in più per tutti) e
  aggiungere in coda la firma di Gmail.
- (c) Una firma per casella tenuta in Stubwise (Preferenze → Account), senza
  scope nuovi.

## Le scelte tecniche *(O)*

- **Le bozze sono bozze di Gmail** (D7 = b): il testo e i destinatari stanno
  su Gmail; Stubwise tiene accanto all'id della bozza Gmail solo ciò che Gmail
  non sa (`mode`, `quote`, il messaggio a cui si risponde, la casella) e
  l'id del messaggio della bozza visto all'ultimo salvataggio. Una bozza
  modificata da Gmail nel frattempo: 409 `draft_changed` con la versione di
  Gmail, mai «l'ultimo vince» in silenzio.
- **Una bozza per persona, conversazione e modalità**, più lo slot
  dell'email nuova (`threadId` null).
- **Testo semplice** (`text/plain`, UTF-8); gli allegati in `multipart/mixed`;
  la citazione di Rispondi è testo sotto «Il … ha scritto:».
- **L'indirizzamento lo calcola il server**: Rispondi = `Reply-To` o
  mittente; Rispondi a tutti = in più `to`/`cc` meno le mie caselle;
  Inoltra = nessuno, oggetto «Fwd:», gli allegati dell'originale.
- **L'invio** (D6): `sendDraft` scrive una riga d'invio (`mail_outgoing`,
  `send_at = now() + 10 s`, chi l'ha chiesto) e risponde subito
  (`undoUntil`); un poller del worker (con LISTEN, come «Aggiorna ora»)
  chiama `drafts.send` allo scadere. Annulla prima di `send_at`: la riga si
  chiude e la bozza torna. Riprova e Elimina solo da un gesto.
- **La posta mandata entra nei thread** come messaggio di CONTESTO
  (`admitted = false`): oggi l'ingestione la scarta del tutto. Non si
  classifica mai (resta la regola «la posta mandata dalla casella non è una
  richiesta ricevuta»).
- **La bozza di Claude** usa la superficie AI del server (`chat-llm.ts`,
  l'SDK, lo streaming SSE delle chat), tag d'operazione nuovo `mail_draft`
  (default Sonnet, configurabile in Impostazioni → Modelli: è un gesto della
  persona e la qualità conta), il budget mensile d'istanza come la chat.
- **`mailBody`**: un'azione di Claude nuova, `fill_mail_body { threadId,
  account, mode, text }`, **sempre B** (da confermare, mai automatica): la
  conferma salva il testo nella bozza Gmail di chi conferma, e solo il
  proprietario della casella può riceverla o confermarla.
- Allegati: al più 10 file e 25 MB in tutto (il limite di Gmail); dal Drive
  del progetto come copia (il file letto dallo storage, i file Google come
  link sono F5); dal disco con un upload multipart sulla bozza.

## Le forme per il renderer (risposta a stubwise-94)

Quelle che ha mandato, con questi nomi:
- `client.mail.drafts()`, `draft({ thread?, account, mode, replyTo? })`
  (quella salvata o una nuova già indirizzata, senza salvare),
  `saveDraft(input)`, `discardDraft(id)`, `attachDriveFile(draftId,
  driveFileId)`, `uploadAttachment(draftId, file)`;
- `sendDraft(id)` → `{ messageId, threadId, undoUntil }`, `undoSend`,
  `retrySend`, `deleteFailedSend` → `{ draft, droppedAttachments }`,
  `outgoing(messageId)`;
- sul thread, il messaggio in invio con `delivery: { state:
  "sending"|"sent"|"failed", error }` (solo per chi l'ha scritto);
- `recipients(q)` → `[{ name, email, personId, group: "team"|"mail" }]`;
- `claudeDraft({ thread, account, mode, hint? })`: SSE (`delta`, poi `done`
  con `{ text, projectId, used }`), errori `budget_exceeded`,
  `not_found`, `claude_unavailable`;
- `fill_mail_body`: la scheda di Claude, con la conferma che salva la bozza.

## Task (in ordine, ognuno col suo test rosso e le mutazioni)

1. Migrazione: `mail_drafts`, `mail_draft_attachments`, `mail_outgoing`.
2. `@stubwise/google`: bozze (crea, aggiorna, leggi, elimina, invia) e il MIME
   (intestazioni, citazione, allegati, `In-Reply-To`/`References`).
3. Server: bozze (elenco, «la bozza di», salva, elimina) con
   l'indirizzamento e il conflitto; gli allegati.
4. Invio: la riga d'invio, il poller del worker, Annulla, Riprova, Elimina; la
   posta mandata nei thread; `delivery` sul dettaglio.
5. Destinatari suggeriti.
6. La bozza di Claude in streaming.
7. L'azione `fill_mail_body`.
8. Chiusura: invarianti, deploy-log, registro, api-client completo.

## Global Constraints

- Nessuna scrittura verso Google senza un gesto; nessun ritentativo
  automatico di un invio.
- Il testo ricevuto è non fidato per Claude; il testo generato non esegue
  niente.
- Bozze e invii sono di chi scrive: l'id di chi guarda nella WHERE, una riga
  altrui è 404.
- Verso i client solo campi additivi con default; test filtrati; mutazioni.

## Review Focus

- Idempotenza dell'invio: un doppio clic, un Riprova, un riavvio del worker
  durante i 10 s non mandano due email.
- Annulla nei 10 s, anche col worker che sta per mandare (lo stato si
  ricontrolla in transazione).
- La bozza modificata da Gmail nel frattempo non si sovrascrive in silenzio.
