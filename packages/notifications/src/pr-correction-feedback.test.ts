import { randomBytes } from "node:crypto";
import { encrypt, gitAccounts, prCorrections } from "@stubwise/db";
import { seedTicket, startTestDb, type TestDb } from "@stubwise/db/testing";
import type { PrComment } from "@stubwise/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  decryptGitCredentials,
  providerFeedbackCutoff,
  resolveProviderUserId,
  isTrustedAuthorAssociation,
  selectProviderFeedback,
  TRUSTED_AUTHOR_ASSOCIATIONS,
} from "./pr-correction-feedback.js";

/**
 * Identità degli account di Stubwise sulla piattaforma e fotografia dei
 * commenti della PR (ciclo di correzione, design §4-§5). Condivisi fra il
 * webhook del server e il worker: le due copie di «cosa ha già letto l'AI»
 * non devono poter divergere.
 */

let testDb: TestDb;
const KEY = randomBytes(32);

beforeAll(async () => {
  testDb = await startTestDb();
}, 120_000);

afterAll(async () => {
  await testDb.stop();
});

async function seedAccount(opts: {
  provider?: "github" | "bitbucket";
  providerUserId?: string | null;
  encryptedCredentials?: string;
} = {}) {
  const [row] = await testDb.db
    .insert(gitAccounts)
    .values({
      name: `Account ${randomBytes(3).toString("hex")}`,
      provider: opts.provider ?? "github",
      encryptedCredentials:
        opts.encryptedCredentials ?? encrypt(JSON.stringify({ username: "bot", token: "tok" }), KEY),
      providerUserId: opts.providerUserId ?? null,
    })
    .returning();
  return row!;
}

async function storedId(id: string): Promise<string | null> {
  const [row] = await testDb.db
    .select({ providerUserId: gitAccounts.providerUserId })
    .from(gitAccounts)
    .where(eq(gitAccounts.id, id));
  return row!.providerUserId;
}

describe("decryptGitCredentials", () => {
  it("decifra le credenziali di un account", () => {
    const blob = encrypt(JSON.stringify({ username: "bot", token: "tok" }), KEY);
    expect(decryptGitCredentials(blob, KEY)).toEqual({ username: "bot", token: "tok" });
  });

  it("null su un blob non decifrabile o senza token, mai un'eccezione", () => {
    expect(decryptGitCredentials("blob-rotto", KEY)).toBeNull();
    expect(decryptGitCredentials(encrypt(JSON.stringify({ username: "bot" }), KEY), KEY)).toBeNull();
  });
});

describe("resolveProviderUserId", () => {
  it("risolve l'identità al primo uso, con le credenziali DECIFRATE, e la salva", async () => {
    const fetchIdentity = vi.fn().mockResolvedValue("1001");
    const account = await seedAccount();

    expect(await resolveProviderUserId(testDb.db, KEY, account, fetchIdentity)).toBe("1001");
    expect(await storedId(account.id)).toBe("1001");
    expect(fetchIdentity).toHaveBeenCalledWith({
      provider: "github",
      credentials: { username: "bot", token: "tok" },
    });
  });

  it("un'identità già salvata non chiama il provider", async () => {
    const fetchIdentity = vi.fn().mockResolvedValue("9999");
    const account = await seedAccount({ providerUserId: "1001" });

    expect(await resolveProviderUserId(testDb.db, KEY, account, fetchIdentity)).toBe("1001");
    expect(fetchIdentity).not.toHaveBeenCalled();
  });

  it("con refresh la richiede comunque, e sovrascrive quella salvata", async () => {
    const fetchIdentity = vi.fn().mockResolvedValue("2002");
    const account = await seedAccount({ providerUserId: "1001" });

    expect(await resolveProviderUserId(testDb.db, KEY, account, fetchIdentity, { refresh: true })).toBe("2002");
    expect(await storedId(account.id)).toBe("2002");
  });

  it("errore del provider (es. 403 per lo scope mancante su Bitbucket): null, colonna intatta", async () => {
    const fetchIdentity = vi.fn().mockRejectedValue(new Error("403"));
    const account = await seedAccount({ provider: "bitbucket" });

    expect(await resolveProviderUserId(testDb.db, KEY, account, fetchIdentity)).toBeNull();
    expect(await storedId(account.id)).toBeNull();
  });

  it("errore del provider: onError riceve l'errore, il risultato resta null", async () => {
    const failure = new Error("Bitbucket: il token non può leggere la propria identità (403)");
    const fetchIdentity = vi.fn().mockRejectedValue(failure);
    const onError = vi.fn();
    const account = await seedAccount({ provider: "bitbucket" });

    expect(await resolveProviderUserId(testDb.db, KEY, account, fetchIdentity, { onError })).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(failure);
    expect(await storedId(account.id)).toBeNull();
  });

  it("un onError che lancia non cambia l'esito: null, mai un'eccezione", async () => {
    const fetchIdentity = vi.fn().mockRejectedValue(new Error("401"));
    const onError = vi.fn(() => {
      throw new Error("logger rotto");
    });
    const account = await seedAccount();

    await expect(resolveProviderUserId(testDb.db, KEY, account, fetchIdentity, { onError })).resolves.toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("identità risolta: onError non viene chiamato", async () => {
    const onError = vi.fn();
    const account = await seedAccount();
    expect(
      await resolveProviderUserId(testDb.db, KEY, account, vi.fn().mockResolvedValue("1001"), { onError })
    ).toBe("1001");
    expect(onError).not.toHaveBeenCalled();
  });

  it("race col PATCH delle credenziali: l'id del token vecchio non riscrive la cache (fail-closed)", async () => {
    const account = await seedAccount();
    const fetchIdentity = vi.fn().mockImplementation(async () => {
      // Mentre il provider risponde, un PATCH cambia le credenziali e azzera la cache.
      await testDb.db
        .update(gitAccounts)
        .set({
          encryptedCredentials: encrypt(JSON.stringify({ username: "bot", token: "nuovo" }), KEY),
          providerUserId: null,
        })
        .where(eq(gitAccounts.id, account.id));
      return "1001";
    });

    expect(await resolveProviderUserId(testDb.db, KEY, account, fetchIdentity)).toBeNull();
    expect(await storedId(account.id)).toBeNull();
  });

  it("credenziali non decifrabili: null senza chiamare il provider", async () => {
    const fetchIdentity = vi.fn().mockResolvedValue("1001");
    const account = await seedAccount({ encryptedCredentials: "blob-rotto" });

    expect(await resolveProviderUserId(testDb.db, KEY, account, fetchIdentity)).toBeNull();
    expect(fetchIdentity).not.toHaveBeenCalled();
  });
});

describe("providerFeedbackCutoff", () => {
  it("nessuna correzione con fotografia: nessun taglio", async () => {
    const { ticketId, repositoryId } = await seedTicket(testDb.db);
    // Una correzione AUTOMATICA conclusa non ha fotografato la PR: non taglia.
    await testDb.db.insert(prCorrections).values({
      ticketId,
      repositoryId,
      prNumber: 42,
      trigger: "review",
      status: "done",
    });

    expect(await providerFeedbackCutoff(testDb.db, { repositoryId, prNumber: 42 })).toBeNull();
  });

  it("l'ultima correzione CONCLUSA con fotografia, sulla STESSA PR", async () => {
    const { ticketId, repositoryId } = await seedTicket(testDb.db);
    const at = (iso: string) => new Date(iso);
    await testDb.db.insert(prCorrections).values([
      { ticketId, repositoryId, prNumber: 42, trigger: "provider", status: "done", providerFeedback: [], feedbackComplete: true, createdAt: at("2026-09-30T08:00:00Z") },
      { ticketId, repositoryId, prNumber: 42, trigger: "stubwise", status: "done", providerFeedback: [], feedbackComplete: true, createdAt: at("2026-09-30T09:00:00Z") },
      // Non conclusa, o annullata: non ha consegnato niente all'AI.
      { ticketId, repositoryId, prNumber: 42, trigger: "provider", status: "cancelled", providerFeedback: [], feedbackComplete: true, createdAt: at("2026-09-30T10:00:00Z") },
      // Un'altra PR dello stesso repository.
      { ticketId, repositoryId, prNumber: 43, trigger: "provider", status: "done", providerFeedback: [], feedbackComplete: true, createdAt: at("2026-09-30T11:00:00Z") },
    ]);

    expect(await providerFeedbackCutoff(testDb.db, { repositoryId, prNumber: 42 })).toEqual(
      at("2026-09-30T09:00:00Z"),
    );
  });
  it("E1: una fotografia INCOMPLETA (lettura dei commenti fallita) non fa da taglio", async () => {
    const { ticketId, repositoryId } = await seedTicket(testDb.db);
    const at = (iso: string) => new Date(iso);
    await testDb.db.insert(prCorrections).values([
      { ticketId, repositoryId, prNumber: 42, trigger: "provider", status: "done", providerFeedback: [], feedbackComplete: true, createdAt: at("2026-09-30T08:00:00Z") },
      // Conclusa, con una fotografia (quella minima del webhook), ma la lettura
      // dei commenti dal provider è fallita: quelli scritti prima non li ha
      // mai visti nessuno, quindi non può spostare il taglio in avanti.
      { ticketId, repositoryId, prNumber: 42, trigger: "provider", status: "done", providerFeedback: [], feedbackComplete: false, createdAt: at("2026-09-30T09:00:00Z") },
    ]);

    expect(await providerFeedbackCutoff(testDb.db, { repositoryId, prNumber: 42 })).toEqual(
      at("2026-09-30T08:00:00Z"),
    );
  });
});

describe("selectProviderFeedback", () => {
  const comment = (id: string, authorId: string, createdAt: string): PrComment => ({
    id,
    authorId,
    authorLogin: `login-${authorId}`,
    body: `commento ${id}`,
    createdAt,
    path: null,
    line: null,
  });

  it("esclude gli account propri e i commenti fino al taglio compreso", () => {
    const comments = [
      comment("vecchio", "5150", "2026-09-30T08:59:00.000Z"),
      comment("al-taglio", "5150", "2026-09-30T09:00:00.000Z"),
      comment("nuovo", "5150", "2026-09-30T09:01:00.000Z"),
      comment("del-bot", "1001", "2026-09-30T09:02:00.000Z"),
    ];

    const kept = selectProviderFeedback(comments, {
      cutoff: new Date("2026-09-30T09:00:00.000Z"),
      ownIds: ["1001", "1002"],
      provider: "bitbucket",
    });

    expect(kept.map((c) => c.id)).toEqual(["nuovo"]);
  });

  it("una data non parsabile il commento lo TIENE (errore per eccesso)", () => {
    const kept = selectProviderFeedback([comment("strano", "5150", "non-una-data")], {
      cutoff: new Date("2026-09-30T09:00:00.000Z"),
      ownIds: ["1001"],
      provider: "bitbucket",
    });
    expect(kept.map((c) => c.id)).toEqual(["strano"]);
  });

  it("senza taglio tiene tutto ciò che non è di Stubwise", () => {
    const kept = selectProviderFeedback(
      [comment("a", "5150", "2026-01-01T00:00:00.000Z"), comment("b", "1002", "2026-01-01T00:00:00.000Z")],
      { cutoff: null, ownIds: ["1001", "1002"], provider: "bitbucket" },
    );
    expect(kept.map((c) => c.id)).toEqual(["a"]);
  });

  describe("chi ha il permesso di chiedere modifiche", () => {
    const by = (id: string, authorAssociation: string | null | undefined): PrComment => ({
      ...comment(id, `autore-${id}`, "2026-09-30T10:00:00.000Z"),
      ...(authorAssociation === undefined ? {} : { authorAssociation }),
    });
    const mixed = [
      by("owner", "OWNER"),
      by("member", "MEMBER"),
      by("collaborator", "COLLABORATOR"),
      by("contributor", "CONTRIBUTOR"),
      by("none", "NONE"),
      by("first-time", "FIRST_TIME_CONTRIBUTOR"),
      by("null", null),
      // fotografia salvata prima del campo
      by("assente", undefined),
      // GitHub la manda maiuscola: una minuscola non è il valore di GitHub
      by("minuscolo", "owner"),
    ];

    it("GitHub: tiene owner, membri e collaboratori; scarta tutti gli altri, null e assente compresi", () => {
      const kept = selectProviderFeedback(mixed, { cutoff: null, ownIds: [], provider: "github" });
      expect(kept.map((c) => c.id)).toEqual(["owner", "member", "collaborator"]);
    });

    it("Bitbucket: nessun dato di associazione, tiene tutto (rischio documentato)", () => {
      const kept = selectProviderFeedback(mixed, { cutoff: null, ownIds: [], provider: "bitbucket" });
      expect(kept.map((c) => c.id)).toEqual(mixed.map((c) => c.id));
    });

    it("il filtro sull'autore non scavalca gli altri: un OWNER che è un account di Stubwise resta fuori", () => {
      const kept = selectProviderFeedback([by("bot", "OWNER")], {
        cutoff: null,
        ownIds: ["autore-bot"],
        provider: "github",
      });
      expect(kept).toEqual([]);
    });
  });
});

describe("isTrustedAuthorAssociation", () => {
  it("l'elenco è esattamente owner, membri, collaboratori", () => {
    expect([...TRUSTED_AUTHOR_ASSOCIATIONS]).toEqual(["OWNER", "MEMBER", "COLLABORATOR"]);
  });

  it("GitHub: ammessi solo i tre valori; null e assente fail-closed", () => {
    for (const a of ["OWNER", "MEMBER", "COLLABORATOR"]) {
      expect(isTrustedAuthorAssociation(a, "github")).toBe(true);
    }
    for (const a of ["CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", "MANNEQUIN", "NONE", "", "owner"]) {
      expect(isTrustedAuthorAssociation(a, "github")).toBe(false);
    }
    expect(isTrustedAuthorAssociation(null, "github")).toBe(false);
    expect(isTrustedAuthorAssociation(undefined, "github")).toBe(false);
  });

  it("Bitbucket: sempre ammesso, anche senza dato", () => {
    expect(isTrustedAuthorAssociation(null, "bitbucket")).toBe(true);
    expect(isTrustedAuthorAssociation(undefined, "bitbucket")).toBe(true);
  });
});
