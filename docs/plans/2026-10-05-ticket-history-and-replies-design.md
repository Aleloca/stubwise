# Storia vera del ticket e risposte ai commenti

Data: 5 ott 2026. Stato: design approvato dal maintainer (decisioni 1–5 prese
una alla volta, 5 ott). Nato dalla prova sul telefono della pagina del ticket a
tab (PR #78).

## 1. Il problema, verificato sul codice di oggi

**La storia.** «Story of the work» nell'app (`Timeline.tsx`, `buildTimeline`
in `apps/mobile/src/lib/timeline.ts`) mostra SEMPRE sei passi fissi
(Proposed → Question answered → Plan approved → Running → PR & review →
Release), calcolati dal solo ULTIMO job. I giri di correzione post-PR non
compaiono. Il ticket #1 di Stubwise Test, ricostruito dal DB:

```
02/10 09:06  fix dell'AI → PR #4 aperta
02/10 09:09  review: approvata
02/10 09:13  correzione chiesta da Stubwise → pushata sulla PR #4
02/10 09:16  review: approvata
02/10 09:29  correzione chiesta da Bitbucket («Request changes») → pushata
02/10 09:34  review: approvata
02/10 11:48  correzione chiesta dall'app → pushata
02/10 11:51  review: approvata
```

Nell'app se ne vede un pallino «PR & review · approved». Il dato su CHI ha
chiesto una correzione e DA DOVE (`pr_corrections.trigger`,
`requested_by_user_id`, `requested_by_provider_login`) oggi non arriva a nessun
client. Una correzione NON apre una PR nuova: aggiunge commit alla stessa.

**Le risposte.** `comments` (`packages/db/src/schema.ts`) non ha un legame fra
commenti; i commenti non si modificano né si cancellano (nessuna rotta), quindi
un commento sparisce solo con il suo ticket.

## 2. Decisioni del maintainer

1. La storia diventa una **cronologia vera**, un evento per riga, al posto dei
   sei passi fissi.
2. La calcola il **server**; la disegna **solo l'app** per ora. Il web resta
   com'è e potrà usarla più avanti.
3. **Dal più recente**, come i commenti.
4. **Gli ultimi 8 eventi** più «Show all (N)».
5. Risposte ai commenti con **parità web/app**: bottone «Rispondi» e riga «in
   risposta a» su entrambe.

Decisione presa senza domanda (detta al maintainer): le righe con un link (PR
aperta, correzione pushata) aprono la PR; le altre sono testo.

## 3. La cronologia (server)

**Rotta nuova** `GET /api/tickets/:id/history` → `{ events: HistoryEvent[] }`,
dal più recente. Stessa autorizzazione di `GET /api/tickets/:id/activity`.
Rotta nuova e non un campo di `/activity`: quella risposta l'app già
installata la parsa con uno schema piatto e permissivo
(`ticketActivityEntrySchema`), e cambiarne il significato è il genere di
cambio che non si ritira.

`HistoryEvent` — forma piatta, `kind` stringa aperta (stessa scelta e stesso
motivo di `ticketActivityEntrySchema`: `readerSchema` non attraversa le
union):

```ts
{
  id: string;            // stabile: `${kind}:${idDellaRiga}`
  kind: string;          // vedi tabella
  at: string;            // ISO
  actor: { type: "user" | "ai" | "system" | "provider"; name: string | null } | null;
  prNumber: number | null;
  prUrl: string | null;
  round: number | null;  // giro di correzione sulla PR, da 1
  detail: string | null; // es. verdetto, stato di arrivo
}
```

Ogni campo opzionale nasce `.nullable().default(null)` (regola dell'app).

| `kind` | Da | Note |
|---|---|---|
| `run_started` | `ai_jobs` senza `correction_id` | `actor` = chi l'ha avviato |
| `question_asked` / `question_answered` | `agent_questions` | answered: `actor` = chi ha risposto |
| `plan_approved` / `plan_rejected` | eventi di audit / registro decisioni già scritti | verificare la fonte nel piano |
| `pr_opened` | `ai_jobs` (fix) con `pr_url` | link alla PR |
| `review_completed` | `pr_reviews` PARTITE (`started_at IS NOT NULL`) | `detail` = verdetto |
| `changes_requested` | `pr_corrections` | `actor`: utente Stubwise (trigger `stubwise`), login della piattaforma (`provider`), «review» (ciclo automatico, `review`); `round` |
| `correction_pushed` / `correction_failed` | `ai_jobs` con `correction_id`, terminali | link alla PR, `round` |
| `pr_merged` / `pr_closed` | `ticket_repositories.pr_state` / eventi di chiusura | se il dato ha una data; altrimenti fuori (piano) |
| `status_changed` | `ticket_events` | `detail` = stato di arrivo |

I commenti NON entrano nella cronologia: hanno il loro elenco sotto. Neanche i
commenti automatici («Fix automatico pronto…»), che raccontano gli stessi fatti
due volte.

`round` si deriva come il contatore dei giri (`autoRoundsInCurrentSeries` vive
in `packages/notifications/src/pr-correction-cycle.ts`): numerazione per PR, in
ordine di creazione. La costruzione sta in un modulo puro in
`packages/notifications` (accanto a `project-timeline.ts`), testato da solo.

Tetto: la rotta restituisce al più 200 eventi (dichiarato nel docblock).

## 4. La cronologia (app)

`Timeline.tsx` viene sostituito da `TicketHistory`: una riga per evento — ora
relativa (`relativeTimeCompact`, il server manda la data), testo da i18n per
`kind` (un `kind` ignoto: riga generica «Aggiornamento», mai scartata), chi,
`PR #N · giro K`. Primi 8, poi «Show all (N)» espande sul posto. Le righe con
`prUrl` sono premibili e aprono la PR. Query nuova `tickets.history` in
`packages/api-client`; fallita o server vecchio (404) → la sezione dice che la
storia non è disponibile, il resto della tab resta intero. `buildTimeline` e
`Timeline.tsx` si rimuovono se non hanno altri consumatori (verificarlo).

## 5. Risposte ai commenti

**DB** — migrazione 0083, additiva, un batch, nessun backfill:
`comments.reply_to_comment_id uuid NULL REFERENCES comments(id) ON DELETE SET
NULL`. Un solo livello di riferimento: una risposta a una risposta punta al suo
genitore diretto, e l'elenco resta piatto.

**Server** — `POST /api/tickets/:id/comments` accetta `replyToCommentId?`
(opzionale: le app vecchie non lo mandano). Validazione: il commento esiste ed
è dello STESSO ticket, altrimenti 422 `reply_target_invalid`. Le risposte dei
commenti portano `replyTo: { id, authorType, authorName, excerpt } | null`
(`.nullable().default(null)`), DERIVATO a lettura (estratto ~120 caratteri del
corpo, senza markdown). Su `ticketCommentSchema` in `packages/shared`.

**App** — su ogni commento un «Reply». Lo tocchi: il campo in cima riceve il
fuoco con sopra «Replying to {nome}: “estratto” ✕»; inviato, la risposta
compare in cima all'elenco (dal più recente) con la riga «in risposta a {nome}:
“estratto”»; toccarla scorre al commento originale. Originale non più nella
lista: la riga resta, non premibile.

**Web** — stessa cosa nel feed d'attività della pagina del ticket: «Reply» sul
commento, riga «in risposta a» sopra la risposta, link all'originale. Campo
letto con `?? null` (il web fa un cast).

Nessuna notifica nuova: non esiste un kind per i commenti (verificato nel
design delle tab), e aggiungerlo è un'altra decisione.

## 6. Deploy e rollback

Rebuild **server + caddy**; il worker non c'entra; l'app si aggiorna dagli
store. Migrazione 0083 additiva, nessun enum, nessuna env, nessun kind di
notifica. Rollback innocuo: server vecchio → `history` 404 (l'app dice «non
disponibile»), `replyTo` assente (app dal `.default`, web dal `?? null`), il
body con `replyToCommentId` torna a essere ignorato; la colonna sopravvive.

## 7. Test

Modulo della cronologia: il ticket #1 come fixture (4 review, 3 correzioni da
tre origini), ordine, `round`, review in attesa esclusa, `kind` ignoto lato
app. Rotta: autorizzazione come `/activity`. Risposte: risposta a un commento
di un altro ticket → 422 e nessuna riga; app e web con fixture SENZA i campi
nuovi; le tre trappole dei test dell'app (fixture complete, metodi nel doppio
`makeClient()` prima, `await render`).
