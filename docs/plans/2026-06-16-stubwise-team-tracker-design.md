# Stubwise — Tracker da team (design d'insieme)

> Design validato il 2026-06-16. Copre la sezione "Essere un vero tracker da
> team" del backlog (`docs/plans/feature-backlog.md`): 6 feature progettate in
> modo coerente ma **implementate e deployate una alla volta** (ogni feature ha
> un piano dedicato, resta indipendente e spedibile da sola).

## Le 6 feature

1. Ricerca full-text (titolo + body + commenti)
2. Cronologia/audit delle azioni umane → **activity feed unico**
3. Relazioni tra ticket (blocca / relativo / sotto-task)
4. Allegati/screenshot (+ screenshot del feedback SDK)
5. Editor markdown ricco (body + commenti)
6. Milestone + viste salvate

## Decisioni trasversali

- **Timeline unica (activity feed).** Il dettaglio ticket passa da pannelli
  separati a un unico stream cronologico che fonde — a read-time — commenti,
  eventi dei job AI e voci di audit. Backing dell'audit: tabella generica
  `ticket_events`.
- **Allegati su S3-compatible, configurabile da Settings.** Credenziali cifrate
  AES-256-GCM (come gli account git). Upload attraverso il server (valida
  auth/MIME/dimensione → S3); download via URL **presigned** a breve scadenza.
  Se S3 non è configurato, gli allegati sono disattivati con un hint.
- **Ricerca: Postgres full-text** (tsvector + GIN, dizionario `english`).
- **Milestone + viste salvate**: entrambe.
- **Editor markdown**: leggero (textarea + toolbar + anteprima live che riusa il
  render markdown + sanitize-html esistente). Nessuna dipendenza pesante.
- **i18n**: tutti i testi UI nuovi passano dai cataloghi en/it (parità). I
  contenuti generati restano fuori scope.

## Modello dati (migrazioni additive, una per feature)

**Activity feed / audit:**
- `ticket_events`: `id, ticketId (FK), actorId (FK users, null=sistema),
  kind (enum: status_changed, assignee_changed, priority_changed, type_changed,
  labels_changed, milestone_changed, relation_added, relation_removed, …),
  payload jsonb (from/to, id correlati), createdAt`. Scritto nella stessa
  transazione della mutazione umana.
- Endpoint `GET /tickets/:id/activity`: fonde `comments` (first-class), eventi
  derivati dai job AI, e `ticket_events`, ordinati per `createdAt`, ogni item con
  un `kind` discriminante. La UI rende ogni tipo con la sua riga.

**Relazioni:** `ticket_links`: `sourceTicketId, targetTicketId,
kind (blocks/relates_to/parent)`. Inverse (blocked_by/child) derivate. Vincoli:
no auto-link, dedup della coppia+kind. Add/remove registrano `ticket_events`.

**Allegati:** `attachments`: `id, ticketId, commentId (null), uploaderId,
filename, mimeType, sizeBytes, storageKey, createdAt`. I byte vivono su S3; il DB
tiene solo metadati + chiave. Settings S3 in `instance_settings`: `s3Endpoint,
s3Region, s3Bucket, s3AccessKey, s3SecretKey (cifrata)`.

**Milestone:** `milestones`: `id, projectId, name, dueDate (null), createdAt`;
`tickets.milestoneId` (FK null). **Viste salvate:** `saved_views`: `id, ownerId,
name, filters jsonb (status/type/priority/assignee/milestone/q), shared bool,
createdAt`.

**Full-text:** `tickets.search_tsv tsvector` (generata/triggerata da
title+body) + indice GIN; i commenti cercati via join sul testo.

## Ordine di rilascio (per valore/dipendenze)

1. **Activity feed + audit** *(foundational)* — `ticket_events`, registrazione
   eventi nelle mutazioni umane, `GET /tickets/:id/activity`, refactor del
   dettaglio ticket in timeline unica. Sblocca la visualizzazione di relazioni e
   milestone nel feed.
2. **Relazioni tra ticket** — `ticket_links` + inverse + add/remove (eventi) +
   UI "Linked tickets" + voci nel feed.
3. **Ricerca full-text** — `search_tsv` + GIN, `q` esteso a FTS su titolo+body
   con ranking + query commenti; barra di ricerca full-text.
4. **Editor markdown ricco** *(frontend, quick win)* — componente
   `MarkdownEditor` (toolbar + anteprima) per body e commenti.
5. **Allegati (S3) + screenshot SDK** — (5a) settings S3 + interfaccia storage +
   `attachments` + upload (server→S3) + download presigned + UI; (5b) browser SDK
   cattura screenshot al `captureFeedback` → ingestion lo salva come allegato.
6. **Milestone + viste salvate** — `milestones` + `tickets.milestoneId` +
   assegnazione (evento) + filtro/board; `saved_views` + UI salva/applica.

## Per ogni feature

- TDD (unit + testcontainers per DB/route).
- E2E Playwright aggiornati se si tocca la UI dei flussi coperti (gli E2E NON
  sono in `pnpm -r test`).
- Migrazione additiva.
- Testi UI nuovi in i18n en/it (parità).
- Review spec + qualità + code review finale.
- Merge + deploy incrementale, con backup DB prima della migrazione.

## Note

- **i18n FTS:** col dizionario `english` lo stemming è inglese; i ticket italiani
  restano cercabili (match esatti) ma senza stemming italiano. Accettabile ora.
- **Activity feed:** i commenti restano nella tabella `comments` (editing,
  authorType, allegati su commento); il feed li fonde a read-time, non li copia
  in `ticket_events`.
- **Storage allegati:** interfaccia astratta con backend S3; un eventuale backend
  locale/altri provider si aggiunge senza toccare il resto.
