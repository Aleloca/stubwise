# Feature 5 — Allegati (S3) + screenshot SDK — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: superpowers:executing-plans / subagent-driven-development.

**Goal:** Permettere allegati (immagini + documenti) su ticket e commenti, salvati su storage **S3-compatible** configurabile da Settings (credenziali cifrate), con upload via server e download via URL **presigned** a breve scadenza; e far sì che il **feedback SDK** catturi automaticamente uno screenshot (html2canvas) che l'ingestion salva come allegato del ticket creato.

**Architecture:** Astrazione `ObjectStorage` (backend S3 via `@aws-sdk/client-s3` + `s3-request-presigner`) in `apps/server`. Credenziali S3 in `instance_settings` (singleton): `s3Endpoint, s3Region, s3Bucket, s3AccessKey` in chiaro + `s3SecretKeyEncrypted` cifrata con `encrypt()`/`decrypt()` di `packages/db/src/secrets.ts` (stesso pattern degli account git). Tabella `attachments` (metadati + `storageKey`; i byte vivono su S3). Upload multipart via `@fastify/multipart` (valida auth/MIME/dimensione → S3). Download tramite redirect a URL presigned. Se S3 non è configurato, gli allegati sono disattivati (la UI mostra un hint, le API rispondono con un code dedicato). L'SDK browser cattura lo screenshot con html2canvas (import dinamico lazy) e lo invia come dataURL nell'evento `feedback`; il processor di ingestion lo decodifica e lo carica come allegato (best-effort: se S3 manca o fallisce, il ticket si crea comunque).

**Decisioni (validate 2026-06-16):** tipi ammessi = immagini (png/jpeg/gif/webp), PDF, testo/log (text/plain), zip; **max 10 MB/file**. Screenshot SDK = cattura automatica html2canvas (lazy, opt-in per chiamata).

**Design:** `docs/plans/2026-06-16-stubwise-team-tracker-design.md`. **Convenzioni:** TDD, testcontainers per DB/route, migrazione additiva, i18n en/it (parità), E2E se si tocca un flusso coperto, review spec+qualità. `pnpm lint` (root) + typecheck + test + e2e prima del merge. **Nuovi package nei Dockerfile:** aggiungere eventuali nuove dipendenze NON richiede nuovi `package.json` da copiare (sono dipendenze di package esistenti), ma verifica che il build Docker di server/worker/caddy resti verde.

---

### Task 1: Schema — colonne S3 in `instance_settings` + tabella `attachments`

**Files:** `packages/db/src/schema.ts`, migrazione (`drizzle-kit generate`, verifica SQL), `packages/db/src/schema.test.ts`.

- In `instanceSettings` aggiungi colonne nullable: `s3Endpoint text`, `s3Region text`, `s3Bucket text`, `s3AccessKey text`, `s3SecretKeyEncrypted text`. Tutte additive/nullable (storage opzionale).
- Nuovo pgTable `attachments`:
  - `id uuid pk defaultRandom`,
  - `ticketId uuid notNull FK→tickets onDelete cascade`,
  - `commentId uuid FK→comments onDelete cascade` (nullable — allegato a un commento specifico oppure al ticket),
  - `uploaderId uuid FK→users onDelete set null` (nullable — null = sistema/SDK),
  - `filename text notNull`, `mimeType text notNull`, `sizeBytes integer notNull`,
  - `storageKey text notNull` (chiave oggetto su S3, univoca),
  - `createdAt timestamptz notNull defaultNow`.
  - Indici: `(ticketId, createdAt)`, `(commentId)`. Unique su `storageKey`.
- Migrazione additiva (ALTER ADD COLUMN nullable + CREATE TABLE + indici). Esegui `drizzle-kit generate`, VERIFICA il SQL (`0018_*.sql`), assicurati che un secondo `generate` non produca diff.

**Test (testcontainers):** insert/read di un attachment con tutti i campi; FK cascade dal ticket (cancellando il ticket spariscono gli allegati); FK cascade dal commento; unique su `storageKey` impedisce duplicati; le nuove colonne s3 leggibili/scrivibili sul singleton.

**Commit:** `feat(db): tabella attachments + colonne S3 in instance_settings`

---

### Task 2: Astrazione storage + client S3 (presigned)

**Files:** nuovo `apps/server/src/storage/index.ts` (interfaccia + factory), `apps/server/src/storage/s3.ts`, test `apps/server/src/storage/s3.test.ts`. `apps/server/package.json` (+ `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`).

- Interfaccia `ObjectStorage`:
  ```ts
  interface ObjectStorage {
    putObject(key: string, body: Buffer, contentType: string): Promise<void>;
    getSignedDownloadUrl(key: string, filename: string, expiresInSeconds?: number): Promise<string>;
    deleteObject(key: string): Promise<void>;
  }
  ```
- `createS3Storage(config: { endpoint; region; bucket; accessKey; secretKey })`: istanzia `S3Client` (forcePathStyle: true per compatibilità S3-like tipo Hetzner/MinIO), implementa i metodi. `getSignedDownloadUrl` usa `getSignedUrl` + `GetObjectCommand` con `ResponseContentDisposition: attachment; filename="..."` e scadenza default breve (es. 300s).
- Helper `s3ConfigFromSettings(settings, encryptionKey)`: ritorna la config decifrando `s3SecretKeyEncrypted`, oppure `null` se la configurazione è incompleta (manca endpoint/bucket/accessKey/secretKey). Questo è il punto unico per sapere se "lo storage è attivo".
- **Niente rete nei test unit**: testa `s3ConfigFromSettings` (completa→config, incompleta→null, decifra la secret) e la costruzione dei comandi/chiavi con il client S3 mockato (vi.mock di `@aws-sdk/client-s3` e del presigner). NON colpire un vero S3.

**Test:** `s3ConfigFromSettings` con settings completi → config con secret decifrata; con settings parziali → null; `putObject`/`deleteObject` invocano i comandi giusti (mock); `getSignedDownloadUrl` ritorna l'URL del presigner mockato con i parametri attesi.

**Commit:** `feat(server): astrazione ObjectStorage + backend S3 con presigned URL`

---

### Task 3: Settings S3 (route + UI) con credenziali cifrate

**Files:** `apps/server/src/routes/settings.ts`, `apps/web/src/routes/settings/` (nuovo pannello `storage.tsx` + voce nel layout), `apps/web/src/lib/api.ts`, i18n en/it, test server + web.

- **Server** — estendi GET/PUT `/api/settings/instance` (requireAdmin):
  - GET ritorna i campi S3 **mascherati**: `s3Endpoint, s3Region, s3Bucket, s3AccessKey` in chiaro + `s3SecretKeySet: boolean` (mai la secret). Aggiungi `attachmentsEnabled: boolean` (= storage configurato) così la UI/altre route lo sanno.
  - PUT accetta `s3Endpoint?, s3Region?, s3Bucket?, s3AccessKey?, s3SecretKey?` (la secret in chiaro solo in input). Se `s3SecretKey` presente e non vuota → `s3SecretKeyEncrypted = encrypt(s3SecretKey, app.encryptionKey)`; se assente → lascia invariata; stringa vuota esplicita → azzera (disabilita). Mantieni il pattern singleton upsert id=1.
  - (Opzionale, se semplice) POST `/api/settings/instance/s3/test` (requireAdmin): prova un `putObject`+`deleteObject` di un piccolo oggetto e ritorna ok/errore (code `s3_unreachable`). Utile per validare le credenziali dalla UI.
- **Web** — nuovo pannello "Storage (S3)" in Settings: form con endpoint/region/bucket/accessKey/secret (la secret è write-only: placeholder "•••• set" se già impostata, vuota = invariata), bottone Save (+ "Test connection" se implementato). Hint su cosa serve (bucket S3-compatible). Aggiungi la voce nel layout settings.
- Client `api.ts`: tipi + `getInstanceSettings()`/`updateInstanceSettings(...)` estesi (o nuovo metodo dedicato).
- i18n: tutte le stringhe nuove en/it (parità).

**Test (testcontainers + web):** PUT con s3SecretKey → la colonna è cifrata (non in chiaro) e GET ritorna `s3SecretKeySet:true` senza esporre la secret; PUT senza secret non sovrascrive quella esistente; `attachmentsEnabled` true solo con config completa; requireAdmin (401/403). Web: il pannello rende i campi, invia l'update, non mostra mai la secret salvata.

**Commit:** `feat(server,web): impostazioni storage S3 con secret cifrata`

---

### Task 4: Endpoint allegati — upload / download / delete

**Files:** `apps/server/src/routes/attachments.ts` (nuovo, registrato in app), `apps/server/src/app.ts` (registra `@fastify/multipart` + storage sul context), `apps/web/src/lib/api.ts`, test `attachments.test.ts`. `apps/server/package.json` (+ `@fastify/multipart`).

- Registra `@fastify/multipart` con `limits: { fileSize: 10 * 1024 * 1024, files: 1 }`. MIME ammessi (allowlist): `image/png, image/jpeg, image/gif, image/webp, application/pdf, text/plain, application/zip`.
- **POST `/api/tickets/:id/attachments`** (requireAuth, multipart):
  - 404 se ticket inesistente; 409/400 (`storage_not_configured`) se storage non attivo;
  - leggi il file; 400 (`unsupported_type`) se MIME non in allowlist; 413/400 (`file_too_large`) se supera 10 MB (gestisci l'errore di limite di multipart);
  - genera `storageKey` (es. `tickets/{ticketId}/{uuid}/{filename-sanificato}`); `putObject` su S3; INSERT in `attachments` (uploaderId = request.user.id, opzionale `commentId` da query/field se allegato a un commento); 201 con i metadati (id, filename, mimeType, sizeBytes, createdAt, downloadUrl o solo id).
  - In transazione concettuale: se l'INSERT DB fallisce dopo il put, prova `deleteObject` (best-effort) per non lasciare orfani.
- **GET `/api/tickets/:id/attachments`** (requireAuth): lista metadati allegati del ticket (inclusi quelli legati ai suoi commenti), ognuno con un `downloadUrl` presigned generato al volo (scadenza breve). 404 se ticket assente.
- **GET `/api/attachments/:attachmentId/download`** (requireAuth): risolve l'allegato, verifica che l'utente possa vedere il ticket, **302 redirect** all'URL presigned (oppure ritorna `{ url }` — scegli redirect per semplicità d'uso nei tag `<a>`/`<img>`). 404 se assente.
- **DELETE `/api/attachments/:attachmentId`** (requireAuth): 404 se assente; `deleteObject` su S3 + DELETE riga DB; 204. (Permesso: uploader o admin — mantieni semplice: requireAuth + uploader/admin.)
- Client `api.ts`: `uploadAttachment(ticketId, file, opts?)`, `getTicketAttachments(ticketId)`, `deleteAttachment(id)`, helper URL download.
- Mocka `ObjectStorage` nei test (niente vero S3): verifica il flusso completo (put chiamato, riga creata, presigned generato), gli errori (storage off, MIME non valido, troppo grande), download redirect, delete (storage.delete + riga rimossa), auth.

**Commit:** `feat(server): endpoint upload/download/delete allegati`

---

### Task 5: UI allegati — composer commenti + nuovo ticket + render nel feed

**Files:** `apps/web/src/components/attachment-upload.tsx` (nuovo), `apps/web/src/components/attachment-list.tsx` (nuovo), `apps/web/src/components/activity-feed.tsx`, `apps/web/src/components/new-ticket-dialog.tsx`, `apps/web/src/routes/tickets/$id.tsx`, `apps/web/src/lib/queries.ts`, i18n en/it, test (+ E2E se tocchi i flussi coperti).

- `AttachmentUpload`: input file (accept = allowlist), valida dimensione/tipo lato client (hint immediato), chiama `uploadAttachment`, mostra stato (loading/errore). Disabilitato con tooltip/hint se `attachmentsEnabled` è false (leggi da instance settings query).
- `AttachmentList`: rende gli allegati di un ticket/commento (anteprima per immagini via `<img src=downloadUrl>`, icona+nome+size per gli altri, link download), con bottone "remove" (uploader/admin) → `deleteAttachment`.
- **Composer commenti** (activity-feed): accanto al MarkdownEditor, area allegati (carica prima/dopo aver creato il commento — semplice v1: l'upload è legato al ticket; opzionale legarlo al commento appena creato). Mostra gli allegati nelle righe `comment`/`ticket` del feed via `AttachmentList`.
- **Nuovo ticket** (new-ticket-dialog): permetti di allegare file alla creazione (upload dopo che il ticket esiste, o accumula e carica al submit — scegli il più semplice e coerente con l'API per-ticket; documenta la scelta).
- Invalidazioni: upload/delete invalidano `getTicketAttachments(id)` (+ activity se gli allegati compaiono nel feed).
- `attachmentsEnabled`: leggi dalle instance settings; se off, niente UI di upload (solo hint per admin "configura lo storage in Settings").
- i18n en/it (parità) per tutte le stringhe nuove.

**Test web:** AttachmentUpload valida tipo/size e chiama l'API (mock); AttachmentList rende immagini vs file generici e il delete; UI nascosta/hint quando `attachmentsEnabled=false`. **E2E:** se aggiungi l'upload ai flussi di `core-flows.spec.ts`, mantienilo verde con un file fittizio; altrimenti assicurati che i flussi esistenti restino verdi.

**Commit:** `feat(web): UI allegati (upload + lista + render nel feed)`

---

### Task 6: SDK — screenshot html2canvas + ingestion lo salva come allegato

**Files:** `packages/sdk/src/core/client.ts`, `packages/sdk/src/browser.ts`, `packages/sdk/src/core/transport.ts` (se serve), `packages/shared` (schema evento feedback), `apps/server/src/ingest/processor.ts`, `apps/server/src/routes/ingest.ts` (schema), test SDK + server. `packages/sdk/package.json` (+ `html2canvas` come dependency).

- **Shared schema:** estendi l'evento `feedback` con `screenshot?: string` (dataURL `data:image/...;base64,...`). Mantieni retro-compatibilità (campo opzionale).
- **SDK `captureFeedback`:** firma estesa `captureFeedback({ message, email?, url?, screenshot?: boolean })`. Se `screenshot === true`: **import dinamico** `await import("html2canvas")`, cattura `document.body` (o `documentElement`), converti in dataURL JPEG qualità ridotta (es. 0.7) per contenere la dimensione, e includilo nell'evento. Tutto in `safely(...)`/try-catch: se html2canvas fallisce o non è disponibile, invia il feedback **senza** screenshot (mai rompere l'app host). Poiché `captureFeedback` oggi è sincrono e fa `enqueue`, gestisci l'asincronia internamente (cattura poi enqueue; la firma pubblica resta void/fire-and-forget).
- **Bundle:** html2canvas come `dependencies` ma caricato solo via dynamic import → non entra nel bundle base di chi non usa lo screenshot (verifica che il build SDK `tsc` non lo importi staticamente). Documenta che lo screenshot richiede html2canvas disponibile a runtime.
- **Ingestion processor:** quando crea un ticket da un evento `feedback` con `screenshot`: se lo storage S3 è configurato, decodifica il dataURL (valida che sia un'immagine ammessa e < 10 MB), `putObject` + INSERT `attachments` (ticketId del ticket creato, uploaderId null, filename es. `feedback-screenshot.jpg`). Best-effort: se lo storage manca o l'upload fallisce, logga e prosegui (il ticket si crea comunque). 422 dell'ingest resta solo per payload malformati.
- **Test:** SDK — `captureFeedback({screenshot:true})` con html2canvas mockato include il dataURL nell'evento; fallimento di html2canvas → evento senza screenshot, nessuna eccezione propagata; `screenshot` assente/false → comportamento attuale. Server — evento feedback con screenshot + storage configurato (storage mockato) → ticket creato + 1 attachment; senza storage → ticket creato, 0 attachment, nessun errore; dataURL non-immagine/troppo grande → ignorato, ticket creato.

**Commit:** `feat(sdk,server): screenshot automatico nel feedback SDK salvato come allegato`

---

### Task 7: Docs + verifica finale

**Files:** `apps/docs/.../getting-started/` (configurazione storage S3 in Settings; allegati su ticket/commenti; nota SDK screenshot e requisito html2canvas), in inglese. `pnpm --filter @stubwise/docs build`.

**Verifica finale:** `pnpm lint` (root), `pnpm -r typecheck`, `pnpm -r test`, `pnpm --filter @stubwise/web e2e`, `pnpm -r build`. Code review finale vs design. **Deploy:** backup DB, migrazione additiva 0018, **nuove dipendenze** (`@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `@fastify/multipart` su server; `html2canvas` su sdk) → verifica che i build Docker di server/worker/caddy restino verdi; rebuild server+worker+caddy; verifica `/health`, colonne/tabella applicate, CI verde. **Env/infra:** nessuna nuova env obbligatoria (lo storage si configura da Settings); le credenziali S3 reali si inseriscono dalla UI dopo il deploy.

**Commit:** `docs: allegati S3 + screenshot SDK`

---

## Note / follow-up (NON in questa v1)
- **Antivirus/scan** dei file caricati: fuori scope; allowlist MIME + limite dimensione come prima barriera.
- **Quota storage per progetto/istanza:** non in v1 (allineato al budget AI ma separato).
- **Backend storage non-S3** (locale/filesystem): l'interfaccia `ObjectStorage` lo permette in futuro senza toccare le route.
- **Deduplica** screenshot/allegati identici: non in v1.
