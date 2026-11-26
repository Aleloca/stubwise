import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  credentialKeyCopies,
  credentials,
  users,
  RECOVERY_RECIPIENT_ID,
  userPasskeys,
  vaultPersonKeySeals,
  vaultPersonKeys,
  vaultSettings,
} from "@stubwise/db";
import {
  vaultActivateBodySchema,
  vaultActorChallengeResponseSchema,
  vaultRecoveryKeyPreviewSchema,
  vaultRejectBodySchema,
  type VaultActorProof,
  vaultCreateKeyBodySchema,
  vaultCreateKeyResponseSchema,
  vaultMyKeyResponseSchema,
  vaultRecoveryKeyBodySchema,
  vaultSealInputSchema,
  vaultConfirmBodySchema,
  vaultConfirmResponseSchema,
  vaultPendingResponseSchema,
  vaultRecoveryChallengeResponseSchema,
  vaultRecoveryConfirmBodySchema,
  vaultRecoveryPendingBodySchema,
  vaultStatusResponseSchema,
  type VaultConfirmCopy,
  vaultActorProofSchema,
  vaultDevicePairingBodySchema,
  vaultDevicePairingLookupBodySchema,
  vaultDevicePairingLookupResponseSchema,
  vaultDevicePairingResponseSchema,
  vaultDeviceSealBodySchema,
  vaultDeviceSealCreatedSchema,
  vaultDeviceSealListSchema,
  vaultDeviceSealMineSchema,
} from "@stubwise/shared";
import { isDesktopPat } from "../auth/access.js";
import { recordSecurityEvent } from "../auth/second-factor/security-events.js";
import type { SessionUser } from "../auth/session.js";
import { apiError } from "../errors.js";
import { publishVaultKeyCreated, publishVaultRecoveryKeyRotated } from "../vault/alerts.js";
import {
  confirmPersonKey,
  listPending,
  listPendingForRecovery,
  rejectPersonKey,
  type ConfirmError,
  type VaultActor,
} from "../vault/pending.js";
import { requireVaultCaller, vaultDesktopDisabled } from "../vault/device-access.js";
import { createPairing, createSeal, listSeals, lookupPairing, mineSeal, ownLiveSeal, revokeSeal } from "../vault/device-seals.js";
import { currentPersonKey } from "../vault/readers.js";
import {
  checkRecoveryProof,
  consumeActorProof,
  createActorChallenge,
  createRecoveryChallenge,
} from "../vault/recovery-challenge.js";
import { authErrorResponses, errorSchema } from "./shared.js";

const errorResponses = {
  ...authErrorResponses,
  404: errorSchema,
  409: errorSchema,
} as const;

/** Righe per INSERT nella rigenerazione del kit (3 parametri ciascuna). */
const INSERT_CHUNK = 1000;

/** Stati di una chiave VIVA (al più una per utente, indice unico parziale). */
const LIVE = ["pending", "confirmed"] as const;

/**
 * Cassaforte delle credenziali: attivazione, chiavi delle persone e kit di
 * recupero (`/api/vault`, design
 * `docs/plans/2026-10-23-cassaforte-credenziali-design.md`). Il server
 * riceve solo chiavi pubbliche e buste cifrate: nessuna chiave privata né
 * password in chiaro passa di qui.
 *
 * Le rotte sono da sessione: un PAT riceve 403 `session_required` — dal
 * gate della riconferma per le scritture (`config.reauth`), esplicitamente
 * per le altre. Un token non scarica mai la propria chiave sigillata né
 * attiva o rigenera nulla. Eccezioni (lotto 10, D-7): le rotte che
 * dichiarano `config.desktopVault` passano anche dal PAT desktop col suo
 * sigillo vivo (`vault/device-access.ts`), e quelle del sigillo del Mac
 * (`/device-pairings`, `/device-seals/mine`) sono SOLO del PAT desktop.
 *
 * Le azioni che passano o tolgono l'accesso (conferma, rifiuto, rotazione
 * del kit; condivisione e revoca in `credentials.ts`) vogliono in più la
 * PROVA che chi agisce ha aperto la sua chiave confermata (`actorProof`,
 * `POST /actor-challenge`): un login rubato, anche di un full admin, non
 * basta (403 `vault_proof_invalid`, nulla cambia).
 */
export async function vaultRoutes(instance: FastifyInstance): Promise<void> {
  // La cassaforte è solo-browser anche per il PAT desktop riconfermato (10
  // nov 2026): la riconferma non sblocca la chiave (passkey con PRF).
  // Dal lotto 10 (24 nov 2026, D-7) le rotte che dichiarano
  // `config.desktopVault` sono aperte anche al PAT desktop col suo sigillo
  // vivo (`vault/device-access.ts`, elenco chiuso in `route-access.test.ts`);
  // tutte le altre restano solo del browser.
  // Review M9: un DELETE con `content-type: application/json` e corpo VUOTO
  // (il browser, togliendo un Mac) è un corpo assente, non un 400. Solo in
  // questo scope; per il resto è il parser di Fastify (con le sue difese
  // contro proto/constructor poisoning).
  const defaultJson = instance.getDefaultJsonParser("error", "error");
  instance.removeContentTypeParser("application/json");
  instance.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    if (body === "") {
      done(null, null);
      return;
    }
    defaultJson(request, body as string, done);
  });
  instance.addHook("onRoute", (route) => {
    if (route.config?.desktopVault === true || route.config?.desktopOnly === true || route.config?.desktopRead === true) return;
    route.config = { ...(route.config ?? {}), browserOnly: true };
  });
  const app = instance.withTypeProvider<ZodTypeProvider>();

  function isPat(user: SessionUser): boolean {
    return user.patId !== undefined;
  }

  function sessionRequired(reply: FastifyReply): FastifyReply {
    return apiError(reply, 403, "session_required", "This action requires a browser session");
  }

  function vaultNotActive(reply: FastifyReply): FastifyReply {
    return apiError(reply, 409, "vault_not_active", "The vault has not been activated");
  }

  function keyNotFound(reply: FastifyReply): FastifyReply {
    return apiError(reply, 404, "vault_key_not_found", "Vault key not found");
  }

  function passkeyNotFound(reply: FastifyReply): FastifyReply {
    return apiError(reply, 404, "passkey_not_found", "Passkey not found");
  }

  function keyNotConfirmed(reply: FastifyReply): FastifyReply {
    return apiError(reply, 403, "vault_key_not_confirmed", "You have no confirmed vault key");
  }

  /**
   * La prova di possesso della propria chiave confermata (`consumeActorProof`):
   * `true` se vale (e ora è consumata); altrimenti la risposta 403
   * `vault_proof_invalid` è già partita e nulla è cambiato.
   */
  async function actorProofOk(reply: FastifyReply, user: SessionUser, proof: VaultActorProof): Promise<boolean> {
    if (await consumeActorProof(app.db, user, proof)) return true;
    apiError(reply, 403, "vault_proof_invalid", "Vault key proof missing, wrong, expired or already used");
    return false;
  }

  /** I sigilli di una chiave con l'id WebAuthn (base64url) della loro passkey. */
  async function sealsOf(personKeyId: string) {
    return app.db
      .select({
        passkeyId: vaultPersonKeySeals.passkeyId,
        credentialIdB64url: userPasskeys.credentialId,
        sealedPrivateKey: vaultPersonKeySeals.sealedPrivateKey,
      })
      .from(vaultPersonKeySeals)
      .innerJoin(userPasskeys, eq(userPasskeys.id, vaultPersonKeySeals.passkeyId))
      .where(eq(vaultPersonKeySeals.personKeyId, personKeyId))
      .orderBy(userPasskeys.createdAt);
  }

  /** Quante delle passkey `ids` sono di `userId` (gli id sono già distinti). */
  async function ownPasskeyCount(userId: string, ids: string[]): Promise<number> {
    const rows = await app.db
      .select({ id: userPasskeys.id })
      .from(userPasskeys)
      .where(and(eq(userPasskeys.userId, userId), inArray(userPasskeys.id, ids)));
    return rows.length;
  }

  /**
   * Lo stato visto dalla persona: se la cassaforte è attiva e la sua ULTIMA
   * chiave (viva, o rifiutata: la web deve sapere che va ricreata), con
   * l'id WebAuthn delle passkey che la aprono — per scegliere il sigillo
   * della passkey appena usata — e di tutte le sue passkey (per sigillare
   * una chiave nuova). Mai la privata sigillata: quella la dà `/keys/mine`.
   *
   * Dal 25 nov 2026 (`desktopRead`) la legge anche il PAT desktop, SENZA
   * sigillo: il Mac deve poter dire «nessuna chiave» o «la tua chiave aspetta
   * conferma» prima di essere associato. A lui la risposta ridotta: stato e
   * chiave (con la pubblica, per l'impronta), sigilli e passkey vuoti. Con
   * `VAULT_DESKTOP` spento 404 `vault_desktop_disabled`; ogni altro PAT resta
   * `session_required`.
   */
  app.get(
    "/status",
    {
      config: { access: { kind: "user" }, desktopRead: true },
      schema: { response: { 200: vaultStatusResponseSchema, ...errorResponses } },
    },
    async (request, reply) => {
      const user = request.user!;
      const fromMac = isDesktopPat(user);
      if (isPat(user) && !fromMac) return sessionRequired(reply);
      if (fromMac && !app.vaultDesktop) return vaultDesktopDisabled(reply);
      const [settings] = await app.db.select({ id: vaultSettings.id }).from(vaultSettings);
      const [key] = await app.db
        .select({
          id: vaultPersonKeys.id,
          status: vaultPersonKeys.status,
          createdAt: vaultPersonKeys.createdAt,
          publicKey: vaultPersonKeys.publicKey,
        })
        .from(vaultPersonKeys)
        .where(eq(vaultPersonKeys.userId, user.id))
        .orderBy(desc(vaultPersonKeys.createdAt))
        .limit(1);
      const myKey = key
        ? { id: key.id, status: key.status, createdAt: key.createdAt.toISOString(), publicKey: key.publicKey }
        : null;
      if (fromMac) return reply.code(200).send({ activated: settings !== undefined, myKey, seals: [], passkeys: [] });
      // Una chiave rifiutata non si apre più: nessun sigillo da proporre.
      const seals = key && key.status !== "rejected" ? await sealsOf(key.id) : [];
      const passkeys = await app.db
        .select({ passkeyId: userPasskeys.id, credentialIdB64url: userPasskeys.credentialId })
        .from(userPasskeys)
        .where(eq(userPasskeys.userId, user.id))
        .orderBy(userPasskeys.createdAt);
      return reply.code(200).send({
        activated: settings !== undefined,
        myKey,
        seals: seals.map(({ passkeyId, credentialIdB64url }) => ({ passkeyId, credentialIdB64url })),
        passkeys,
      });
    },
  );

  /**
   * Attivazione, una volta per istanza: salva la chiave PUBBLICA di
   * recupero (la privata la vede solo il browser di chi attiva). La riga
   * unica (`id = 1`) fa da serratura: la seconda attivazione non scrive.
   */
  app.post(
    "/activate",
    {
      config: { access: { kind: "instance", permission: "instance.full_admin" }, reauth: true },
      schema: {
        body: vaultActivateBodySchema,
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = request.user!;
      // Nel registro di sicurezza di chi attiva, insieme all'attivazione.
      const inserted = await app.db.transaction(async (tx) => {
        const rows = await tx
          .insert(vaultSettings)
          .values({ id: 1, recoveryPublicKey: request.body.recoveryPublicKey, activatedByUserId: user.id })
          .onConflictDoNothing({ target: vaultSettings.id })
          .returning({ id: vaultSettings.id });
        if (rows.length > 0) await recordSecurityEvent(tx, { kind: "vault_activated", user });
        return rows;
      });
      if (inserted.length === 0) {
        return apiError(reply, 409, "vault_already_active", "The vault is already active");
      }
      return reply.code(204).send(null);
    },
  );

  /**
   * Crea (o ricrea) la chiave della persona. Nasce `pending`: la conferma
   * un'altra persona (design «Lettori che arrivano dopo»). Eccezione unica
   * (decisione V1 del piano): la PRIMA chiave dell'istanza del full admin che
   * HA ATTIVATO la cassaforte — non ha nessuno che possa confermarlo. «Prima»
   * vuol dire che nessuna chiave è MAI stata confermata (`confirmed_at` non
   * nullo, qualunque sia lo stato oggi): ricrearla mette la vecchia
   * `superseded` ma ne lascia `confirmed_at`, così una chiave ricreata non si
   * conferma mai da sé — la conferma resta di una persona (o del kit di
   * recupero). La
   * precedente diventa `superseded` e perde copie e sigilli: le sue
   * credenziali tornano «in attesa» (Review Focus 3). La riga di
   * `vault_settings` si blocca per tutta la transazione, così due prime
   * chiavi in parallelo non si confermano entrambe.
   */
  app.post(
    "/keys",
    {
      config: { access: { kind: "user" }, reauth: true },
      schema: {
        body: vaultCreateKeyBodySchema,
        response: { 201: vaultCreateKeyResponseSchema, ...errorResponses, 400: errorSchema },
      },
    },
    async (request, reply) => {
      const user = request.user!;
      const { publicKey, seals, device } = request.body;
      const passkeyIds = [...new Set(seals.map((s) => s.passkeyId))];
      if (passkeyIds.length !== seals.length) {
        return apiError(reply, 400, "duplicate_seal", "One seal per passkey");
      }
      if ((await ownPasskeyCount(user.id, passkeyIds)) !== passkeyIds.length) {
        return passkeyNotFound(reply);
      }
      const created = await app.db.transaction(async (tx) => {
        const [settings] = await tx
          .select({ activatedByUserId: vaultSettings.activatedByUserId })
          .from(vaultSettings)
          .for("update");
        if (!settings) return null;
        const [everConfirmed] = await tx
          .select({ id: vaultPersonKeys.id })
          .from(vaultPersonKeys)
          .where(isNotNull(vaultPersonKeys.confirmedAt))
          .limit(1);
        const autoConfirm =
          !everConfirmed &&
          settings.activatedByUserId === user.id &&
          user.instancePermissions.has("instance.full_admin");

        const previous = await tx
          .update(vaultPersonKeys)
          .set({ status: "superseded" })
          .where(and(eq(vaultPersonKeys.userId, user.id), inArray(vaultPersonKeys.status, [...LIVE])))
          .returning({ id: vaultPersonKeys.id });
        for (const old of previous) {
          await tx.delete(credentialKeyCopies).where(eq(credentialKeyCopies.recipientId, old.id));
          await tx.delete(vaultPersonKeySeals).where(eq(vaultPersonKeySeals.personKeyId, old.id));
        }

        const [key] = await tx
          .insert(vaultPersonKeys)
          .values({
            userId: user.id,
            publicKey,
            device: device === "" ? null : device,
            status: autoConfirm ? "confirmed" : "pending",
            ...(autoConfirm ? { confirmedAt: sql`now()`, confirmedByUserId: user.id } : {}),
          })
          .returning({
            id: vaultPersonKeys.id,
            status: vaultPersonKeys.status,
            createdAt: vaultPersonKeys.createdAt,
          });
        await tx.insert(vaultPersonKeySeals).values(
          seals.map((s) => ({
            personKeyId: key!.id,
            passkeyId: s.passkeyId,
            sealedPrivateKey: s.sealedPrivateKey,
          })),
        );
        await recordSecurityEvent(tx, { kind: "vault_key_created", user });
        return key!;
      });
      if (!created) return vaultNotActive(reply);
      // Avviso alla persona: se non è stata lei, se ne accorge.
      await publishVaultKeyCreated(app.db, user.id);
      return reply.code(201).send({
        id: created.id,
        status: created.status,
        createdAt: created.createdAt.toISOString(),
      });
    },
  );

  /**
   * Aggiunge (o rinnova) il sigillo di una passkey alla PROPRIA chiave viva:
   * una passkey registrata dopo la chiave può così aprire la cassaforte.
   * Rinnovarlo SOSTITUISCE il sigillo di prima: finisce nel registro di
   * sicurezza (`vault_seal_replaced`), perché è il punto in cui un sigillo
   * buono potrebbe essere scambiato con uno che non apre più niente.
   */
  app.post(
    "/keys/:id/seals",
    {
      config: { access: { kind: "user" }, reauth: true },
      schema: {
        params: z.object({ id: z.uuid() }),
        body: vaultSealInputSchema,
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = request.user!;
      const { passkeyId, sealedPrivateKey } = request.body;
      if ((await ownPasskeyCount(user.id, [passkeyId])) !== 1) return passkeyNotFound(reply);
      // La riga della chiave si blocca: una ricreazione in parallelo non può
      // renderla `superseded` fra il controllo e l'inserimento del sigillo.
      const added = await app.db.transaction(async (tx) => {
        const [key] = await tx
          .select({ id: vaultPersonKeys.id })
          .from(vaultPersonKeys)
          .where(
            and(
              eq(vaultPersonKeys.id, request.params.id),
              eq(vaultPersonKeys.userId, user.id),
              inArray(vaultPersonKeys.status, [...LIVE]),
            ),
          )
          .for("update");
        if (!key) return false;
        const [existing] = await tx
          .select({ passkeyId: vaultPersonKeySeals.passkeyId })
          .from(vaultPersonKeySeals)
          .where(and(eq(vaultPersonKeySeals.personKeyId, key.id), eq(vaultPersonKeySeals.passkeyId, passkeyId)));
        await tx
          .insert(vaultPersonKeySeals)
          .values({ personKeyId: key.id, passkeyId, sealedPrivateKey })
          .onConflictDoUpdate({
            target: [vaultPersonKeySeals.personKeyId, vaultPersonKeySeals.passkeyId],
            set: { sealedPrivateKey },
          });
        if (existing) await recordSecurityEvent(tx, { kind: "vault_seal_replaced", user });
        return true;
      });
      if (!added) return keyNotFound(reply);
      return reply.code(204).send(null);
    },
  );

  /** La propria chiave viva con i sigilli (privata CIFRATA), per aprirla nel browser. */
  app.get(
    "/keys/mine",
    {
      config: { access: { kind: "user" } },
      schema: { response: { 200: vaultMyKeyResponseSchema, ...errorResponses } },
    },
    async (request, reply) => {
      const user = request.user!;
      if (isPat(user)) return sessionRequired(reply);
      const key = await currentPersonKey(app.db, user.id);
      if (!key) return keyNotFound(reply);
      return reply.code(200).send({ ...key, seals: await sealsOf(key.id) });
    },
  );

  /**
   * Prova di possesso della propria chiave, primo passo: un segreto cifrato
   * per la pubblica della chiave CONFERMATA di chi chiede
   * (`recovery-challenge.ts`). Lo apre solo il browser con la cassaforte
   * aperta; conferma, rifiuto, condivisione, revoca di un lettore e
   * rotazione del kit vogliono la prova (`actorProof`). Niente riconferma: la
   * prova stessa vuole la passkey che ha aperto la chiave.
   */
  app.post(
    "/actor-challenge",
    {
      config: { access: { kind: "user" }, desktopVault: true },
      schema: { response: { 201: vaultActorChallengeResponseSchema, ...errorResponses } },
    },
    async (request, reply) => {
      const user = request.user!;
      if (!(await requireVaultCaller(app.db, request, reply))) return reply;
      const outcome = await createActorChallenge(app.db, user);
      if (outcome.ok) return reply.code(201).send(outcome.value);
      return outcome.error === "vault_not_active" ? vaultNotActive(reply) : keyNotConfirmed(reply);
    },
  );

  /**
   * Anteprima della rigenerazione del kit (full admin, solo da sessione): per
   * OGNI credenziale la copia della chiave per la chiave confermata di chi
   * guarda — mai la password cifrata —, da aprire nel browser e ricifrare per
   * la pubblica nuova. `missing`: quelle di cui non ha una copia; la
   * rotazione le vuole tutte, quindi la web la rifiuta finché ne manca una.
   */
  app.get(
    "/recovery-key/preview",
    {
      config: { access: { kind: "instance", permission: "instance.full_admin" } },
      schema: { response: { 200: vaultRecoveryKeyPreviewSchema, ...errorResponses } },
    },
    async (request, reply) => {
      const user = request.user!;
      if (isPat(user)) return sessionRequired(reply);
      const [settings] = await app.db.select({ id: vaultSettings.id }).from(vaultSettings);
      if (!settings) return vaultNotActive(reply);
      const key = await currentPersonKey(app.db, user.id);
      if (!key || key.status !== "confirmed") return keyNotConfirmed(reply);
      const rows = await app.db
        .select({
          id: credentials.id,
          projectId: credentials.projectId,
          service: credentials.service,
          label: credentials.label,
          wrappedKey: credentialKeyCopies.wrappedKey,
        })
        .from(credentials)
        .leftJoin(
          credentialKeyCopies,
          and(eq(credentialKeyCopies.credentialId, credentials.id), eq(credentialKeyCopies.recipientId, key.id)),
        )
        .orderBy(asc(credentials.service), asc(credentials.id));
      return reply.code(200).send({
        personKeyId: key.id,
        credentials: rows.flatMap(({ wrappedKey, ...rest }) => (wrappedKey === null ? [] : [{ ...rest, wrappedKey }])),
        missing: rows.flatMap(({ wrappedKey, ...rest }) => (wrappedKey === null ? [rest] : [])),
      });
    },
  );

  /**
   * Rigenera il kit di recupero: la chiave pubblica nuova e la copia della
   * chiave di OGNI credenziale cifrata per lei, tutte insieme. Se `copies`
   * non copre ESATTAMENTE le credenziali di adesso (una creata o tolta nel
   * frattempo) → 409 `recipients_changed` e nessuna riga scritta: la
   * vecchia chiave di recupero resterebbe l'unica a leggere quella che manca.
   * La riga di `vault_settings` si blocca per la transazione.
   *
   * Oltre alla riconferma vuole la prova della propria chiave (`actorProof`):
   * chi ruota ha ricifrato le copie dalla SUA chiave, e un login rubato non
   * può sostituire il kit con uno suo. Finisce nel registro di sicurezza e
   * avvisa gli altri full admin (il kit vecchio smette di valere).
   */
  app.post(
    "/recovery-key",
    {
      config: { access: { kind: "instance", permission: "instance.full_admin" }, reauth: true },
      schema: {
        body: vaultRecoveryKeyBodySchema,
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = request.user!;
      const { recoveryPublicKey, copies, actorProof } = request.body;
      const [active] = await app.db.select({ id: vaultSettings.id }).from(vaultSettings);
      if (!active) return vaultNotActive(reply);
      if (!(await actorProofOk(reply, user, actorProof))) return reply;
      const outcome = await app.db.transaction(async (tx) => {
        const [settings] = await tx
          .select({ id: vaultSettings.id })
          .from(vaultSettings)
          .for("update");
        if (!settings) return "vault_not_active" as const;
        const existing = await tx.select({ id: credentials.id }).from(credentials);
        const sent = new Set(copies.map((c) => c.credentialId));
        const exact =
          sent.size === copies.length &&
          sent.size === existing.length &&
          existing.every((c) => sent.has(c.id));
        if (!exact) return "recipients_changed" as const;
        await tx
          .delete(credentialKeyCopies)
          .where(eq(credentialKeyCopies.recipientId, RECOVERY_RECIPIENT_ID));
        // A blocchi: un solo INSERT supererebbe il tetto di parametri di Postgres.
        for (let i = 0; i < copies.length; i += INSERT_CHUNK) {
          await tx.insert(credentialKeyCopies).values(
            copies.slice(i, i + INSERT_CHUNK).map((c) => ({
              credentialId: c.credentialId,
              recipientId: RECOVERY_RECIPIENT_ID,
              wrappedKey: c.wrappedKey,
            })),
          );
        }
        await tx.update(vaultSettings).set({ recoveryPublicKey }).where(eq(vaultSettings.id, 1));
        await recordSecurityEvent(tx, { kind: "vault_recovery_key_rotated", user, actor: user });
        return "ok" as const;
      });
      if (outcome === "vault_not_active") return vaultNotActive(reply);
      if (outcome === "recipients_changed") {
        return apiError(
          reply,
          409,
          "recipients_changed",
          "The set of credentials changed: reload and retry",
        );
      }
      await publishVaultRecoveryKeyRotated(app.db, { id: user.id, email: user.email });
      return reply.code(204).send(null);
    },
  );

  /* ── Accessi in attesa e recupero (Task 7, `vault/pending.ts`). ── */

  const personKeyParams = z.object({ personKeyId: z.uuid() });

  function actorOf(user: SessionUser): VaultActor {
    return { id: user.id, email: user.email, fullAdmin: user.instancePermissions.has("instance.full_admin") };
  }

  async function confirm(
    reply: FastifyReply,
    user: SessionUser,
    personKeyId: string,
    copies: VaultConfirmCopy[],
    viaRecovery: boolean,
  ): Promise<FastifyReply> {
    const outcome = await confirmPersonKey(app.db, actorOf(user), personKeyId, copies, viaRecovery);
    if (outcome.ok) return reply.code(200).send(outcome.value);
    const errors: Record<ConfirmError, () => FastifyReply> = {
      vault_not_active: () => vaultNotActive(reply),
      not_found: () => keyNotFound(reply),
      own_key: () => apiError(reply, 403, "own_key", "You cannot confirm your own vault key"),
      forbidden: () => apiError(reply, 403, "forbidden", "Missing permission"),
      nothing_to_confirm: () =>
        apiError(reply, 403, "nothing_to_confirm", "None of these credentials can be passed on by you"),
    };
    return errors[outcome.error]();
  }

  /**
   * Gli accessi che chi guarda può confermare: per persona, la chiave da
   * verificare con lei e le credenziali che chi guarda può passarle, con la
   * SUA copia della chiave da ricifrare (mai la password cifrata).
   */
  app.get(
    "/pending",
    {
      config: { access: { kind: "user" }, desktopVault: true },
      schema: { response: { 200: vaultPendingResponseSchema, ...errorResponses } },
    },
    async (request, reply) => {
      const user = request.user!;
      if (!(await requireVaultCaller(app.db, request, reply))) return reply;
      return reply.code(200).send({ items: await listPending(app.db, user.id) });
    },
  );

  /**
   * Conferma una chiave e passa le credenziali che chi conferma può dare
   * (`vault/pending.ts` per le regole), con la prova di possesso della
   * propria chiave (`actorProof`, consumata). Mai la propria chiave, mai «a
   * vuoto». Il recupero ha la sua rotta, con riconferma e prova del kit.
   */
  app.post(
    "/pending/:personKeyId/confirm",
    {
      config: { access: { kind: "user" }, desktopVault: true },
      schema: {
        params: personKeyParams,
        body: vaultConfirmBodySchema,
        response: { 200: vaultConfirmResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = request.user!;
      if (!(await requireVaultCaller(app.db, request, reply))) return reply;
      if (!(await actorProofOk(reply, user, request.body.actorProof))) return reply;
      return confirm(reply, user, request.params.personKeyId, request.body.copies, false);
    },
  );

  /** Rifiuta una chiave `pending`: non riceve nulla e va ricreata. Con la prova della propria chiave. */
  app.post(
    "/pending/:personKeyId/reject",
    {
      config: { access: { kind: "user" }, desktopVault: true },
      schema: { params: personKeyParams, body: vaultRejectBodySchema, response: { 204: z.null(), ...errorResponses } },
    },
    async (request, reply) => {
      const user = request.user!;
      if (!(await requireVaultCaller(app.db, request, reply))) return reply;
      if (!(await actorProofOk(reply, user, request.body.actorProof))) return reply;
      const outcome = await rejectPersonKey(app.db, actorOf(user), request.params.personKeyId);
      if (outcome.ok) return reply.code(204).send(null);
      switch (outcome.error) {
        case "vault_not_active":
          return vaultNotActive(reply);
        case "not_found":
          return keyNotFound(reply);
        case "own_key":
          return apiError(reply, 403, "own_key", "You cannot reject your own vault key");
        case "not_pending":
          return apiError(reply, 409, "not_pending", "Only a pending key can be rejected");
        case "forbidden":
          return apiError(reply, 403, "forbidden", "Missing permission");
      }
    },
  );

  function proofInvalid(reply: FastifyReply): FastifyReply {
    return apiError(reply, 403, "recovery_proof_invalid", "Recovery kit proof missing, wrong, expired or already used");
  }

  /**
   * Recupero, primo passo: una sfida da aprire col kit (`recovery-challenge.ts`).
   * Le due rotte dopo vogliono la prova: senza, «usare il kit» sarebbe solo
   * «full admin con secondo fattore fresco», e un login rubato potrebbe
   * confermarsi da sé una chiave appena creata.
   */
  app.post(
    "/recovery/challenge",
    {
      config: { access: { kind: "instance", permission: "instance.full_admin" }, reauth: true },
      schema: { response: { 201: vaultRecoveryChallengeResponseSchema, ...errorResponses } },
    },
    async (request, reply) => {
      const challenge = await createRecoveryChallenge(app.db, request.user!);
      if (!challenge) return vaultNotActive(reply);
      return reply.code(201).send(challenge);
    },
  );

  /**
   * Recupero: TUTTI gli accessi in attesa (anche i propri) con la copia di
   * recupero di ogni credenziale, da aprire nel browser con il kit. Full
   * admin con riconferma recente e prova del kit (design «Kit di recupero»).
   * È un POST perché porta la prova nel corpo; la verifica senza consumarla
   * (la conferma sì).
   */
  app.post(
    "/recovery/pending",
    {
      config: { access: { kind: "instance", permission: "instance.full_admin" }, reauth: true },
      schema: {
        body: vaultRecoveryPendingBodySchema,
        response: { 200: vaultPendingResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      if (!(await checkRecoveryProof(app.db, request.user!, request.body, false))) return proofInvalid(reply);
      return reply.code(200).send({ items: await listPendingForRecovery(app.db) });
    },
  );

  /**
   * Conferma col kit di recupero: rotta a sé perché la riconferma recente è
   * per rotta (`config.reauth`), e qui la vuole sempre. Full admin con la
   * prova del kit, che la conferma CONSUMA (una sfida per conferma); anche la
   * propria chiave. Registro di sicurezza e avviso agli altri full admin.
   */
  app.post(
    "/recovery/confirm/:personKeyId",
    {
      config: { access: { kind: "instance", permission: "instance.full_admin" }, reauth: true },
      schema: {
        params: personKeyParams,
        body: vaultRecoveryConfirmBodySchema,
        response: { 200: vaultConfirmResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      if (!(await checkRecoveryProof(app.db, request.user!, request.body, true))) return proofInvalid(reply);
      return confirm(reply, request.user!, request.params.personKeyId, request.body.copies, true);
    },
  );

  /* ── La cassaforte dal desktop: il sigillo del Mac (lotto 10, design
   *    `2026-11-24-cassaforte-desktop-design.md` §6 e §8). Le rotte con parte
   *    letterale (`/mine`) PRIMA di quelle parametriche (CLAUDE.md). ── */

  /**
   * SOLO il PAT desktop: `false` se la risposta è già partita. Con
   * l'interruttore `VAULT_DESKTOP` spento (il default) queste rotte non ci
   * sono per nessuno: 404.
   */
  function desktopOnly(reply: FastifyReply, user: SessionUser): user is SessionUser & { patId: string } {
    if (!app.vaultDesktop) {
      void vaultDesktopDisabled(reply);
      return false;
    }
    if (isDesktopPat(user)) return true;
    if (isPat(user)) void sessionRequired(reply);
    else void apiError(reply, 403, "desktop_required", "This action is for the desktop app");
    return false;
  }

  function pairingInvalid(reply: FastifyReply, code: 404 | 409): FastifyReply {
    return apiError(reply, code, "pairing_invalid", "This pairing is not valid any more");
  }

  function sealNotFound(reply: FastifyReply): FastifyReply {
    return apiError(reply, 404, "device_seal_not_found", "No vault seal for this device");
  }

  /** Il main, col suo PAT desktop, chiede di associare il Mac. */
  app.post(
    "/device-pairings",
    {
      // Review 2, M4: la riconferma del desktop DICHIARATA (il gate la
      // applica prima dell'handler e scrive la riga `reauth_desktop`).
      config: { access: { kind: "user" }, reauth: true, desktopOnly: true },
      schema: {
        body: vaultDevicePairingBodySchema,
        response: { 201: vaultDevicePairingResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = request.user!;
      // Review I2: un PAT desktop da solo non associa un Mac (rubato, più un
      // link mandato alla vittima, farebbe sigillare la chiave di persona per
      // un attaccante): la finestra di riconferma del desktop la chiede il
      // gate (`config.reauth`), prima di qui.
      if (!desktopOnly(reply, user)) return reply;
      const outcome = await createPairing(app.db, user, request.body);
      if (!outcome.ok) return vaultNotActive(reply);
      return reply.code(201).send(outcome.value);
    },
  );

  /** Il browser legge l'associazione (lo `state` nel corpo: non finisce nei log delle richieste). */
  app.post(
    "/device-pairings/lookup",
    {
      config: { access: { kind: "user" } },
      schema: {
        body: vaultDevicePairingLookupBodySchema,
        response: { 200: vaultDevicePairingLookupResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = request.user!;
      if (isPat(user)) return sessionRequired(reply);
      const found = await lookupPairing(app.db, user.id, request.body.state);
      if (!found) return pairingInvalid(reply, 404);
      return reply.code(200).send(found);
    },
  );

  /**
   * Il browser sigilla la propria chiave per il Mac: sessione con riconferma
   * recente (un PAT, anche desktop, mai: un Mac non si associa da sé) e la
   * prova della propria chiave confermata.
   */
  app.post(
    "/device-seals",
    {
      config: { access: { kind: "user" }, reauth: true },
      schema: {
        body: vaultDeviceSealBodySchema,
        response: { 201: vaultDeviceSealCreatedSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const outcome = await createSeal(app.db, request.user!, request.body);
      if (outcome.ok) return reply.code(201).send(outcome.value);
      if (outcome.error === "vault_key_not_confirmed") return keyNotConfirmed(reply);
      if (outcome.error === "vault_proof_invalid") {
        return apiError(reply, 403, "vault_proof_invalid", "Vault key proof missing, wrong, expired or already used");
      }
      return pairingInvalid(reply, 409);
    },
  );

  /** Il main scarica il SUO sigillo (quello legato al PAT che chiede), per aprirlo. */
  app.get(
    "/device-seals/mine",
    {
      config: { access: { kind: "user" }, desktopOnly: true },
      schema: { response: { 200: vaultDeviceSealMineSchema, ...errorResponses } },
    },
    async (request, reply) => {
      const user = request.user!;
      if (!desktopOnly(reply, user)) return reply;
      const mine = await mineSeal(app.db, user);
      if (!mine) return sealNotFound(reply);
      return reply.code(200).send(mine);
    },
  );

  /** «Dimentica questo Mac», logout, login di un altro: il main toglie il SUO sigillo. Idempotente. */
  app.delete(
    "/device-seals/mine",
    {
      config: { access: { kind: "user" }, desktopOnly: true },
      schema: { response: { 204: z.null(), ...errorResponses } },
    },
    async (request, reply) => {
      const user = request.user!;
      if (!desktopOnly(reply, user)) return reply;
      await revokeSeal(app.db, user, { patId: user.patId }, "forgotten", null);
      return reply.code(204).send(null);
    },
  );

  /**
   * I propri Mac (Impostazioni → Sicurezza): dal browser, o dal Mac col suo
   * sigillo vivo (decisione del maintainer, 25 nov 2026), che vede `current`
   * vero sul proprio.
   */
  app.get(
    "/device-seals",
    {
      config: { access: { kind: "user" }, desktopVault: true },
      schema: { response: { 200: vaultDeviceSealListSchema, ...errorResponses } },
    },
    async (request, reply) => {
      const caller = await requireVaultCaller(app.db, request, reply);
      if (!caller) return reply;
      const current = caller.via === "desktop" ? caller.sealId : null;
      return reply.code(200).send({ items: await listSeals(app.db, request.user!.id, current) });
    },
  );

  /**
   * Togliere un proprio Mac: il SOLO sigillo, il Mac resta collegato (D-5).
   * Dal browser, o (decisione del maintainer, 25 nov 2026) da un ALTRO Mac
   * della persona col suo sigillo vivo, la riconferma del desktop E la prova
   * della propria chiave (`actorProof`, decisione di 46 del 25 nov 2026: la
   * cassaforte è aperta, quindi il Touch ID è passato; la riconferma dice che
   * è la persona). Il proprio sigillo il Mac lo toglie con `DELETE .../mine`
   * (409 `use_mine`). Un Mac di un'altra persona → 404.
   */
  app.delete(
    "/device-seals/:id",
    {
      config: { access: { kind: "user" }, reauth: true, desktopVault: true },
      schema: {
        params: z.object({ id: z.uuid() }),
        // Dal browser il corpo non serve; dal Mac `actorProof` è obbligatorio (sotto).
        body: z.object({ actorProof: vaultActorProofSchema.optional() }).nullish(),
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = request.user!;
      const caller = await requireVaultCaller(app.db, request, reply);
      if (!caller) return reply;
      if (caller.via === "desktop" && caller.sealId === request.params.id) {
        return apiError(reply, 409, "use_mine", "To forget this Mac use DELETE /api/vault/device-seals/mine");
      }
      if (caller.via === "desktop") {
        // Review M9: prima il sigillo (della persona, vivo), POI la prova: un
        // id sbagliato non brucia la sfida.
        if (!(await ownLiveSeal(app.db, user.id, request.params.id))) return sealNotFound(reply);
        const proof = request.body?.actorProof;
        if (!proof || !(await consumeActorProof(app.db, user, proof))) {
          return apiError(reply, 403, "vault_proof_invalid", "Vault key proof missing, wrong, expired or already used");
        }
      }
      const from = caller.via === "desktop" ? { sealId: caller.sealId } : null;
      if (!(await revokeSeal(app.db, user, { id: request.params.id }, "removed", null, from))) return sealNotFound(reply);
      return reply.code(204).send(null);
    },
  );

  async function personOr404(reply: FastifyReply, userId: string): Promise<{ id: string; email: string } | null> {
    const [person] = await app.db.select({ id: users.id, email: users.email }).from(users).where(eq(users.id, userId));
    if (!person) {
      void apiError(reply, 404, "not_found", "Not found");
      return null;
    }
    return person;
  }

  /** I Mac di un'altra persona, per un full admin (D-6). */
  app.get(
    "/users/:userId/device-seals",
    {
      config: { access: { kind: "instance", permission: "instance.full_admin" } },
      schema: { params: z.object({ userId: z.uuid() }), response: { 200: vaultDeviceSealListSchema, ...errorResponses } },
    },
    async (request, reply) => {
      if (isPat(request.user!)) return sessionRequired(reply);
      const person = await personOr404(reply, request.params.userId);
      if (!person) return reply;
      return reply.code(200).send({ items: await listSeals(app.db, person.id) });
    },
  );

  /** Un full admin toglie il Mac di un'altra persona (Mac perso): il solo sigillo, registro e avviso (D-6). */
  app.delete(
    "/users/:userId/device-seals/:id",
    {
      config: { access: { kind: "instance", permission: "instance.full_admin" }, reauth: true },
      schema: {
        params: z.object({ userId: z.uuid(), id: z.uuid() }),
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      const person = await personOr404(reply, request.params.userId);
      if (!person) return reply;
      const actor = request.user!;
      const done = await revokeSeal(
        app.db,
        person,
        { id: request.params.id },
        "admin_removed",
        actor.id === person.id ? null : { id: actor.id, email: actor.email },
      );
      if (!done) return sealNotFound(reply);
      return reply.code(204).send(null);
    },
  );
}
