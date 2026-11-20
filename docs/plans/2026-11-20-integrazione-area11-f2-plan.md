# Integrazione area 11, F2 — commenti, menzioni e le notifiche nel catalogo: piano

> Design: `docs/plans/2026-11-20-integrazione-area11-design.md`, «F2» (D-6 =
> b, N-1 = a, maintainer). Specifica: il prototipo
> (`data/productDocs/comments.ts`, `alertTypes.ts`, `follows.ts`
> `productDocRecipients`; `comments/*` nel renderer). Invarianti: CLAUDE.md
> («I campi che un client legge su una card… si DERIVANO A LETTURA», «un
> `notification_kind` nuovo»), `permissions.md`, la regola dei commenti
> eliminati dei ticket («Un commento eliminato non ha più testo»).
> Branch: `feat/area11-f2` da `feat/area11-f1`.

## Prima del codice

- **Nessuna [DECIDE] nuova**: N-1 = a l'ha decisa il maintainer.
- **Il prototipo si riallinea (94), e lo dico qui perché si vede**: oggi le
  tre righe del prototipo (`alertTypes.ts`, 19 nov 2026) sono `addressed`,
  tutte iscrivibili e spegnibili, menzioni comprese. Con N-1 = a:
  - `product_doc.mention` è SOLO obbligatoria: arriva sempre, e in
    Preferenze non ha un interruttore (come `pr.corrected`). Il Telefono
    parte acceso, come oggi nel prototipo;
  - `product_doc.updated` e `.question` hanno la riga del progetto, accesa di
    partenza per chi ha `docs.edit`; chi SEGUE la pagina le riceve sempre
    (motivo obbligatorio `follower`), anche con la riga spenta.
  Il prototipo cambia `alertTypes.ts` e `productDocRecipients` così, PRIMA
  che il renderer vero si accenda (94).
- **Ruling (chi riceve `updated` e `question` senza seguire)**: la riga del
  catalogo con `defaultOn: { perm: "docs.edit" }` e l'iscrizione con
  `docs.view` fanno ciò che nel prototipo faceva «altrimenti chi ha
  `docs.edit`»: chi scrive la doc la riceve di partenza, chi la legge solo se
  la accende. Lo uso già qui per scrivere le righe; i produttori arrivano in
  F5. Se sbagliato costa un valore di default.
- **Fatti del codice che contano**:
  - il catalogo degli avvisi (`packages/shared/src/alerts/catalog.ts`) ha la
    famiglia `docs`; `MandatoryReason` si allarga con `mentioned` e
    `follower`; `alertRecipients` (`packages/notifications`) ha già
    `mandatory`, `mandatoryOnly` ed `exclude`;
  - un tipo entra in `LIVE_ALERT_TYPES` solo col suo `notification_kind` (il
    test di parità lo pretende) e col suo produttore: qui solo `mention`;
  - i `notification_kind` nuovi: ognuno un `ALTER TYPE … ADD VALUE` in uno
    statement a sé, mai usato nello stesso batch. Li aggiungo TUTTI E TRE in
    questa fetta (una migrazione, tre statement): `updated` e `question` non
    hanno righe finché F5 non li produce, quindi il rollback di F2 resta
    legato alle sole menzioni;
  - la regola dei commenti eliminati: `body = ''` con la CHECK (`deleted_at IS
    NULL OR body = ''`), come `comments` dei ticket.

## Regole di lavoro (le solite)

Come F1. Nel giro anche `alert-recipients.test.ts`, `format.test.ts`, il test
di parità del catalogo, `inbox.test.ts` e `load-isolated.test.ts`.

## Task 1 — il catalogo e i kind (shared, db, notifications)

**File**: `alerts/catalog.ts` (le tre righe, i motivi `mentioned` e
`follower`), la migrazione (tre `ADD VALUE`), `notifications/format.ts` (gli
eventi `ProductDocMentionEvent`, `…UpdatedEvent`, `…QuestionEvent`: solo id
e codici, mai testo della pagina), le etichette i18n (`alerts.types.product_doc_*`,
en e it).

**Test**: il catalogo (le tre righe, `mention` solo obbligatoria, i default),
`alertRecipients` coi due motivi (un `follower` con la riga spenta la riceve;
una menzione a chi non vede più la pagina NO, perché la visibilità viene
prima di tutto), il test di parità, la migrazione in fila.

Mutazione: `follower` che rispetta la riga spenta.

## Task 2 — i commenti (db, server)

**File**: la tabella `product_comments (id, page_id → cascade, anchor_id,
quote ≤200, reply_to_id → product_comments, body, author_id, mentions uuid[],
resolved_at, resolved_by, deleted_at, created_at)` con la CHECK del testo
eliminato; `services/product-comments.ts`; le rotte in
`routes/product-docs.ts`:
- `GET /api/product-pages/:id/comments` → i fili, con «Sentence deleted»
  DERIVATO (l'ancora non c'è più nei blocchi di adesso), i nomi R-G5;
- `POST …/comments { anchorId, quote, body, replyToId? }` (`docs.edit`;
  un'ancora che non esiste 422; una risposta a una risposta 422, come il
  prototipo);
- `POST /api/product-comments/:id/resolve` e `…/reopen`;
- `GET /api/projects/:projectId/product/mention-candidates?q=` (le persone
  che chi scrive vede e che leggono i Docs del progetto, mai Claude, mai sé).

**Test**: commentare con `docs.view` 403; la frase citata ripulita (≤200, una
riga, `cleanQuote` del prototipo in shared); «Sentence deleted» dopo un
`delete` dell'ancora; un `merge` che sposta le ancore sposta i commenti
(`mergedFrom` di F1); i candidati senza chi non legge i Docs.

Mutazione: «Sentence deleted» letto da una colonna invece che derivato.

## Task 3 — la menzione (server)

- Al commento, una card `product_doc.mention` per ogni menzionato che vede la
  pagina (`mandatory: [{ userId, reason: "mentioned" }]`, `exclude: [autore]`),
  nella transazione del commento. `mention` entra in `LIVE_ALERT_TYPES`.
- Sulla card i campi derivati a lettura (`inbox.ts`): titolo e codice della
  pagina, chi ha menzionato (R-G5), `objectGone` se la pagina non c'è più o
  chi guarda non la vede più.

**Test** (`inbox-product-mention.test.ts`): la card nasce, all'autore no; a
chi non vede la pagina no; CARD VECCHIA: un titolo cambiato dopo la publish
si legge nuovo (il derivato scavalca il jsonb); pagina eliminata →
`objectGone`.

Mutazione: il titolo letto dal jsonb.

## Task 4 — l'api-client e i documenti

- `api-client`: commenti, risoluzione, candidati; i campi nuovi della card
  `.nullable().default(null)` con il test di parse senza.
- `deploy-log.md`: una migrazione (la tabella e tre kind). ORDINE: server,
  poi caddy. **Rollback NON sicuro sul server finché esistono righe
  `product_doc.mention`** (500 su `/api/inbox`): le query per contarle e
  toglierle.

## Per 94 (renderer)

- Il riallineamento del prototipo detto sopra (N-1 = a), prima di accendere.
- I commenti, la risoluzione, le menzioni; Preferenze → Notifiche mostra le
  righe vive (qui solo la menzione, senza interruttore).

## Review Focus

- Una menzione arriva solo a chi vede la pagina, mai all'autore.
- I campi della card si derivano a lettura.
- Un commento eliminato non ha più testo.
- `follower` e `mentioned` non si spengono con la riga.
