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
});
