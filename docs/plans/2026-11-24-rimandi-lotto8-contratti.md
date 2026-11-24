# Rimandi, lotto 8: i contratti per il server

*24 nov 2026, 94 (renderer), su richiesta di 46.* Le voci nascono dalle
decisioni del maintainer del 24 nov 2026. Per ognuna: cosa fa il prototipo,
cosa c'è oggi, il contratto e le scelte già prese (con chi le ha prese).

| § | Area | Voce | Registro |
|---|---|---|---|
| 1 | Chat (A10) | I contesti si accumulano nella conversazione | r.132 |
| 2 | A6 | Rispondere da un alias di Gmail (send-as) | r.1077 |
| 3 | A7 | Le esecuzioni finite da più di 90 giorni, compattate | r.601 |

Regole comuni: verso i client solo cambi ADDITIVI (ogni campo nuovo nasce
`.default()`/`.optional()`/`.nullable()`, e il renderer ha un test con una
fixture senza il campo); il client legge i permessi calcolati dal server.

## 1. Chat — I contesti si accumulano nella conversazione

Decisione del maintainer: «Tutti quelli aperti». Aprire Claude da più
pagine nella stessa conversazione ACCUMULA i contesti: più chip, ognuno si
toglie, e Claude li vede tutti. Le scelte di 46 (24 nov 2026), su
raccomandazione di 94:
- il gruppo è della conversazione e lo ricorda il server (riaperta domani,
  i chip ci sono ancora);
- il PRIMARIO è l'ultimo aggiunto (la pagina da cui si scrive adesso):
  «questa task» si riferisce a lui, gli altri sono contesto in più;
- il tetto è 5: aprire da una sesta pagina toglie il più vecchio, senza
  chiedere;
- sotto ogni messaggio, i nomi brevi di TUTTI i contesti partiti con lui.

### Cosa c'è oggi

- Server: un contesto per conversazione, `claude_conversations.context_ref`
  (`{ kind, id }`, `claudeConversationContextSchema`); `PATCH
  /api/claude/conversations/:id { context }` lo sostituisce.
- Adattatore (`data/backend/real/claudeChat.ts:467-469`): prima di ogni
  messaggio scrive il contesto con un PATCH, quindi l'ultimo vince.
- Prototipo: un `context` per messaggio (`sendMessage(id, message, { context
  })`), il chip della pagina di adesso, il nome breve sotto il messaggio.

### Contratto

**La conversazione.** La vista porta
`contexts: { kind: string; id: string }[]`, `.default([])`, dal più vecchio
al più nuovo; l'ULTIMO è il primario. `context` resta, ed è l'ultimo di
`contexts` (o null): i client di prima continuano a leggerlo.

**Scrittura.** `PATCH /api/claude/conversations/:id { contexts }`
sostituisce il gruppo: al più 5, senza doppioni (`kind`+`id`), l'ultimo è
il primario; 422 `too_many_contexts` oltre 5. È così che si toglie un chip.
`{ context }` (il campo di prima) AGGIUNGE in fondo, togliendo un doppione e
il più vecchio oltre 5: un client di prima accumula da sé.

**Il messaggio.** L'evento `input` porta
`contexts: { kind, id }[]` (`.default([])`): il gruppo com'era quando il
messaggio è partito, per i nomi brevi sotto di lui. Lo scrive il server
dal gruppo della conversazione al momento dell'invio; il client non lo manda
due volte.

**Il prompt.** Claude riceve tutti i contesti del gruppo come riferimenti
(`tipo: id`, come oggi), col primario segnato («la pagina da cui scrive»).
Ognuno si rilegge con la visibilità di chi scrive: uno che non vede più non
entra (né nel prompt né nella vista: si toglie dal gruppo alla lettura).

### Cosa farà il renderer

- Prototipo: il gruppo per conversazione; aprire il riquadro da una pagina
  aggiunge la sua (in fondo, il più vecchio esce oltre 5); una riga di chip
  ognuno con la ×; il messaggio parte con tutti, il primario per «questa».
- Adattatore: legge `contexts`; aggiungere e togliere sono un PATCH di
  `contexts` (non più `context` prima di ogni messaggio); i nomi brevi sotto il
  messaggio da `input.contexts`.

### Test che il renderer scriverà

- adattatore: `contexts` → i chip; PATCH col gruppo; una vista SENZA
  `contexts` (server di prima) → il solo `context`, come oggi;
- prototipo: tre pagine → tre chip; una × lo toglie; la sesta toglie la
  prima; «questa task» va al primario.

## 2. A6 — Rispondere da un alias di Gmail (send-as)

Decisione del maintainer: «Sì, con riconsenso». Scelte di 46 (24 nov
2026), su raccomandazione di 94:
- **nessuno scope nuovo**: leggere gli alias (`users.settings.sendAs.list`)
  e mandare da un alias verificato (`messages.send` con l'alias nel From)
  bastano con `gmail.modify`, che le caselle che inviano hanno già
  (`gmail.settings.basic` serve solo a CAMBIARE le impostazioni, vedi
  `packages/google/src/gmail-compose.ts:273-276`);
- il riconsenso solo per le caselle senza `gmail.modify` (collegate in sola
  lettura): il «Da» dice «Ricollega la casella per usare i tuoi alias», col
  flusso di ricollegamento di oggi;
- rispondendo, il «Da» parte dall'alias a cui era indirizzato il messaggio
  (in `to` o `cc`), se è uno degli alias; altrimenti dall'alias predefinito.
  Come Gmail.

### Contratto

**La casella** (`GET /api/me/google/accounts`, e dove la Posta legge la
casella):
- `sendAs: { email: string; displayName: string | null; isPrimary: boolean; isDefault: boolean }[]`,
  `.default([])`: l'indirizzo della casella e gli alias VERIFICATI
  (`verificationStatus: accepted`); un alias in attesa di verifica non c'è;
- `sendAsStatus: "present" | "scope_missing"`, `.default("present")`:
  `scope_missing` = la casella non ha `gmail.modify` (il menu lo dice).
- L'elenco si rilegge da Gmail quando serve (alla sincronizzazione della
  casella o con una cache breve): come, lo decide il server.

**La bozza** (`MailDraft`, lettura e salvataggio):
- `from: string | null`, `.default(null)`: l'indirizzo da cui parte; `null`
  = l'alias predefinito;
- creando una risposta (`reply`, `replyAll`; anche la bozza di Claude) il
  server mette in `from` l'alias a cui era indirizzato il messaggio, se ce
  n'è uno; il client lo mostra e lo si può cambiare;
- salvare con un `from` che non è fra gli alias della casella: 422
  `invalid_from`.

**L'invio**: parte da `from` (l'header From con `displayName`); il server
lo riverifica contro l'elenco al momento dell'invio (un alias tolto su
Gmail nel frattempo): 422 `invalid_from`, la bozza resta. La firma è quella
dell'alias scelto (`sendAs.get` del `from`), come oggi per la casella.

### Cosa farà il renderer

- Prototipo: la casella del seme con due alias; nel compositore il menu
  «Da» (casella e alias, il predefinito segnato); rispondendo parte
  dall'alias del messaggio; una casella senza lo scope dice «Ricollega la
  casella per usare i tuoi alias» con «Ricollega».
- Adattatore: legge `sendAs`/`sendAsStatus` e `from`; salva `from`; dice
  `invalid_from` con le parole del prototipo.

### Test che il renderer scriverà

- adattatore: `sendAs` → il menu; `from` nel salvataggio; una vista SENZA i
  campi nuovi (server di prima) → nessun menu, si parte dalla casella;
- prototipo: la risposta parte dall'alias giusto; `scope_missing` → la riga
  del ricollegamento.

## 3. A7 — Le esecuzioni finite da più di 90 giorni

**Fatta** (server 72, 0e0f96490; renderer 94, 9b144746a). Un'esecuzione
finita da più di `AUTOMATION_RUN_DETAILS_DAYS` (90, in `@stubwise/shared`)
giorni si compatta: restano numero, stato, date, versione, progetti,
origine e madre; il titolo diventa il nome dell'automazione; registro,
evento, variabili, passo, attesa ed errore si svuotano;
`detailsPruned: true`. La pagina si apre ancora e al posto del registro dice
«This run's details are gone: they're kept for 90 days.» / «I dettagli di
questa esecuzione non ci sono più: si tengono 90 giorni.». I link
(registro, card, origine di una task) aprono la pagina come prima; un
`entry` null nell'origine non punta a una riga.
