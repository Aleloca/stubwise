# Integrazione area 9, F3 — lato renderer (94)

Design: `docs/plans/2026-11-16-integrazione-area9-design.md` §3 (F3 —
istanza), decisioni di 46 H-1…H-4 = a. Rotte di 72: `feat/area9-f3`
(91a5d1596, `/api/settings/webhooks`). Branch: `feat/area9-f3-renderer`.

Il prototipo resta la specifica: si cambia PRIMA lui, poi si collega l'app.

## P1 — I webhook in uscita come elenco (prototipo, dati)

- Lo stato: `state.instance.webhooks: OutgoingWebhook[]` al posto del
  webhook singolo; ognuno `{ id, name, url, format, enabled, events[],
  secretId, secretRotatedAt, createdAt, lastTest }`. Il seme migra quello
  di oggi: «Webhook», stessi formato, stato ed eventi, un segreto che
  nessuno ha visto (come la migrazione del server).
- Il permesso: `integrations.manage` (H-1), in lettura e scrittura; la voce
  «Outgoing webhooks» la vede chi ce l'ha (`adminSections.ts`).
- Le funzioni, sulla forma delle rotte:
  - `listWebhooks()` → le viste, con `secretSet`/`secretRotatedAt`, mai il segreto;
  - `createWebhook({ name, url, format, enabled?, events })`, con
    riconferma, al più 20 (`webhook_limit`), URL https, eventi del
    catalogo: la vista più `secret`, l'unica volta;
  - `updateWebhook(id, patch)`, senza riconferma;
  - `regenerateWebhookSecret(id)`, con riconferma: il segreto nuovo, una volta;
  - `deleteWebhook(id)`, con riconferma;
  - `testWebhook(id)`: anche su un webhook spento;
  - `previewWebhook(event, format)` resta.
- Il segreto passa da `admin/secrets.ts` (kind `outgoing_webhook_secret`,
  32 byte base64url come sul server), come gli altri generati.
- Il registro (H-3): `webhook.created`, `webhook.updated`,
  `webhook.secret_replaced`, `webhook.deleted` al posto di
  `webhook.changed`, coi template en/it; il prima/dopo di `updated` coi soli
  campi cambiati (l'URL compreso, non è un segreto); `secret_replaced` senza
  valori. Il link della voce porta al webhook se c'è ancora.
- Il formato `generic` si chiama «JSON» (H-2).
- Claude (area 10a, classe B «webhook (senza segreto)»): `saveWebhook`
  diventa `updateWebhook` su un webhook esistente, annullabile. Creare,
  rigenerare il segreto ed eliminare non passano da Claude.

## P2 — La pagina (prototipo, UI)

- `/admin/webhooks`: l'elenco (nome, formato, indirizzo, quanti eventi,
  acceso o spento, ultima prova), «New webhook» (spento a 20, col motivo).
- `/admin/webhooks/$webhookId` (e `new`): il modulo di oggi più il nome, la
  sezione del segreto («Set · regenerated Oct 28», «Regenerate secret» con
  riconferma), «Delete webhook» con riconferma; il segreto nuovo in un
  dialogo che si vede una volta (come il PAT).
- L'anteprima per formato ed evento resta a destra.

## P3 — La parità del catalogo con i tipi della 9b

`catalogParity.test.ts` copre anche `INSTANCE_CHANGE_TYPES`: ogni tipo
d'istanza del server c'è nel prototipo con scope, gruppo e permesso di
lettura, e ha la frase in en e it.

## P4 — Il collegamento (quando arriva il client di 72, Task 8)

L'adattatore `data/backend/real/webhooks.ts` sulle rotte, i test dei
percorsi veri, l'accensione di `admin:webhooks` con INTEGRATED_CALLS.
