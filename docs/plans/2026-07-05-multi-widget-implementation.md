# Multi-widget per progetto — Piano di implementazione

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Più widget customer service per progetto, ognuno con chiave, whitelist repo, aspetto e cap giornalieri propri; conversazioni e ticket attribuiti al widget di provenienza.

**Architecture:** La tabella `widgets` (n per progetto, chiave unica per-widget) sostituisce `widget_settings` (1:1). La superficie pubblica `/widget/:slug/*` risolve il widget dalla chiave (timing-safe contro le chiavi dei widget del progetto) e ne usa config/whitelist/cap; le conversazioni portano `widgetId` (SET NULL alla cancellazione). API interna nuova CRUD `/api/projects/:projectId/widgets` al posto di GET/PUT widget-settings. Il client `packages/widget` NON cambia.

**Tech Stack:** Fastify + Zod, Drizzle/Postgres (testcontainers), React SPA (TanStack Router/Query), i18next.

**Design di riferimento:** `docs/plans/2026-07-05-multi-widget-design.md`. Feature base: `docs/plans/2026-07-05-widget-customer-service-design.md` (deployata, commit fino a `c40a8c0`).

**Regole trasversali:**
- TDD: test prima, rosso, implementazione, verde, commit. Commit con `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` in coda.
- Test server: `pnpm --filter @stubwise/server exec vitest run src/routes/<file>.test.ts` (testcontainers, beforeAll 120s normale).
- Dopo ogni task che tocca `packages/shared` o `packages/db`: rebuild (`pnpm --filter @stubwise/<pkg> build`) e `pnpm typecheck` DALLA RADICE del worktree (trappola: lanciato dal checkout principale risolve i file sbagliati).
- Stringhe SPA in ENTRAMBI `apps/web/src/i18n/locales/en.json` e `it.json` (parity test).
- `pnpm lint` (root) nel task finale.

---

### Task 1: Schemi shared

**Files:**
- Modify: `packages/shared/src/schemas/widget.ts`
- Test: `packages/shared/src/schemas/widget.test.ts` (estendi)

**Step 1: test fallente.** Aggiungi al describe esistente:

```ts
it("widget upsert richiede il nome e accetta cap nullable", () => {
  const parsed = widgetUpsertBodySchema.parse({ name: "Webapp" });
  expect(parsed.name).toBe("Webapp");
  expect(parsed.dailyMessageCap).toBeNull();
  expect(parsed.dailyTicketCap).toBeNull();
  expect(parsed.enabled).toBe(false); // eredita i default di widgetSettingsSchema
  expect(() => widgetUpsertBodySchema.parse({})).toThrow(); // name mancante
  expect(() => widgetUpsertBodySchema.parse({ name: "x", dailyMessageCap: 0 })).toThrow(); // min 1
  expect(widgetUpsertBodySchema.parse({ name: "x", dailyMessageCap: 500 }).dailyMessageCap).toBe(500);
});
```

**Step 2:** `pnpm --filter @stubwise/shared exec vitest run src/schemas/widget.test.ts` → FAIL.

**Step 3: implementazione.** In `widget.ts`, dopo `widgetSettingsSchema`:

```ts
/** Cap giornaliero per-widget: null = usa il default d'istanza (env). */
const dailyCapSchema = z.number().int().min(1).max(100_000).nullable().default(null);

/** Body di create/update di un widget (API interna). Estende la config con identità e cap. */
export const widgetUpsertBodySchema = widgetSettingsSchema.extend({
  name: z.string().min(1).max(80),
  dailyMessageCap: dailyCapSchema,
  dailyTicketCap: dailyCapSchema,
});
export type WidgetUpsertBody = z.infer<typeof widgetUpsertBodySchema>;
```

NON toccare `widgetSettingsSchema` (resta la base condivisa), né gli altri schemi (conversation/message/ticket sono invariati).

**Step 4:** test → PASS (tutti, anche i preesistenti). **Step 5:** `pnpm --filter @stubwise/shared build && pnpm typecheck` (radice worktree) → verdi. Commit `feat(shared): schema upsert widget con nome e cap`.

---

### Task 2: DB — tabella `widgets`, `widgetId` sulle conversazioni, migrazione con data migration

Il task più delicato: drizzle-kit genera solo il DDL, la **data migration va inserita a mano** nel file SQL generato.

**Files:**
- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/drizzle/0041_multi_widget.sql` (generata + editata)
- Test: `packages/db/src/widget-schema.test.ts` (riscrivi per il nuovo modello) + Create: `packages/db/src/migration-0041.test.ts`

**Step 1 — schema.** In `schema.ts`:
- Nuova tabella `widgets` (mettila dove ora c'è `widgetSettings`):

```ts
export const widgets = pgTable("widgets", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  key: text("key").notNull().unique(),
  enabled: boolean("enabled").notNull().default(false),
  enabledRepositoryIds: jsonb("enabled_repository_ids").$type<string[]>().notNull().default([]),
  title: text("title").notNull().default("Assistenza"),
  welcomeMessage: text("welcome_message").notNull().default("Ciao! Come posso aiutarti?"),
  accentColor: text("accent_color").notNull().default("#22c55e"),
  language: text("language").notNull().default("it"),
  dailyMessageCap: integer("daily_message_cap"),
  dailyTicketCap: integer("daily_ticket_cap"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("widgets_project_idx").on(t.projectId)]);
```

- RIMUOVI `widgetSettings`.
- In `widgetConversations` aggiungi:

```ts
widgetId: uuid("widget_id").references(() => widgets.id, { onDelete: "set null" }),
```

(Segui lo stile del file: JSDoc in italiano che spiega SET NULL = "il widget si elimina, lo storico resta".)

**Step 2 — genera e EDITA la migrazione.** `cd packages/db && npx drizzle-kit generate --name multi_widget`. Il file generato avrà CREATE TABLE widgets / ALTER widget_conversations ADD widget_id / DROP widget_settings (l'ordine può variare). **Riordina/edita** così (statement separati da `--> statement-breakpoint` come le migrazioni esistenti):

1. `CREATE TABLE "widgets" ...` (+ FK, unique, index)
2. `ALTER TABLE "widget_conversations" ADD COLUMN "widget_id" uuid;` (+ FK SET NULL)
3. **Data migration (a mano):**

```sql
INSERT INTO "widgets" ("project_id", "name", "key", "enabled", "enabled_repository_ids", "title", "welcome_message", "accent_color", "language")
SELECT "project_id", 'Widget', replace(gen_random_uuid()::text, '-', ''), "enabled", "enabled_repository_ids", "title", "welcome_message", "accent_color", "language"
FROM "widget_settings";--> statement-breakpoint
UPDATE "widget_conversations" c SET "widget_id" = w."id" FROM "widgets" w WHERE w."project_id" = c."project_id";--> statement-breakpoint
```

4. `DROP TABLE "widget_settings";`

Note: nessun nuovo valore enum → nessuna trappola batch; `gen_random_uuid()` è core da PG13. ⚠️ Se drizzle-kit chiede interattivamente "create or rename?" per widget_settings→widgets, scegli CREATE nuova + DROP (non rename: le colonne divergono e la data migration è esplicita). Se l'edit manuale del file confligge con lo snapshot (drizzle-kit valida solo lo schema TS, non il contenuto SQL), va bene: lo snapshot riflette lo schema finale.

**Step 3 — test migrazione** (`migration-0041.test.ts`, modello: guarda `migration-0036.test.ts` se applica migrazioni parziali; altrimenti approccio semplice): con `startTestDb` (che applica TUTTE le migrazioni) non puoi testare la data migration su dati pre-esistenti. Approccio: guarda come fa `migration-0036.test.ts` — se esiste un helper per fermarsi a una migrazione N, seedare e proseguire, usalo; ALTRIMENTI testa la data migration manualmente: container Postgres pulito, applica migrazioni fino a 0040 (`migrate` con folder filtrata o applicando i file in sequenza), inserisci una riga `widget_settings` + una conversazione, applica 0041, verifica: widget creato con name='Widget', key 32 hex, config copiata; conversazione con widget_id valorizzato; widget_settings sparita.

**Step 4 — riscrivi `widget-schema.test.ts`**: insert `widgets` (due per lo stesso progetto!), conversazione con `widgetId`, delete widget → `widgetId` null e messaggi intatti, unique sulla key (insert duplicata → throw). Mantieni i test esistenti su messaggi/ticket adattandoli.

**Step 5:** test db verdi (`pnpm --filter @stubwise/db exec vitest run src/widget-schema.test.ts src/migration-0041.test.ts src/schema.test.ts`), `pnpm --filter @stubwise/db build`. ⚠️ Il typecheck di server/web ORA È ROSSO (widgetSettings sparita, usata da widget.ts/widget-settings.ts): è atteso, i task 3-5 lo sistemano — NON tentare di sistemarli in questo task. Commit `feat(db): tabella widgets multi-widget e migrazione dati`.

---

### Task 3: Server — auth per chiave widget + config + conversazioni

**Files:**
- Modify: `apps/server/src/routes/widget.ts`
- Test: `apps/server/src/routes/widget.test.ts` (adatta il setup + estendi)

**3a — auth.** In `authenticateWidget`: lookup progetto per slug (come oggi) POI carica i widget del progetto (`select id, key, ... from widgets where project_id = ...`) e trova il match con `keysMatch(provided, w.key)` iterando su TUTTI i widget (niente early-exit sul primo mismatch non serve: `keysMatch` è già timing-safe per confronto singolo; l'iterazione è bounded e il 401 resta indistinguibile). Match → `request.widget = <riga completa>` (aggiorna la module augmentation: sostituisci/estendi `widgetProject` con `widget: WidgetRow & { projectId }`; conserva ciò che serve agli handler). Nessun match / slug inesistente / header assente → 401 `invalid_ingestion_key` identico a oggi.

**3b — config.** `GET /:slug/config`: elimina `loadEnabledSettings` (la config è `request.widget`); `widget.enabled === false` → `{ enabled: false }`; altrimenti stessi campi di oggi presi dal widget. `chatEnabled` invariato (guard try/catch su `isAvailable` + `enabledRepositoryIds.length > 0`). Cache-control no-store invariato.

**3c — conversazioni.** `POST /conversations`: crea con `widgetId: request.widget.id`. `GET /:conversationId/messages`: ownership diventa `projectId` match **E `widgetId === request.widget.id`** E `externalUserId === userId` → 404 indistinguibile (una chiave non legge i fili di un altro widget, né quelli orfani di un widget eliminato). Il check `enabled` resta su ogni endpoint (`request.widget.enabled` → 404 `widget_disabled`).

**Test (adatta il setup):** il helper del test che oggi fa upsert su `widget_settings` diventa un helper `seedWidget(db, projectId, overrides)` che inserisce in `widgets` e ritorna la riga (con key). Aggiorna TUTTI i test esistenti a usare la chiave del widget (non più ingestionKey) — è il grosso del lavoro. Test nuovi:
1. ingestionKey del progetto sulla superficie widget → 401 (breaking intenzionale).
2. Due widget nello stesso progetto: chiave di A su conversazione di B → 404; config di A ≠ config di B.
3. Widget eliminato: la sua chiave → 401; la conversazione orfana (widgetId null) non è leggibile da nessuna chiave.
4. Tutti i 401/404/CORS esistenti restano verdi.

Commit `feat(server): auth per chiave widget e conversazioni per-widget`.

---

### Task 4: Server — messaggi e ticket per-widget (cap con override)

**Files:**
- Modify: `apps/server/src/routes/widget.ts` (+ `apps/server/src/routes/widget-chat.ts` solo se serve la firma)
- Test: `apps/server/src/routes/widget.test.ts` (estendi)

1. `POST .../messages`: whitelist = `request.widget.enabledRepositoryIds` (il check `length === 0 → 404 widget_disabled` resta); **cap** = `request.widget.dailyMessageCap ?? opts.dailyMessageCap` e il count filtra le conversazioni per `widgetId = request.widget.id` (mantieni il filtro `lastMessageAt >= dayStart` per l'indice). System prompt: lingua dal widget.
2. `POST .../tickets`: cap = `request.widget.dailyTicketCap ?? opts.dailyTicketCap`, conteggio per widget: i ticket non hanno widgetId → conta i **messaggi di conferma di oggi** (`widget_messages` con `ticketId not null` e conversazione del widget) invece dei ticket — stessa informazione, già indicizzata. In `composeWidgetTicketBody`: nel blocco identità aggiungi la riga "Widget: <nome>" (it) / "Widget: <name>" (en), passando `request.widget.name`.
3. Le opzioni del plugin (`dailyMessageCap`/`dailyTicketCap` da app.ts) restano e diventano i default d'istanza — nessun cambio a config.ts/env.

**Test:** cap per-widget: widget con `dailyMessageCap: 1` → secondo messaggio 429, mentre un ALTRO widget dello stesso progetto continua a rispondere (isolamento); widget con cap null → vale il default del plugin (istanzia `buildApp` con cap basso come fa il test esistente); stesso schema per il cap ticket; body ticket contiene "Widget: <nome>"; retrieval filtrato sulla whitelist del widget giusto (2 widget con whitelist diverse → citazioni diverse).

Commit `feat(server): cap e whitelist per-widget su messaggi e ticket`.

---

### Task 5: Server — CRUD interno `/api/projects/:projectId/widgets`

**Files:**
- Modify: `apps/server/src/routes/widget-settings.ts` → rinomina con `git mv` in `apps/server/src/routes/widget-admin.ts` (aggiorna l'import in `app.ts`; il plugin export può restare `widgetSettingsRoutes` → rinominalo `widgetAdminRoutes`)
- Test: `git mv` di `widget-settings.test.ts` → `widget-admin.test.ts` (adatta)

RIMUOVI `GET/PUT /:projectId/widget-settings`. Aggiungi (stesso prefix `/api/projects`):
- `GET /:projectId/widgets` (requireAuth): lista per progetto ordinata per createdAt asc: `{ widgets: [{ id, name, key, enabled, enabledRepositoryIds, title, welcomeMessage, accentColor, language, dailyMessageCap, dailyTicketCap, createdAt, conversationCount }] }` — `conversationCount` aggregato in una query (LEFT JOIN + GROUP BY, pattern del viewer). La key È esposta qui (serve per lo snippet; superficie interna autenticata).
- `POST /:projectId/widgets` (requireAdmin): body `widgetUpsertBodySchema`; key generata con `generateIngestionKey()` da `./shared.js`; validazione 422 repo come la vecchia PUT; 404 progetto inesistente → `{ widget }` completo.
- `PUT /:projectId/widgets/:widgetId` (requireAdmin): body `widgetUpsertBodySchema` (PUT completo, key NON modificabile); 404 se il widget non è del progetto; stessa validazione repo.
- `DELETE /:projectId/widgets/:widgetId` (requireAdmin): 404 se non del progetto; delete (FK fa SET NULL sulle conversazioni) → 204.

**Test (adatta i vecchi):** i test GET/PUT widget-settings si trasformano nei test CRUD: 401 no auth, 403 member su POST/PUT/DELETE, lista vuota → `[]`, create con default+key 32hex, create+update riflesso, 422 repo altrui, 404 widget di altro progetto su PUT/DELETE, delete → conversazioni con widgetId null (verifica in DB), conversationCount corretto. I test del viewer conversazioni nello stesso file restano (li tocchi al Task 6).

⚠️ Dopo questo task il typecheck root deve tornare VERDE (web si sistema nei task 7-8 — se `apps/web` usa ancora getWidgetSettings rotto, il typecheck web sarà rosso: verifica e in tal caso annota nel report che è atteso fino al Task 7).

Commit `feat(server): CRUD widget per progetto al posto di widget-settings`.

---

### Task 6: Server — viewer conversazioni con widget

**Files:**
- Modify: `apps/server/src/routes/widget-admin.ts`
- Test: `apps/server/src/routes/widget-admin.test.ts` (estendi)

- Lista conversazioni: aggiungi `widgetId` e `widgetName` (LEFT JOIN su widgets; null → entrambi null) alla proiezione; nuovo query param `widgetId: z.uuid().optional()` che filtra (`eq(widgetConversations.widgetId, widgetId)`); componibile con `ticketId`.
- Dettaglio messaggi: aggiungi `widgetName` (nullable) all'oggetto `conversation`.

**Test:** lista con conversazioni di 2 widget → widgetName giusti; filtro widgetId; conversazione orfana → widgetName null; combinazione widgetId+ticketId.

Commit `feat(server): viewer conversazioni con nome e filtro widget`.

---

### Task 7: SPA — lista + editor widget

**Files:**
- Modify: `apps/web/src/lib/api.ts` (rimuovi getWidgetSettings/putWidgetSettings; aggiungi `getWidgets`, `createWidget`, `updateWidget`, `deleteWidget` + tipo `Widget`)
- Modify: `apps/web/src/lib/queries.ts` (`widgetsQueryOptions(projectId)` al posto di widgetSettingsQueryOptions)
- Modify: `apps/web/src/components/widget-settings-section.tsx` → `git mv` in `widgets-section.tsx` e riscrivi: lista + editor
- Modify: `apps/web/src/routes/projects/$projectId.tsx` (aggiorna import/uso)
- Modify: locales en/it (namespace `widget`)
- Test: `git mv` del test → `widgets-section.test.tsx`, riscrivi

**UI:** lista di card (nome, badge attivo/spento, `conversationCount`, bottone modifica) + "Nuovo widget" (admin). Editor (inline sotto la card o pannello): il form del Task 11 originale + campo **nome** + due input numerici **cap** (vuoto = default d'istanza, placeholder "default: 200"/"default: 50" — hardcoda i default nel placeholder i18n, la SPA non conosce le env) + snippet precompilato **con la chiave del widget** (riusa la costruzione DSN esistente sostituendo ingestionKey con widget.key) + bottone elimina con `confirm()` due-step come la danger zone (testo: "le conversazioni restano, lo snippet installato smette di funzionare"). Member: sola lettura come oggi.

**Test:** lista con 2 widget; create chiama createWidget col payload; editor precompila e updateWidget col body completo; snippet contiene la key del widget (non la ingestionKey); delete con conferma chiama deleteWidget; member read-only.

Commit `feat(web): lista ed editor multi-widget con snippet per chiave`.

---

### Task 8: SPA — conversazioni con badge e filtro widget

**Files:**
- Modify: `apps/web/src/lib/api.ts` (tipi conversazioni: + widgetId/widgetName; param widgetId) + `queries.ts`
- Modify: `apps/web/src/routes/projects/widget-conversations.tsx`
- Modify: locales en/it
- Test: `apps/web/src/routes/projects/widget-conversations.test.tsx` (estendi)

Badge col `widgetName` (o "widget eliminato" i18n se null) su ogni riga della lista e nell'header del dettaglio; select di filtro in testa alla lista (opzioni da `widgetsQueryOptions`, "tutti i widget" default) che setta il param `widgetId` (aggiungilo a `validateSearch` + `loaderDeps` come `ticketId`).

**Test:** badge visibile; filtro seleziona → query con widgetId (assert sull'URL fetchato, pattern del test ticketId esistente); conversazione orfana mostra "widget eliminato".

Commit `feat(web): filtro e badge widget nel viewer conversazioni`.

---

### Task 9: Guida + verifica finale

**Files:**
- Modify: `apps/docs/src/content/docs/integrations/widget.md`

1. Aggiorna la guida: più widget per progetto (esempio webapp/admin), chiave per-widget nello snippet (copiata dall'editor del widget), cap configurabili da UI per widget (env = default d'istanza), delete conserva le conversazioni. `pnpm --filter @stubwise/docs build` verde.
2. Verifica finale dalla radice del worktree: `pnpm build`, `pnpm typecheck`, `pnpm test`, `pnpm lint` — TUTTI verdi.
3. Commit `docs: guida multi-widget` + eventuale commit fix.

**Fuori scope (non implementare):** rotazione chiave, cap aggiuntivo a livello progetto, statistiche per widget, HMAC.
