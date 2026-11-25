// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppClientForTests } from "./client";
import { installFakeServer, me, PROJECT_ID } from "./fakeServer";
import * as vault from "./vaultReads";

// Fetta 2b dell'adattatore della cassaforte: le letture dalle rotte
// (`api-client`, gruppo `credentials` di 72), con le firme del prototipo.
// `access`, `canEdit`, `canShare` li calcola il server: il client legge.

const OTHER = "33333333-3333-4333-8333-333333333333";
const item = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  projectId: PROJECT_ID,
  service: "Aruba hosting",
  label: null,
  url: "https://admin.aruba.it",
  username: "admin@acquedotto",
  notes: null,
  createdByUserId: null,
  createdAt: "2026-11-20T10:00:00.000Z",
  updatedAt: "2026-11-21T10:00:00.000Z",
  updatedByUserId: null,
  access: "read",
  canEdit: true,
  canShare: true,
  ...over,
});
const C1 = "c1c1c1c1-0000-4000-8000-000000000001";
const C2 = "c2c2c2c2-0000-4000-8000-000000000002";

beforeEach(() => setAppClientForTests(null));
afterEach(() => vi.unstubAllGlobals());

describe("le letture della cassaforte, dalle rotte", () => {
  it("l'elenco di un progetto: l'accesso dal server (read → reads, pending → waiting, manage → manages)", async () => {
    installFakeServer({
      [`GET /api/projects/${PROJECT_ID}/credentials`]: {
        body: {
          items: [
            item(C1),
            item(C2, { service: "Stripe", access: "pending", canShare: false }),
            item(OTHER, { service: "Mailgun", access: "manage", canShare: false }),
          ],
        },
      },
    });
    const rows = await vault.listCredentials({ projectId: PROJECT_ID });
    expect(rows.map((r) => [r.service, r.access, r.canEdit, r.canShare])).toEqual([
      ["Aruba hosting", "reads", true, true],
      ["Stripe", "waiting", true, false],
      ["Mailgun", "manages", true, false],
    ]);
    expect(rows[0]).not.toHaveProperty("password");
  });

  it("la pagina Vault: «le mie» in tutti i progetti, filtrabili per progetto", async () => {
    installFakeServer({
      "GET /api/vault/credentials": {
        body: { items: [item(C1), item(C2, { projectId: OTHER, service: "Figma" })] },
      },
    });
    expect((await vault.listCredentials({})).map((r) => r.service)).toEqual([
      "Aruba hosting",
      "Figma",
    ]);
    setAppClientForTests(null);
    installFakeServer({
      "GET /api/vault/credentials": {
        body: { items: [item(C1), item(C2, { projectId: OTHER, service: "Figma" })] },
      },
    });
    expect((await vault.listCredentials({ projectIds: [OTHER] })).map((r) => r.service)).toEqual([
      "Figma",
    ]);
  });

  it("il dettaglio: tra «le mie», poi nei progetti che chi guarda gestisce; `null` se non la vede", async () => {
    installFakeServer({
      "GET /api/auth/me": {
        body: me({ projectPermissions: { [PROJECT_ID]: ["credentials.edit"] } }),
      },
      "GET /api/vault/credentials": { body: { items: [item(C1)] } },
      [`GET /api/projects/${PROJECT_ID}/credentials`]: {
        body: { items: [item(C1), item(C2, { service: "Mailgun", access: "manage" })] },
      },
    });
    expect((await vault.getCredential(C1))?.service).toBe("Aruba hosting");
    expect((await vault.getCredential(C2))?.access).toBe("manages");
    expect(await vault.getCredential(OTHER)).toBeNull();
  });

  it("l'entrata della sezione: c'è chi crea; chi gestisce vede il registro", async () => {
    installFakeServer({
      "GET /api/auth/me": {
        body: me({
          projectPermissions: { [PROJECT_ID]: ["credentials.create", "credentials.share"] },
        }),
      },
      [`GET /api/projects/${PROJECT_ID}/credentials`]: { body: { items: [] } },
    });
    expect(await vault.getCredentialsEntry(PROJECT_ID)).toEqual({
      show: true,
      waitingMe: false,
      canCreate: true,
      canSeeLog: true,
    });
  });

  it("l'entrata della pagina Vault: c'è con una credenziale o un progetto dove si crea", async () => {
    installFakeServer({
      "GET /api/auth/me": {
        body: me({
          projectPermissions: { [PROJECT_ID]: ["credentials.create"], [OTHER]: ["tickets.create"] },
        }),
      },
      "GET /api/vault/credentials": { body: { items: [] } },
    });
    expect(await vault.getVaultEntry()).toEqual({
      show: true,
      waitingMe: false,
      createProjectIds: [PROJECT_ID],
    });
  });

  // Fetta 2c: lettori, registro e «Share with».
  describe("lettori, registro e Share with", () => {
    const LAURA = "44444444-4444-4444-8444-444444444444";
    const MARCO = "55555555-5555-4555-8555-555555555555";
    const ROLE = "66666666-6666-4666-8666-666666666666";
    const people = [
      { id: LAURA, name: "Laura Costa", initials: "LC", departmentIds: [], email: "laura@x.test" },
      {
        id: MARCO,
        name: "Marco Bellini",
        initials: "MB",
        departmentIds: [],
        email: "marco@x.test",
      },
    ];

    it("i lettori: diretti (senza chi l'ha creata) ed effettivi con la fonte e il perché dell'attesa", async () => {
      installFakeServer({
        "GET /api/vault/credentials": { body: { items: [item(C1)] } },
        "GET /api/people": { body: people },
        [`GET /api/credentials/${C1}/readers`]: {
          body: {
            readers: [
              {
                id: "77777777-7777-4777-8777-777777777771",
                userId: LAURA,
                email: "laura@x.test",
                roleId: null,
                roleName: null,
                createdAt: "2026-11-20T10:00:00.000Z",
                creator: true,
              },
              {
                id: "77777777-7777-4777-8777-777777777772",
                userId: null,
                email: null,
                roleId: ROLE,
                roleName: "Developer",
                createdAt: "2026-11-21T10:00:00.000Z",
                creator: false,
              },
            ],
            people: [
              {
                userId: LAURA,
                email: "laura@x.test",
                fullAdmin: false,
                status: "can_read",
                keyStatus: "confirmed",
              },
              {
                userId: MARCO,
                email: "marco@x.test",
                fullAdmin: false,
                status: "pending",
                keyStatus: "pending",
              },
            ],
          },
        },
      });
      const r = await vault.listReaders(C1);
      expect(r.canShare).toBe(true);
      expect(r.direct).toEqual([
        {
          readerId: "77777777-7777-4777-8777-777777777772",
          kind: "role",
          id: ROLE,
          name: "Developer",
          addedAt: "2026-11-21T10:00:00.000Z",
        },
      ]);
      expect(r.effective.map((e) => [e.name, e.source, e.state])).toEqual([
        ["Laura Costa", "created", "reads"],
        ["Marco Bellini", "role", "key_pending"],
      ]);
    });

    it("il registro: da dove (desktop → mac), l'azione, il nome; chi non gestisce (403) riceve niente", async () => {
      installFakeServer({
        "GET /api/people": { body: people },
        [`GET /api/projects/${PROJECT_ID}/credentials/log`]: {
          body: {
            items: [
              {
                id: "88888888-8888-4888-8888-888888888881",
                credentialId: C1,
                credentialSnapshot: "Aruba hosting",
                userId: LAURA,
                userEmail: "laura@x.test",
                action: "show",
                via: "desktop",
                createdAt: "2026-11-25T09:00:00.000Z",
              },
            ],
          },
        },
      });
      expect(await vault.listAccessLog({ projectId: PROJECT_ID, credentialId: C1 })).toEqual([
        {
          id: "88888888-8888-4888-8888-888888888881",
          at: "2026-11-25T09:00:00.000Z",
          personId: LAURA,
          name: "Laura Costa",
          credentialId: C1,
          service: "Aruba hosting",
          action: "shown",
          via: "mac",
        },
      ]);
      setAppClientForTests(null);
      installFakeServer({
        "GET /api/people": { body: people },
        [`GET /api/projects/${PROJECT_ID}/credentials/log`]: {
          status: 403,
          body: { code: "forbidden", message: "x" },
        },
      });
      expect(await vault.listAccessLog({ projectId: PROJECT_ID })).toEqual([]);
    });

    it("Share with: persone e ruoli del progetto, tolti i già aggiunti; niente senza canShare", async () => {
      const members = [
        {
          userId: LAURA,
          email: "laura@x.test",
          avatarUrl: null,
          roleId: "99999999-9999-4999-8999-999999999991",
          roleName: "Project Lead",
          createdAt: "2026-11-01T10:00:00.000Z",
        },
        {
          userId: MARCO,
          email: "marco@x.test",
          avatarUrl: null,
          roleId: ROLE,
          roleName: "Developer",
          createdAt: "2026-11-01T10:00:00.000Z",
        },
      ];
      installFakeServer({
        "GET /api/vault/credentials": { body: { items: [item(C1)] } },
        "GET /api/people": { body: people },
        [`GET /api/projects/${PROJECT_ID}/members`]: { body: members },
        [`GET /api/credentials/${C1}/readers`]: {
          body: {
            readers: [
              {
                id: "77777777-7777-4777-8777-777777777772",
                userId: null,
                email: null,
                roleId: ROLE,
                roleName: "Developer",
                createdAt: "2026-11-21T10:00:00.000Z",
                creator: false,
              },
            ],
            people: [],
          },
        },
      });
      expect(await vault.listShareTargets(C1)).toEqual({
        people: [
          { personId: LAURA, name: "Laura Costa" },
          { personId: MARCO, name: "Marco Bellini" },
        ],
        roles: [{ roleId: "99999999-9999-4999-8999-999999999991", name: "Project Lead" }],
      });
      setAppClientForTests(null);
      installFakeServer({
        "GET /api/vault/credentials": { body: { items: [item(C1, { canShare: false })] } },
      });
      expect(await vault.listShareTargets(C1)).toEqual({ people: [], roles: [] });
    });
  });
});
