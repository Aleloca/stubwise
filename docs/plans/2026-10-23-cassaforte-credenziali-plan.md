# Cassaforte delle credenziali — piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** credenziali di progetto in Stubwise con la sola password cifrata
end-to-end nel browser, lettori per credenziale (persone, ruoli, full
admin), sblocco con passkey (PRF), conferma umana degli accessi in attesa,
inserimento via API cifrato dal client e kit di recupero.

**Architecture:** un pacchetto puro `@stubwise/vault-crypto` (WebCrypto,
browser e Node ≥ 22) fa tutta la crittografia; il server conserva solo
cifrati, chiavi pubbliche e liste di lettori, e decide CHI può fare cosa
(permessi, lettori, conferme) senza mai poter decifrare. La web tiene la
chiave privata solo in memoria; lo sblocco è un'asserzione passkey con
estensione PRF che passa dalle rotte di riconferma della fase 2.

**Tech Stack:** WebCrypto (ECDH P-256, HKDF-SHA-256, AES-256-GCM),
`@simplewebauthn/server` + `@simplewebauthn/browser` (PRF), Fastify + Zod +
Drizzle, React + TanStack, Vitest, Playwright (autenticatore virtuale).

**Spec:** `docs/plans/2026-10-23-cassaforte-credenziali-design.md`

## Global Constraints

- Solo il campo **password** è cifrato; `service`, `label`, `url`, `username`, `notes` in chiaro.
- Il server non riceve MAI una password in chiaro né una chiave privata in chiaro (né via web né via API).
- Primitive: ECDH P-256 (chiavi di persona e di recupero, wrapping con chiave effimera), HKDF-SHA-256, AES-256-GCM con IV casuale di 12 byte. Nessun'altra primitiva.
- Ogni password cifrata ha come AAD l'id della credenziale; ogni copia della chiave ha come AAD `credentialId + ":" + recipientId` (id della chiave di persona o `"recovery"`).
- PRF: input fisso `SHA-256("stubwise/vault/v1/prf")`; chiave di sblocco = HKDF(PRF output, salt vuoto, info `"stubwise/vault/v1/unlock"`).
- Formato dei dati cifrati: JSON con campo `v: 1` e campi binari in base64url.
- Permessi di progetto nuovi: `credentials.create`, `credentials.edit`, `credentials.share`; preset: solo `project_lead` (e i full admin, implicitamente); esclusi da `developer`, `legacy_member`, `viewer`, `contributor`.
- Cassaforte aperta: chiusura dopo **15 minuti** di inattività, alla chiusura della scheda e al logout; chiave privata solo in memoria (mai storage del browser).
- Appunti cancellati dopo **30 secondi**.
- Per condividere servono `credentials.share` **e** essere lettori. Accessi in attesa: SEMPRE conferma umana (lettore con `credentials.share`, o full admin), mai automatica.
- Un token personale (PAT) può creare credenziali e sostituire password; non può MAI scaricare una copia della chiave, condividere, confermare, attivare o usare il recupero (403 `session_required`).
- Le tabelle della cassaforte non sono lette da worker, ricerca, embedding, chat, grafo, MCP, notifiche (salvo gli avvisi di sicurezza, che non contengono campi delle credenziali), webhook.
- Migrazioni: **0103** (permessi nei preset), **0104** (tabelle della cassaforte).
- Messaggi di commit in italiano, chiusi da `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. `pnpm lint` verde prima di chiudere ogni task.

## Review Focus

1. **Lettore di un ruolo tolto dal progetto**: perde la lettura subito (reveal → 404) anche se la sua copia della chiave è ancora in DB — Task 3 e 6.
2. **Creazione via PAT con un insieme di destinatari non aggiornato** (un admin aggiunto nel frattempo): 409 `recipients_changed`, nessuna riga scritta — Task 6.
3. **Chiave di persona ricreata**: le copie della chiave vecchia non valgono più, tutte le sue credenziali tornano «in attesa» e serve una conferma — Task 5 e 7.
4. **Copia della chiave incollata su un'altra credenziale** (AAD): la decifratura fallisce — Task 1.
5. **Passkey senza PRF**: lo sblocco non parte, la web lo dice e non crea chiavi inutilizzabili — Task 9.

---

### Task 1: Pacchetto `@stubwise/vault-crypto`

**Files:**
- Create: `packages/vault-crypto/{package.json,tsconfig.json,tsconfig.build.json,vitest.config.ts}`, `packages/vault-crypto/src/{index.ts,encoding.ts,keys.ts,items.ts,recovery.ts}` (+ `.test.ts` per ciascuno)

**Interfaces (Produces):**
- `generatePersonKeyPair(): Promise<{ publicKey: string; privateKey: CryptoKey; privateKeyPkcs8: Uint8Array }>` (pubblica = JWK serializzato).
- `PRF_INPUT: Uint8Array` (= SHA-256 dell'etichetta in Global Constraints, precalcolato e testato).
- `sealPrivateKey(prfOutput: ArrayBuffer, pkcs8: Uint8Array): Promise<string>`; `openPrivateKey(prfOutput: ArrayBuffer, sealed: string): Promise<CryptoKey>`.
- `encryptPassword(credentialId: string, password: string): Promise<{ ciphertext: string; itemKey: CryptoKey }>`; `decryptPassword(credentialId: string, ciphertext: string, itemKey: CryptoKey): Promise<string>`.
- `wrapItemKey(itemKey: CryptoKey, recipientPublicKey: string, credentialId: string, recipientId: string): Promise<string>`; `unwrapItemKey(wrapped: string, privateKey: CryptoKey, credentialId: string, recipientId: string): Promise<CryptoKey>`.
- `encryptForInsert(input: { credentialId: string; password: string; recipients: Array<{ recipientId: string; publicKey: string }> }): Promise<{ passwordCiphertext: string; copies: Array<{ recipientId: string; wrappedKey: string }> }>` — l'unica funzione che serve allo script via API.
- `generateRecoveryKit(): Promise<{ publicKey: string; kitText: string }>` (testo stampabile: gruppi di 5 caratteri base32 con checksum); `parseRecoveryKit(kitText: string): Promise<CryptoKey>` (lancia su checksum errato).
- `keyFingerprint(publicKey: string): Promise<string>` (prime 16 cifre esadecimali di SHA-256 della chiave, a gruppi di 4: si mostra nella conferma).
- Le chiavi d'oggetto sono `extractable: true` solo dove serve il wrapping; le chiavi private aperte NON estraibili.

- [ ] **Step 1: test che falliscono**: andata e ritorno per ogni coppia di funzioni; «copia della chiave usata con un altro `credentialId` → errore» e «con un altro `recipientId` → errore» (Review Focus 4); «PRF output diverso non apre la chiave privata»; «`parseRecoveryKit` con un carattere sbagliato lancia»; «`encryptForInsert` con 3 destinatari: ognuno decifra la stessa password»; formato: il JSON ha `v: 1`.
- [ ] **Step 2–4:** FAIL → implementa con `globalThis.crypto.subtle` (nessuna dipendenza) → PASS (`pnpm --filter @stubwise/vault-crypto test`); aggiungi il pacchetto al build del monorepo come gli altri `packages/*`.
- [ ] **Step 5:** commit `feat(vault-crypto): primitive della cassaforte delle credenziali`.

### Task 2: Permessi `credentials.*` e migrazione 0103

**Files:**
- Modify: `packages/shared/src/permissions.ts` (catalogo, `LEGACY_MEMBER_EXCLUDED`, filtro del preset `developer`), `apps/web/src/lib/permission-groups.ts` (gruppo nuovo `credentials`), `apps/web/src/i18n/locales/{it,en}.json` (etichette `permissions:label.credentials.*`, `settings:roles.groups.credentials`)
- Create: `packages/db/drizzle/0103_credentials_permissions.sql` (+ journal, a mano: drizzle-kit generate non è usabile, le snapshot si fermano alla 0060)
- Test: `packages/shared/src/permissions.test.ts`, `apps/web/src/lib/permission-groups.test.ts`, test di migrazione in `packages/db`

- [ ] **Step 1: test che falliscono**: «`project_lead` ha i tre permessi, `developer`/`legacy_member`/`viewer`/`contributor` nessuno»; «dopo la 0103 il ruolo con `preset_key = 'project_lead'` contiene i tre permessi, senza duplicati, anche se il maintainer ne aveva modificato i permessi»; nessun altro ruolo cambia.
- [ ] **Step 2–4:** FAIL → la migrazione aggiunge i tre valori all'array di `project_lead` (`array(select distinct unnest(...))`) → PASS.
- [ ] **Step 5:** commit `feat(shared,db): permessi delle credenziali`.

### Task 3: Schema della cassaforte (0104) e risoluzione dei lettori

**Files:**
- Modify: `packages/db/src/schema.ts`; Create: `packages/db/drizzle/0104_vault.sql` (+ journal)
- Create: `apps/server/src/vault/readers.ts` (+ test)

**Interfaces (Produces):**
- Tabelle:
  - `vaultSettings` (riga unica `id = 1`: `recoveryPublicKey`, `activatedAt`, `activatedByUserId` set null);
  - `vaultPersonKeys` (`id` uuid, `userId` cascade, `publicKey`, `status` ∈ `pending|confirmed|rejected|superseded`, `device text`, `createdAt`, `confirmedAt`, `confirmedByUserId` set null; al più UNA riga non `superseded`/`rejected` per utente — indice unico parziale);
  - `vaultPersonKeySeals` (`personKeyId` cascade, `passkeyId` → `user_passkeys` cascade, `sealedPrivateKey`; PK composta);
  - `credentials` (`id` uuid fornito dal client, `projectId` cascade, `service`, `label`, `url`, `username`, `notes`, `passwordCiphertext`, `createdByUserId` set null, `createdAt`, `updatedAt`, `updatedByUserId` set null);
  - `credentialReaders` (`id`, `credentialId` cascade, `userId` null cascade, `roleId` null cascade, CHECK esattamente uno dei due, `createdByUserId`, `createdAt`; unici parziali per `(credentialId,userId)` e `(credentialId,roleId)`);
  - `credentialKeyCopies` (`credentialId` cascade, `recipientId text` = id di `vaultPersonKeys` o `'recovery'`, `wrappedKey`, `createdAt`; PK `(credentialId, recipientId)`);
  - `credentialAccessLog` (`id`, `credentialId` set null, `projectId` cascade, `credentialSnapshot text` (servizio · etichetta · utente), `userId` set null, `userEmail text`, `action` ∈ `show|copy`, `createdAt`).
- `readers.ts`:
  - `effectiveReaderUserIds(db, credentialId): Promise<string[]>` = full admin ∪ lettori diretti ∪ membri con un ruolo invitato, in tutti i casi solo se membri del progetto (i full admin lo sono implicitamente).
  - `currentPersonKey(db, userId): Promise<{ id; publicKey; status } | null>` (l'unica non superseded/rejected).
  - `recipientsFor(db, credentialId | { projectId; creatorUserId }): Promise<{ people: Array<{ userId; email; personKeyId; publicKey; status }>; recoveryPublicKey: string }>` — i destinatari che una creazione o un cambio di password DEVE coprire: lettori effettivi con chiave `confirmed` + la chiave di recupero.
  - `canReadNow(db, userId, credentialId): Promise<boolean>` = lettore effettivo E chiave `confirmed` E copia presente per quella chiave.
  - `pendingFor(db, credentialId)`: lettori effettivi con chiave `pending`, o `confirmed` ma senza copia.
  - `purgeStaleCopies(db, projectId): Promise<number>` — cancella le copie di chiavi che non appartengono più a un lettore effettivo (mai la copia `recovery`).

- [ ] **Step 1: test che falliscono** (Postgres vero): i casi di `effectiveReaderUserIds` (diretto, via ruolo, admin, ex membro escluso — Review Focus 1), `canReadNow` falso con chiave pending o senza copia, `purgeStaleCopies` cancella la copia di chi ha perso il ruolo e lascia quella di recupero; vincoli (CHECK user/role, una sola chiave attiva per utente).
- [ ] **Step 2–4:** FAIL → implementa → PASS.
- [ ] **Step 5:** commit `feat(db,server): schema della cassaforte e lettori effettivi`.

### Task 4: Avvisi della cassaforte

**Files:**
- Modify: `packages/notifications/src/format.ts` (soggetti nuovi di `security.alert`), i18n (`packages/i18n/src/catalog.ts`), `apps/server/src/auth/second-factor/alerts.ts`, resa web/mobile se elenca i soggetti
- Test: accanto ai file

**Interfaces (Produces):**
- Soggetti `vault_key_created` (alla persona) e `vault_recovery_used` (a ciascun altro full admin, con `actorEmail`).
- `publishVaultRecoveryUsed(db, actor: { id; email }): Promise<void>` in `apps/server/src/vault/alerts.ts`.

- [ ] **Step 1:** test: testo it/en di entrambi; `vault_recovery_used` arriva a tutti i full admin tranne chi l'ha usato; il testo non contiene campi di credenziali.
- [ ] **Step 2–4:** FAIL → implementa (ricostruisci `@stubwise/notifications` e `@stubwise/i18n` prima dei test dipendenti) → PASS.
- [ ] **Step 5:** commit `feat(notifications): avvisi della cassaforte`.

### Task 5: Attivazione, chiavi delle persone, PRF

**Files:**
- Create: `apps/server/src/routes/vault.ts` (prefisso `/api/vault`) (+ test)
- Modify: `apps/server/src/auth/second-factor/passkeys.ts` (registrazione con `extensions: { prf: {} }`; opzioni di autenticazione con `purpose: "vault"` → `extensions: { prf: { eval: { first: PRF_INPUT } } }`), `apps/server/src/routes/me-security.ts` (`/reauth/passkey/options` accetta `{ purpose?: "vault" }`), schemi in `packages/shared/src/schemas/vault.ts`

**Interfaces (Produces):** (tutte sessione-only: PAT → 403 `session_required`)
- `GET /api/vault/status` → `{ activated: boolean; myKey: { id; status; createdAt } | null; seals: Array<{ passkeyId; credentialIdB64url }> }`.
- `POST /api/vault/activate` `{ recoveryPublicKey }` — `instance.full_admin`, `reauth: true`; 409 `vault_already_active`.
- `POST /api/vault/keys` `{ publicKey, seals: [{ passkeyId, sealedPrivateKey }], device }` — `reauth: true`; crea la chiave `pending` (o `confirmed` d'ufficio SOLO per il primo full admin all'attivazione, che non ha nessuno che possa confermarlo — *scelta del piano*), mette `superseded` la precedente e ne cancella le copie, evento di sicurezza + avviso `vault_key_created`; 409 `vault_not_active`.
- `POST /api/vault/keys/:id/seals` `{ passkeyId, sealedPrivateKey }` — aggiunge una passkey alla propria chiave attiva; `reauth: true`.
- `GET /api/vault/keys/mine` → `{ id, publicKey, status, seals }`.
- `POST /api/vault/recovery-key` `{ recoveryPublicKey, copies: [{ credentialId, wrappedKey }] }` — full admin, `reauth: true`; 409 `recipients_changed` se `copies` non copre ESATTAMENTE tutte le credenziali; sostituisce tutte le copie `recovery` in una transazione.
- Aggiorna gli elenchi chiusi delle rotte con riconferma (`apps/server/src/auth/route-access.test.ts`, `reauth.test.ts`).

- [ ] **Step 1: test che falliscono**: attivazione una volta sola e solo full admin; chiave nuova → `pending` + avviso; ricreata → la vecchia `superseded`, le sue copie spariscono (Review Focus 3); PAT su ogni rotta → 403; opzioni passkey con `purpose: "vault"` contengono `prf.eval.first` uguale a `PRF_INPUT`; registrazione con `prf: {}`.
- [ ] **Step 2–4:** FAIL → implementa → PASS.
- [ ] **Step 5:** commit `feat(server): attivazione della cassaforte e chiavi delle persone`.

### Task 6: Credenziali: elenco, creazione, password, mostra/copia, registro

**Files:**
- Create: `apps/server/src/routes/credentials.ts`, `apps/server/src/vault/credentials-service.ts` (+ test)

**Interfaces (Produces):**
- `GET /api/projects/:projectId/credentials` → elenco (senza cifrati né copie) con `access: "read" | "pending" | "manage"`; visibile solo ciò che si legge, più tutto se si ha `credentials.edit` o `credentials.share` nel progetto. Chiama `purgeStaleCopies` prima di rispondere.
- `GET /api/vault/credentials` → «le mie»: tutte quelle con `canReadNow` o in attesa per chi guarda, su tutti i progetti visibili.
- `GET /api/projects/:projectId/credentials/recipients` (per una nuova, `credentials.create`) e `GET /api/credentials/:id/recipients` (`credentials.edit` o creatore) → `recipientsFor`. PAT ammesso.
- `POST /api/projects/:projectId/credentials` `{ id, service, label?, url?, username?, notes?, passwordCiphertext, copies }` — `credentials.create`, PAT ammesso; il creatore diventa lettore diretto; `copies` deve coprire ESATTAMENTE `recipientsFor` (incluso il creatore se ha una chiave confermata) altrimenti 409 `recipients_changed` senza scrivere nulla (Review Focus 2).
- `PATCH /api/credentials/:id` (campi in chiaro) e `PUT /api/credentials/:id/password` `{ passwordCiphertext, copies }` (stesso controllo dei destinatari; sostituisce TUTTE le copie) — `credentials.edit` o creatore; PAT ammesso.
- `DELETE /api/credentials/:id` — `credentials.edit` o creatore.
- `POST /api/credentials/:id/reveal` `{ action: "show" | "copy" }` → `{ passwordCiphertext, wrappedKey, personKeyId }` — sessione-only, solo se `canReadNow`, scrive `credentialAccessLog` nella stessa transazione; 404 per chi non legge (come per una risorsa invisibile).
- `GET /api/projects/:projectId/credentials/log` — `credentials.edit` o `credentials.share` nel progetto, o full admin.
- Ogni rotta dichiara `config.access` coerente con `docs/invariants/permissions.md` (progetto invisibile → 404).

- [ ] **Step 1: test che falliscono**: creazione via PAT con copie corrette → 201; con un destinatario in meno o in più → 409 e nessuna riga; reveal di un lettore → 200 + riga di registro; di un non lettore, di un ex membro (Review Focus 1), di un PAT → 404/403 e nessuna riga; elenco di chi non legge e non gestisce → vuoto; `PUT password` sostituisce tutte le copie; nessuna risposta contiene `passwordCiphertext` tranne `reveal`.
- [ ] **Step 2–4:** FAIL → implementa → PASS.
- [ ] **Step 5:** commit `feat(server): credenziali della cassaforte`.

### Task 7: Lettori, conferme e recupero

**Files:**
- Modify: `apps/server/src/routes/credentials.ts`, `apps/server/src/routes/vault.ts`, `apps/server/src/vault/credentials-service.ts` (+ test)

**Interfaces (Produces):** (sessione-only)
- `GET /api/credentials/:id/readers` → lettori diretti e ruoli, con stato per persona (`can_read | pending`); `credentials.share` + lettore, o full admin.
- `POST /api/credentials/:id/readers` `{ userId } | { roleId }` + `copies` per le persone del nuovo lettore che hanno già una chiave `confirmed` — `credentials.share` E `canReadNow`; le altre restano in attesa.
- `DELETE /api/credentials/:id/readers/:readerId` — stessa autorizzazione; cancella subito le copie di chi non è più lettore effettivo.
- `GET /api/vault/pending` → per persona: `{ user, personKey: { id, status, createdAt, device, fingerprintSource: publicKey }, credentials: [{ id, projectId, service, label }] }`, limitato alle credenziali che chi guarda può confermare (lettore con `credentials.share`, o full admin con copia).
- `POST /api/vault/pending/:personKeyId/confirm` `{ copies: [{ credentialId, wrappedKey }], viaRecovery?: boolean }` — porta la chiave a `confirmed` se era `pending` (con `confirmedBy`), salva solo le copie che chi conferma poteva dare; `viaRecovery: true` solo full admin con `reauth`, registra un evento di sicurezza e chiama `publishVaultRecoveryUsed`.
- `POST /api/vault/pending/:personKeyId/reject` → `rejected`, nessuna copia.

- [ ] **Step 1: test che falliscono**: condividere senza essere lettore → 403 anche con `credentials.share`; condividere a un ruolo dà subito accesso a chi ha chiave confermata e mette in attesa gli altri; la revoca cancella le copie; conferma di una chiave pending → `confirmed`; un lettore senza `credentials.share` non vede né conferma; rifiuto → nessuna copia, la persona resta senza accesso; `viaRecovery` → evento + avviso agli altri admin.
- [ ] **Step 2–4:** FAIL → implementa → PASS. Aggiorna gli elenchi delle rotte con riconferma.
- [ ] **Step 5:** commit `feat(server): lettori, conferme e recupero della cassaforte`.

### Task 8: Isolamento dal resto di Stubwise

**Files:**
- Create: `apps/server/src/vault/vault-isolation.test.ts`, `docs/invariants/vault.md`
- Modify: `CLAUDE.md` (indice delle invarianti)

- [ ] **Step 1:** test sul sorgente (stile `apps/server/src/services/decisions-never-ai.test.ts`): nessun file sotto `apps/worker/src`, `packages/mcp/src`, `apps/server/src/{search,graph-chat,slack,services/inbox*,...}` (elenco esplicito dei moduli di ricerca, chat, embedding, MCP, notifiche, webhook) nomina le tabelle o i moduli della cassaforte; test a runtime: una credenziale creata non compare in `GET /api/search` né nella cronologia di ricerca; le risposte delle rotte d'errore della cassaforte non riportano campi del corpo.
- [ ] **Step 2:** `docs/invariants/vault.md`: il server non decifra mai; solo la password è cifrata; conferma umana obbligatoria; PAT non legge; revoca a lettura + purge; elenco chiuso dei moduli che possono importare `apps/server/src/vault`; limiti accettati (server compromesso, cambio di dominio).
- [ ] **Step 3–4:** run → PASS; commit `test(server): la cassaforte resta isolata`.

### Task 9: Web — sblocco, chiave personale, attivazione e kit

**Files:**
- Create: `apps/web/src/lib/vault/{vault-context.tsx,unlock.ts,idle.ts}` (+ test), `apps/web/src/routes/vault-setup.tsx` (attivazione + kit, full admin), `apps/web/src/components/vault/{unlock-dialog.tsx,recovery-kit.tsx}`
- Modify: `apps/web/package.json` (dipendenza `@stubwise/vault-crypto`), router, i18n

**Interfaces (Produces):**
- `useVault(): { state: "inactive" | "locked" | "unlocked" | "no_key" | "unsupported"; unlock(): Promise<void>; lock(): void; privateKey: CryptoKey | null; personKeyId: string | null }`.
- Sblocco: `/reauth/passkey/options` con `purpose: "vault"` → `startAuthentication` → se `clientExtensionResults.prf?.results?.first` manca → stato `unsupported` (messaggio + link a Impostazioni → Sicurezza per aggiungere una passkey compatibile) e NESSUNA chiave creata (Review Focus 5); altrimenti `/reauth/passkey/verify`, poi `openPrivateKey` col sigillo della passkey usata, o — se la persona non ha chiave — `generatePersonKeyPair` + `sealPrivateKey` + `POST /api/vault/keys`.
- Chiusura automatica dopo 15 minuti senza interazione (`idle.ts`, testato con timer finti), al logout e allo smontaggio.
- Attivazione (full admin): genera kit, lo mostra una volta («Ho stampato/salvato il kit» per proseguire), `POST /api/vault/activate`, poi crea la chiave dell'admin.

- [ ] **Step 1: test che falliscono** (happy-dom, WebAuthn e API finti, crypto vera): PRF assente → `unsupported` e nessuna POST; prima apertura → chiave creata e stato `unlocked`; 15 minuti → `locked` e chiave azzerata; il kit si mostra una volta e serve la conferma.
- [ ] **Step 2–4:** FAIL → implementa → PASS.
- [ ] **Step 5:** commit `feat(web): sblocco della cassaforte e kit di recupero`.

### Task 10: Web — sezione «Credenziali» e «Le mie credenziali»

**Files:**
- Create: `apps/web/src/components/vault/{credentials-section.tsx,credential-form.tsx,reveal-button.tsx,readers-panel.tsx,access-log.tsx}` (+ test), `apps/web/src/routes/credentials.tsx` («Le mie credenziali»)
- Modify: `apps/web/src/routes/projects/$projectId.tsx` (sezione accanto a «Membri», stesso stile), navigazione, i18n

- [ ] **Step 1: test che falliscono**: elenco raggruppato per servizio con etichetta/utente/URL, mai la password; «Mostra» chiede lo sblocco se chiusa, poi mostra; «Copia» scrive negli appunti e li svuota dopo 30 secondi (timer finti); creazione: `encryptForInsert` sui destinatari del server, 409 `recipients_changed` → ricarica i destinatari e riprova una volta; la nota «le note non sono cifrate» accanto al campo; pannello lettori visibile solo con `credentials.share` + lettore; dopo una revoca propone di cambiare la password; registro visibile solo a chi ha i permessi.
- [ ] **Step 2–4:** FAIL → implementa → PASS.
- [ ] **Step 5:** commit `feat(web): credenziali del progetto`.

### Task 11: Web — accessi da confermare e recupero

**Files:**
- Create: `apps/web/src/components/vault/pending-access.tsx`, `apps/web/src/routes/vault-recovery.tsx` (+ test)

- [ ] **Step 1: test che falliscono**: la lista mostra persona, data, dispositivo, impronta della chiave (`keyFingerprint`) e il numero di credenziali, con l'invito a verificare con la persona; «Conferma» ricifra le chiavi delle credenziali che chi guarda può aprire e chiama `confirm`; «Rifiuta» chiama `reject`; pagina di recupero (full admin): incolla il kit, `parseRecoveryKit`, conferme con `viaRecovery: true`, il kit non resta in memoria dopo l'uscita dalla pagina e non viene mai inviato al server.
- [ ] **Step 2–4:** FAIL → implementa → PASS.
- [ ] **Step 5:** commit `feat(web): conferma degli accessi e recupero della cassaforte`.

### Task 12: E2E

**Files:**
- Create: `apps/web/e2e/vault.spec.ts`, helper per l'autenticatore virtuale in `apps/web/e2e/`

- [ ] **Step 1:** con l'autenticatore virtuale WebAuthn di Chromium via CDP (`WebAuthn.addVirtualAuthenticator` con supporto PRF; se la versione di Playwright/Chromium non lo offre, il task lo dice e ripiega su un test a livello di API con la crypto vera e un PRF simulato, documentandolo): admin attiva la cassaforte (kit), crea una credenziale, la mostra; un secondo utente invitato via ruolo resta in attesa finché l'admin non conferma, poi la mostra; revoca → non la vede più.
- [ ] **Step 2–3:** run (`pnpm --filter @stubwise/web e2e`) → PASS, suite esistente verde; commit `test(web): e2e della cassaforte`.

### Task 13: Script di esempio, guida e voce di deploy

**Files:**
- Create: `scripts/vault-insert-example.mjs` (legge un CSV passato come argomento, NON stampa valori, usa `encryptForInsert` e l'API con `STUBWISE_URL`/`STUBWISE_TOKEN`), `apps/docs/src/content/docs/team/credentials.md`
- Modify: `docs/operations/deploy-log.md` (voce «Cassaforte delle credenziali»), `CLAUDE.md` (indice deploy-log), `apps/docs/astro.config.mjs`

- [ ] **Step 1:** test dello script con un server finto (`fetch` iniettato): 3 righe di CSV → 3 POST con cifrati diversi dal testo, nessun valore su stdout/stderr; 409 → rilegge i destinatari e riprova una volta.
- [ ] **Step 2:** guida (inglese): attivare, primo sblocco, passkey compatibili, mostrare/copiare, condividere, confermare accessi (verificare con la persona), revoca e cambio password, kit di recupero, inserimento via script **senza far leggere i CSV a Claude Code**, cambio di dominio.
- [ ] **Step 3:** voce di deploy: migrazioni 0103/0104, server + caddy insieme, worker solo per i soggetti nuovi degli avvisi (con i controlli d'inattività), passi dopo il rilascio (attivazione, kit), rollback (le tabelle restano; i permessi nuovi sono ignorati da un server vecchio; avvisi `security.alert` con soggetti nuovi: un server vecchio li legge? verificalo e scrivilo), cambio di dominio.
- [ ] **Step 4:** `pnpm lint && pnpm typecheck && pnpm --filter @stubwise/docs build` → verdi; commit `docs: cassaforte delle credenziali, guida, script e voce di deploy`.
