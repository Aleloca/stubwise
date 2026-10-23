import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  credentialKeyCopies,
  credentials,
  RECOVERY_RECIPIENT_ID,
  userPasskeys,
  vaultPersonKeySeals,
  vaultPersonKeys,
  vaultSettings,
} from "@stubwise/db";
import {
  vaultActivateBodySchema,
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
} from "@stubwise/shared";
import { recordSecurityEvent } from "../auth/second-factor/security-events.js";
import type { SessionUser } from "../auth/session.js";
import { apiError } from "../errors.js";
import { publishVaultKeyCreated } from "../vault/alerts.js";
import {
  confirmPersonKey,
  listPending,
  listPendingForRecovery,
  rejectPersonKey,
  type ConfirmError,
  type VaultActor,
} from "../vault/pending.js";
import { currentPersonKey } from "../vault/readers.js";
import { checkRecoveryProof, createRecoveryChallenge } from "../vault/recovery-challenge.js";
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
 * Tutte le rotte sono SOLO da sessione: un PAT riceve 403
 * `session_required` — dal gate della riconferma per le scritture
 * (`config.reauth`), esplicitamente per le letture. Un token non scarica mai
 * la propria chiave sigillata né attiva o rigenera nulla.
 */
export async function vaultRoutes(instance: FastifyInstance): Promise<void> {
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
   * della passkey appena usata. Mai la privata sigillata: quella la dà
   * `/keys/mine`.
   */
  app.get(
    "/status",
    {
      config: { access: { kind: "user" } },
      schema: { response: { 200: vaultStatusResponseSchema, ...errorResponses } },
    },
    async (request, reply) => {
      const user = request.user!;
      if (isPat(user)) return sessionRequired(reply);
      const [settings] = await app.db.select({ id: vaultSettings.id }).from(vaultSettings);
      const [key] = await app.db
        .select({
          id: vaultPersonKeys.id,
          status: vaultPersonKeys.status,
          createdAt: vaultPersonKeys.createdAt,
        })
        .from(vaultPersonKeys)
        .where(eq(vaultPersonKeys.userId, user.id))
        .orderBy(desc(vaultPersonKeys.createdAt))
        .limit(1);
      // Una chiave rifiutata non si apre più: nessun sigillo da proporre.
      const seals = key && key.status !== "rejected" ? await sealsOf(key.id) : [];
      return reply.code(200).send({
        activated: settings !== undefined,
        myKey: key
          ? { id: key.id, status: key.status, createdAt: key.createdAt.toISOString() }
          : null,
        seals: seals.map(({ passkeyId, credentialIdB64url }) => ({ passkeyId, credentialIdB64url })),
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
      const inserted = await app.db
        .insert(vaultSettings)
        .values({ id: 1, recoveryPublicKey: request.body.recoveryPublicKey, activatedByUserId: request.user!.id })
        .onConflictDoNothing({ target: vaultSettings.id })
        .returning({ id: vaultSettings.id });
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
        await tx
          .insert(vaultPersonKeySeals)
          .values({ personKeyId: key.id, passkeyId, sealedPrivateKey })
          .onConflictDoUpdate({
            target: [vaultPersonKeySeals.personKeyId, vaultPersonKeySeals.passkeyId],
            set: { sealedPrivateKey },
          });
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
   * Rigenera il kit di recupero: la chiave pubblica nuova e la copia della
   * chiave di OGNI credenziale cifrata per lei, tutte insieme. Se `copies`
   * non copre ESATTAMENTE le credenziali di adesso (una creata o tolta nel
   * frattempo) → 409 `recipients_changed` e nessuna riga scritta: la
   * vecchia chiave di recupero resterebbe l'unica a leggere quella che manca.
   * La riga di `vault_settings` si blocca per la transazione.
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
      const { recoveryPublicKey, copies } = request.body;
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
      config: { access: { kind: "user" } },
      schema: { response: { 200: vaultPendingResponseSchema, ...errorResponses } },
    },
    async (request, reply) => {
      const user = request.user!;
      if (isPat(user)) return sessionRequired(reply);
      return reply.code(200).send({ items: await listPending(app.db, user.id) });
    },
  );

  /**
   * Conferma una chiave e passa le credenziali che chi conferma può dare
   * (`vault/pending.ts` per le regole). Mai la propria chiave. Il recupero ha
   * la sua rotta, con riconferma.
   */
  app.post(
    "/pending/:personKeyId/confirm",
    {
      config: { access: { kind: "user" } },
      schema: {
        params: personKeyParams,
        body: vaultConfirmBodySchema,
        response: { 200: vaultConfirmResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = request.user!;
      if (isPat(user)) return sessionRequired(reply);
      return confirm(reply, user, request.params.personKeyId, request.body.copies, false);
    },
  );

  /** Rifiuta una chiave `pending`: non riceve nulla e va ricreata. */
  app.post(
    "/pending/:personKeyId/reject",
    {
      config: { access: { kind: "user" } },
      schema: { params: personKeyParams, response: { 204: z.null(), ...errorResponses } },
    },
    async (request, reply) => {
      const user = request.user!;
      if (isPat(user)) return sessionRequired(reply);
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
}
