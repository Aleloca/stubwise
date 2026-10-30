import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { memo, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { admin, failNext, resetApi, setLatency } from "../api";
import { accessState, roleIdOf, writeAccess } from "../access/index";
import { markReauthenticated } from "../auth/reauth";
import { useMembers, useSetMemberRole } from "../queries";
import { CLAUDE_ID } from "../seed/people";
import { setSessionPersonId } from "../session";
import { state } from "../store";
import {
  ViewerProvider,
  can,
  grantProjectPermission,
  revokeProjectPermission,
  useViewer,
  viewerFor,
  type LocalProjectPermission,
} from "../viewer";
import type { AdminResult } from "./types";

// Members del progetto nel livello dati (area 9a, Task 4).

const ACQ = "prj-acq";
const NVS = "prj-nvs";
/** Un progetto di cui Sara non è membro. */
const AUD = "prj-aud";

const as = (personId: string) => setSessionPersonId(personId);
const reauth = (personId: string) => markReauthenticated(personId);
const rowOf = async (projectId: string, personId: string) =>
  (await admin.listProjectMembers(projectId)).members.find((m) => m.personId === personId);

function snapshot(): string {
  return JSON.stringify({
    access: accessState(),
    memberIds: state.projects.map((p) => p.memberIds),
  });
}

async function refused(
  call: () => Promise<AdminResult<object>>,
  expected: Partial<{ error: string; reason: string; missing: string[] }>,
) {
  const before = snapshot();
  const entries = state.changelog.length;
  expect(await call()).toMatchObject({ ok: false, ...expected });
  expect(snapshot()).toBe(before);
  expect(state.changelog.length).toBe(entries);
}

beforeEach(() => {
  resetApi();
  setLatency(0);
  // Questi test provano il meccanismo del registro: partono senza le voci
  // del seme (che prova `pages/admin/Audit.test.tsx`).
  state.changelog.splice(0);
});
afterEach(() => resetApi());

describe("l'elenco", () => {
  it("Marco su ACQ: servers.operate in più, «given by» Roberta (seme con autore)", async () => {
    as("p-laura");
    const marco = (await rowOf(ACQ, "p-marco"))!;
    expect(marco.role.key).toBe("developer");
    expect(marco.extra).toEqual([
      {
        permission: "servers.operate",
        granted: true,
        sources: [
          {
            kind: "grant",
            grantedById: "p-roberta",
            grantedByName: "Roberta Fontana",
            at: expect.any(String),
            origin: "given",
          },
        ],
      },
    ]);
  });

  it("una concessione senza autore si legge «from the seed»", async () => {
    grantProjectPermission("p-federico", ACQ, "servers.operate");
    as("p-laura");
    expect((await rowOf(ACQ, "p-federico"))!.extra[0]!.sources[0]).toMatchObject({
      kind: "grant",
      grantedById: null,
      grantedByName: null,
      origin: "seed",
    });
  });

  it("un permesso dal reparto è in più solo se il ruolo non lo dà, con il nome del reparto", async () => {
    writeAccess((s) => {
      s.departments
        .find((d) => d.departmentId === "dep-support")!
        .projectPermissions.push("drive.history");
    });
    as("p-laura");
    // Sara (Support, Contributor in ACQ): drive.history viene solo dal reparto.
    expect((await rowOf(ACQ, "p-sara"))!.extra).toEqual([
      {
        permission: "drive.history",
        granted: false,
        sources: [{ kind: "department", departmentId: "dep-support", departmentName: "Support" }],
      },
    ]);
    // Marco ha support.reply dal ruolo E da Development: non è «in più».
    expect((await rowOf(ACQ, "p-marco"))!.extra.map((e) => e.permission)).not.toContain(
      "support.reply",
    );
  });

  it("né Claude né i full admin sono righe; la nota sui full admin c'è", async () => {
    as("p-roberta");
    // Roberta è membro esplicito di TLM, come Claude.
    const tlm = await admin.listProjectMembers("prj-tlm");
    expect(tlm.members.map((m) => m.personId)).not.toContain("p-roberta");
    expect(tlm.members.map((m) => m.personId)).not.toContain(CLAUDE_ID);
    expect(tlm.fullAdminNote).toBe(true);
    // Simone, disattivato, resta in fondo.
    expect(tlm.members.at(-1)).toMatchObject({ personId: "p-simone", status: "deactivated" });
    expect(tlm.addable).not.toContain("p-simone");
    expect(tlm.addable).not.toContain("p-roberta");
    expect(tlm.addable).not.toContain(CLAUDE_ID);
    expect(tlm.addable).not.toContain("p-marco");
  });

  it("i membri leggono senza azioni; R-G5 su un progetto che non si vede", async () => {
    as("p-sara");
    const acq = await admin.listProjectMembers(ACQ);
    expect(acq.canManage).toBe(false);
    expect(acq.grantable.every((g) => !g.allowed)).toBe(true);
    await expect(admin.listProjectMembers(AUD)).rejects.toThrow("not_found");
    await expect(admin.listProjectMembers("prj-nope")).rejects.toThrow("not_found");
    reauth("p-sara");
    await refused(() => admin.addMember(AUD, "p-giulia", roleIdOf("viewer")), {
      error: "not_found",
    });
  });

  it("le revoche non si mostrano", async () => {
    revokeProjectPermission("p-marco", ACQ, "servers.operate");
    as("p-laura");
    expect((await rowOf(ACQ, "p-marco"))!.extra).toEqual([]);
  });
});

describe("dare e togliere", () => {
  beforeEach(() => {
    as("p-laura");
    reauth("p-laura");
  });

  it("plans.approve a Marco da Laura: va solo se Laura lo ha", async () => {
    expect(await admin.grantMemberPermission(ACQ, "p-marco", "plans.approve")).toEqual({
      ok: true,
    });
    expect(can(viewerFor("p-marco"), "plans.approve", ACQ)).toBe(true);
    expect(state.changelog.at(-1)).toMatchObject({
      kind: "member.permission_granted",
      actorId: "p-laura",
      projectId: ACQ,
      params: { permission: "plans.approve", project: "ACQ" },
    });
    // Senza plans.approve, Laura non lo dà a Federico.
    revokeProjectPermission("p-laura", ACQ, "plans.approve" as LocalProjectPermission);
    await refused(() => admin.grantMemberPermission(ACQ, "p-federico", "plans.approve"), {
      error: "escalation",
      missing: ["plans.approve"],
    });
  });

  it("servers.operate, che Laura non ha su ACQ: escalation; ma lo toglie a Marco", async () => {
    await refused(() => admin.grantMemberPermission(ACQ, "p-federico", "servers.operate"), {
      error: "escalation",
      missing: ["servers.operate"],
    });
    expect(await admin.revokeMemberPermission(ACQ, "p-marco", "servers.operate")).toEqual({
      ok: true,
    });
    expect(can(viewerFor("p-marco"), "servers.operate", ACQ)).toBe(false);
  });

  it("chi dà un permesso che ha solo dal reparto lo può dare", async () => {
    // Marco gestisce i membri di ACQ (concessione); drive.manage gli viene solo da Development.
    writeAccess((s) => {
      s.grants.push({
        personId: "p-marco",
        projectId: ACQ,
        permission: "project.members.manage",
        grantedById: "p-roberta",
        at: "2026-10-01T10:00:00Z",
      });
      s.departments
        .find((d) => d.departmentId === "dep-development")!
        .projectPermissions.push("drive.manage");
    });
    as("p-marco");
    reauth("p-marco");
    expect(await admin.grantMemberPermission(ACQ, "p-sara", "drive.manage")).toEqual({ ok: true });
    writeAccess((s) => {
      const d = s.departments.find((x) => x.departmentId === "dep-development")!;
      d.memberIds = d.memberIds.filter((id) => id !== "p-marco");
    });
    await refused(() => admin.grantMemberPermission(ACQ, "p-matteo", "drive.manage"), {
      error: "escalation",
      missing: ["drive.manage"],
    });
  });

  it("un ruolo assegnato dà ciò che aggiunge: Release manager sì, un ruolo più piccolo sempre", async () => {
    revokeProjectPermission("p-laura", ACQ, "release.merge" as LocalProjectPermission);
    await refused(() => admin.setMemberRole(ACQ, "p-marco", roleIdOf("rm-1")), {
      error: "escalation",
      missing: ["release.merge"],
    });
    const choices = (await admin.listProjectMembers(ACQ)).roleChoices;
    expect(choices.find((c) => c.roleId === roleIdOf("rm-1"))!.missing).toEqual(["release.merge"]);
    expect(choices.find((c) => c.roleId === roleIdOf("developer"))!.missing).toEqual([]);
    // Verso un ruolo contenuto non passa dall'anti-escalation: neanche se a
    // Laura manca un permesso che Marco aveva già (docs.view).
    revokeProjectPermission("p-laura", ACQ, "docs.view" as LocalProjectPermission);
    expect(await admin.setMemberRole(ACQ, "p-marco", roleIdOf("viewer"))).toEqual({ ok: true });
  });

  it("cambiare ruolo azzera le revoche nel progetto", async () => {
    revokeProjectPermission("p-marco", ACQ, "drive.upload");
    expect(can(viewerFor("p-marco"), "drive.upload", ACQ)).toBe(false);
    await admin.setMemberRole(ACQ, "p-marco", roleIdOf("rm-1"));
    expect(accessState().revocations).toEqual([]);
    expect(can(viewerFor("p-marco"), "drive.upload", ACQ)).toBe(true);
  });

  it("chi esce perde le concessioni del progetto: rientrando non le ritrova", async () => {
    expect(await admin.removeMember(ACQ, "p-marco")).toEqual({ ok: true });
    expect(state.projectsById.get(ACQ)!.memberIds).not.toContain("p-marco");
    expect(accessState().grants.filter((g) => g.personId === "p-marco")).toEqual([]);
    expect(await admin.addMember(ACQ, "p-marco", roleIdOf("developer"))).toEqual({ ok: true });
    expect((await rowOf(ACQ, "p-marco"))!.extra).toEqual([]);
    expect(state.projectsById.get(ACQ)!.memberIds).toContain("p-marco");
  });

  it("non si aggiunge Claude, un full admin, un disattivato, chi c'è già", async () => {
    await refused(() => admin.addMember(ACQ, CLAUDE_ID, roleIdOf("developer")), {
      error: "not_found",
    });
    await refused(() => admin.addMember(ACQ, "p-roberta", roleIdOf("developer")), {
      reason: "full_admin",
    });
    await refused(() => admin.addMember(ACQ, "p-simone", roleIdOf("developer")), {
      reason: "deactivated",
    });
    await refused(() => admin.addMember(ACQ, "p-marco", roleIdOf("developer")), {
      reason: "already_member",
    });
    await refused(() => admin.addMember(ACQ, "p-giulia", roleIdOf("user")), { reason: "role" });
  });
});

describe("RF 3: chi gestisce i membri", () => {
  beforeEach(() => {
    // Su ACQ, Laura è l'unica membro con project.members.manage (Matteo torna Developer).
    writeAccess((s) => {
      s.memberships.find((m) => m.personId === "p-matteo" && m.projectId === ACQ)!.roleId =
        roleIdOf("developer");
    });
    as("p-laura");
    reauth("p-laura");
  });

  it("Laura si toglie project.members.manage su ACQ: Roberta, full admin, conta → ammesso", async () => {
    expect(await admin.setMemberRole(ACQ, "p-laura", roleIdOf("developer"))).toEqual({ ok: true });
    expect(can(viewerFor("p-laura"), "project.members.manage", ACQ)).toBe(false);
  });

  it("senza full admin attivi, l'ultimo gestore non si toglie né esce", async () => {
    writeAccess((s) => {
      s.people.find((p) => p.personId === "p-roberta")!.instanceRoleId = roleIdOf("user");
    });
    await refused(() => admin.setMemberRole(ACQ, "p-laura", roleIdOf("developer")), {
      reason: "last_members_manager",
    });
    await refused(() => admin.removeMember(ACQ, "p-laura"), { reason: "last_members_manager" });
    // Un secondo gestore sblocca.
    expect(await admin.setMemberRole(ACQ, "p-marco", roleIdOf("project_lead"))).toEqual({
      ok: true,
    });
    expect(await admin.removeMember(ACQ, "p-laura")).toEqual({ ok: true });
  });

  it("vale anche togliendo una concessione di project.members.manage", async () => {
    writeAccess((s) => {
      s.people.find((p) => p.personId === "p-roberta")!.instanceRoleId = roleIdOf("user");
      s.memberships.find((m) => m.personId === "p-laura" && m.projectId === NVS)!.roleId =
        roleIdOf("developer");
      s.grants.push({
        personId: "p-laura",
        projectId: NVS,
        permission: "project.members.manage",
        grantedById: null,
        at: "2026-10-01T10:00:00Z",
      });
    });
    await refused(() => admin.revokeMemberPermission(NVS, "p-laura", "project.members.manage"), {
      reason: "last_members_manager",
    });
  });
});

describe("failNext", () => {
  it("un guasto simulato lancia e non scrive", async () => {
    as("p-laura");
    reauth("p-laura");
    const before = snapshot();
    failNext("admin.addMember");
    await expect(admin.addMember(ACQ, "p-giulia", roleIdOf("developer"))).rejects.toThrow(
      "Simulated failure",
    );
    expect(snapshot()).toBe(before);
    expect(state.changelog).toEqual([]);
    failNext("admin.listProjectMembers");
    await expect(admin.listProjectMembers(ACQ)).rejects.toThrow("Simulated failure");
  });
});

// --- il rinfresco della UI ---------------------------------------------------------

describe("dopo una scrittura d'accesso la pagina aperta cambia", () => {
  /**
   * Un pezzo di pagina che legge SOLO il contesto del «vedi come»: `memo`
   * senza props, quindi ri-renderizza solo se il valore del contesto cambia.
   */
  const ManagesBadge = memo(function ManagesBadge() {
    const { viewer } = useViewer();
    return (
      <p data-testid="manages">
        {can(viewer, "project.members.manage", ACQ) ? "manages ACQ" : "reads ACQ"}
      </p>
    );
  });

  /** L'elenco dei membri, dalla query. */
  function LauraRole() {
    const members = useMembers(ACQ);
    const laura = members.data?.members.find((m) => m.personId === "p-laura");
    return <p data-testid="role">{laura ? laura.role.name : "…"}</p>;
  }

  function Demote() {
    const demote = useSetMemberRole();
    return (
      <button onClick={() => demote.mutate([ACQ, "p-laura", roleIdOf("developer")])}>demote</button>
    );
  }

  function wrapper({ children }: { children: ReactNode }) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return (
      <QueryClientProvider client={client}>
        <ViewerProvider initialPersonId="p-laura">{children}</ViewerProvider>
      </QueryClientProvider>
    );
  }

  it("Laura si toglie la gestione: il contesto e la query si rinfrescano", async () => {
    reauth("p-laura");
    render(
      <>
        <ManagesBadge />
        <LauraRole />
        <Demote />
      </>,
      { wrapper },
    );
    await waitFor(() => expect(screen.getByTestId("role")).toHaveTextContent("Project Lead"));
    expect(screen.getByTestId("manages")).toHaveTextContent("manages ACQ");
    await act(async () => screen.getByText("demote").click());
    await waitFor(() => expect(screen.getByTestId("role")).toHaveTextContent("Developer"));
    expect(screen.getByTestId("manages")).toHaveTextContent("reads ACQ");
  });

  it("anche una scrittura fatta fuori dalla pagina (un'altra persona) cambia il contesto", async () => {
    render(<ManagesBadge />, { wrapper });
    expect(screen.getByTestId("manages")).toHaveTextContent("manages ACQ");
    act(() => revokeProjectPermission("p-laura", ACQ, "project.members.manage" as never));
    expect(screen.getByTestId("manages")).toHaveTextContent("reads ACQ");
  });
});

// --- la bozza del pannello del membro (Task 10) ------------------------------------

describe("la bozza del membro: previewMember e saveMember con UNA regola", () => {
  const draftOf = (roleKey: string, granted: string[]) => ({ roleId: roleIdOf(roleKey), granted });

  beforeEach(() => {
    as("p-laura");
    reauth("p-laura");
  });

  it("la riga dice i permessi dati a mano, anche quelli che il ruolo dà già", async () => {
    writeAccess((s) => {
      s.grants.push({
        personId: "p-marco",
        projectId: ACQ,
        permission: "docs.view",
        grantedById: "p-roberta",
        at: "2026-10-01T10:00:00Z",
      });
    });
    const marco = (await rowOf(ACQ, "p-marco"))!;
    expect([...marco.granted].sort()).toEqual(["docs.view", "servers.operate"]);
    // docs.view viene anche dal ruolo: non è «in più».
    expect(marco.extra.map((e) => e.permission)).toEqual(["servers.operate"]);
  });

  it("la bozza salvata: nessuna escalation, nessun blocco, le fonti di oggi", async () => {
    const p = await admin.previewMember(ACQ, "p-marco", draftOf("developer", ["servers.operate"]));
    expect(p.missing).toEqual([]);
    expect(p.block).toBeNull();
    expect(p.viewerLoses).toEqual([]);
    const ops = p.permissions.find((x) => x.permission === "servers.operate")!;
    expect(ops.sources).toEqual([expect.objectContaining({ kind: "grant", origin: "given" })]);
    const reply = p.permissions.find((x) => x.permission === "support.reply")!;
    expect(reply.sources.map((s) => s.kind).sort()).toEqual(["department", "role"]);
  });

  it("un permesso dato nella bozza ha la fonte «draft»; uno che Laura non ha è escalation", async () => {
    const give = await admin.previewMember(ACQ, "p-federico", draftOf("developer", ["plans.approve"]));
    expect(give.missing).toEqual([]);
    expect(give.permissions.find((x) => x.permission === "plans.approve")!.sources).toEqual([
      expect.objectContaining({ kind: "grant", origin: "draft" }),
    ]);
    const ops = await admin.previewMember(ACQ, "p-federico", draftOf("developer", ["servers.operate"]));
    expect(ops.missing).toEqual(["servers.operate"]);
    // saveMember legge lo stesso giudizio: rifiuta, niente scritto.
    await refused(
      () => admin.saveMember(ACQ, "p-federico", draftOf("developer", ["servers.operate"])),
      { error: "escalation", missing: ["servers.operate"] },
    );
  });

  it("Laura toglie a Marco servers.operate, che lei non ha: niente gerarchia", async () => {
    const p = await admin.previewMember(ACQ, "p-marco", draftOf("developer", []));
    expect(p.missing).toEqual([]);
    expect(await admin.saveMember(ACQ, "p-marco", draftOf("developer", []))).toEqual({ ok: true });
    expect(can(viewerFor("p-marco"), "servers.operate", ACQ)).toBe(false);
    expect(state.changelog.at(-1)).toMatchObject({
      kind: "member.permission_revoked",
      actorId: "p-laura",
      before: "servers.operate",
    });
  });

  it("ruolo e permessi in un colpo: una scrittura, una voce per ciò che cambia", async () => {
    expect(
      await admin.saveMember(ACQ, "p-federico", draftOf("contributor", ["plans.approve"])),
    ).toEqual({ ok: true });
    expect(state.changelog.map((e) => e.kind)).toEqual([
      "member.role_changed",
      "member.permission_granted",
    ]);
    expect(can(viewerFor("p-federico"), "plans.approve", ACQ)).toBe(true);
    await refused(
      () => admin.saveMember(ACQ, "p-federico", draftOf("contributor", ["plans.approve"])),
      { reason: "unchanged" },
    );
  });

  it("un ruolo vale per ciò che AGGIUNGE al ruolo salvato: roleChoices e saveMember d'accordo", async () => {
    revokeProjectPermission("p-laura", ACQ, "release.merge" as LocalProjectPermission);
    const p = await admin.previewMember(ACQ, "p-marco", draftOf("developer", ["servers.operate"]));
    expect(p.roleChoices.find((c) => c.roleId === roleIdOf("rm-1"))!.missing).toEqual([
      "release.merge",
    ]);
    expect(p.roleChoices.find((c) => c.roleId === roleIdOf("viewer"))!.missing).toEqual([]);
    const rm = await admin.previewMember(ACQ, "p-marco", draftOf("rm-1", ["servers.operate"]));
    expect(rm.missing).toEqual(["release.merge"]);
  });

  it("l'ultimo gestore: la bozza lo dice prima, il salvataggio lo rifiuta; Remove anche", async () => {
    writeAccess((s) => {
      s.people.find((p) => p.personId === "p-roberta")!.instanceRoleId = roleIdOf("user");
      s.memberships.find((m) => m.personId === "p-matteo" && m.projectId === ACQ)!.roleId =
        roleIdOf("developer");
    });
    const p = await admin.previewMember(ACQ, "p-laura", draftOf("developer", []));
    expect(p.block).toBe("last_members_manager");
    expect(p.removeBlock).toBe("last_members_manager");
    expect(p.viewerLoses).toContain("project.members.manage");
    await refused(() => admin.saveMember(ACQ, "p-laura", draftOf("developer", [])), {
      reason: "last_members_manager",
    });
    // Su Marco nessun blocco.
    expect((await admin.previewMember(ACQ, "p-marco", draftOf("viewer", []))).removeBlock).toBeNull();
  });

  it("R-G5, chi non gestisce, chi non è membro", async () => {
    as("p-sara");
    reauth("p-sara");
    await expect(admin.previewMember(AUD, "p-marco", draftOf("developer", []))).rejects.toThrow(
      "not_found",
    );
    // Sara legge (in sola lettura) la bozza salvata di Marco su ACQ.
    const p = await admin.previewMember(ACQ, "p-marco", draftOf("developer", ["servers.operate"]));
    expect(p.missing).toEqual([]);
    await refused(() => admin.saveMember(ACQ, "p-marco", draftOf("developer", [])), {
      error: "forbidden",
    });
    as("p-laura");
    await expect(admin.previewMember(ACQ, "p-giulia", draftOf("developer", []))).rejects.toThrow(
      "not_found",
    );
  });

  it("un disattivato: le fonti di ciò che il ruolo gli darebbe, non una tabella vuota", async () => {
    as("p-roberta");
    const row = (await rowOf("prj-tlm", "p-simone"))!;
    const p = await admin.previewMember("prj-tlm", "p-simone", { roleId: row.role.id, granted: [] });
    expect(p.permissions.length).toBeGreaterThan(0);
  });
});

describe("Add to a project: dalla pagina della persona", () => {
  it("i progetti visibili dove chi guarda gestisce i membri e la persona può entrare", async () => {
    as("p-laura");
    const giulia = await admin.getPerson("p-giulia");
    expect(giulia.addableTo.map((p) => p.code)).toContain("ACQ");
    const marco = await admin.getPerson("p-marco");
    expect(marco.addableTo.map((p) => p.code)).not.toContain("ACQ");
    as("p-sara");
    expect((await admin.getPerson("p-giulia")).addableTo).toEqual([]);
  });
});
