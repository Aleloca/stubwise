import { describe, expect, it } from "vitest";
import { automations, resetApi, search, servers, setLatency } from "./api";
import { automationHref, isAppRoute, runHref } from "./routes";
import { NOTIFICATIONS } from "./seed/notifications";
import { PROJECTS } from "./seed/projects";

const codes = new Set(PROJECTS.map((p) => p.code));
const codeOf = (r: string) => /^#\/p\/([A-Z]+)/.exec(r)?.[1];

describe("route grammar", () => {
  it("accetta e rifiuta le route giuste", () => {
    expect(isAppRoute("#/home")).toBe(true);
    expect(isAppRoute("#/p/CBV")).toBe(true);
    expect(isAppRoute("#/p/CBV/tasks")).toBe(true);
    expect(isAppRoute("#/inbox")).toBe(false);
    expect(isAppRoute("#/p/CBV/tasks/CBV-1")).toBe(false);
    expect(isAppRoute("#/people/x")).toBe(false);
  });

  it("area 9a: le sei sezioni delle Preferenze, e All projects coi soli fissati", () => {
    for (const s of ["notifications", "account", "security", "tokens", "claude-code", "look"]) {
      expect(isAppRoute(`#/preferences/${s}`), s).toBe(true);
    }
    expect(isAppRoute("#/preferences/billing")).toBe(false);
    expect(isAppRoute("#/projects?view=pinned")).toBe(true);
    expect(isAppRoute("#/projects?view=starred")).toBe(false);
  });

  it("area 9a: le voci dell'Amministrazione, una persona, un invito, i filtri di People", () => {
    for (const s of ["people", "departments", "roles", "changelog", "who-can"]) {
      expect(isAppRoute(`#/admin/${s}`), s).toBe(true);
    }
    expect(isAppRoute("#/admin/billing")).toBe(false);
    expect(isAppRoute("#/admin/people/p-marco")).toBe(true);
    expect(isAppRoute("#/admin/people/invites/inv-1")).toBe(true);
    expect(isAppRoute("#/admin/people?depts=dep-development,dep-sales&statuses=active")).toBe(true);
    expect(isAppRoute("#/admin/people?statuses=gone")).toBe(false);
    expect(isAppRoute("#/admin/people?invite=1")).toBe(true);
    // Task 9: la pagina di un ruolo e il pannello di un reparto (solo su Departments).
    expect(isAppRoute("#/admin/roles/role-developer")).toBe(true);
    // 9b, Task 10: la pagina di un plugin.
    expect(isAppRoute("#/admin/plugins/plg-superpowers")).toBe(true);
    expect(isAppRoute("#/admin/departments?department=dep-sales")).toBe(true);
    expect(isAppRoute("#/admin/people?department=dep-sales")).toBe(false);
    expect(isAppRoute("#/home?find=marco")).toBe(false);
  });

  it("area 2: filtri, planning e ricerca valida per route", () => {
    expect(isAppRoute("#/filters")).toBe(true);
    expect(isAppRoute("#/filters/flt-open")).toBe(true);
    expect(isAppRoute("#/filters/flt-open/x")).toBe(false);
    expect(isAppRoute("#/planning")).toBe(true);
    // ?task= vale su ogni route
    for (const base of ["#/home", "#/filters/flt-open", "#/planning", "#/p/AUD/tasks", "#/chat"]) {
      expect(isAppRoute(`${base}?task=AUD-12`), base).toBe(true);
    }
    expect(isAppRoute("#/p/AUD/tasks?task=aud-12")).toBe(false);
    expect(isAppRoute("#/p/AUD/tasks?task=AUD")).toBe(false);
    // ?request= solo sulle richieste del progetto
    expect(isAppRoute("#/p/AUD/requests?request=req-1")).toBe(true);
    expect(isAppRoute("#/p/AUD/tasks?request=req-1")).toBe(false);
    expect(isAppRoute("#/home?request=req-1")).toBe(false);
    // ?refine=1 solo lì, e solo «1»
    expect(isAppRoute("#/p/AUD/requests?request=req-1&refine=1")).toBe(true);
    expect(isAppRoute("#/p/AUD/requests?request=req-1&refine=yes")).toBe(false);
    expect(isAppRoute("#/p/AUD/tasks?refine=1")).toBe(false);
    // ?view=week solo sulla Home
    expect(isAppRoute("#/home?view=week")).toBe(true);
    expect(isAppRoute("#/home?view=month")).toBe(false);
    expect(isAppRoute("#/chat?view=week")).toBe(false);
    // vista, raggruppamento e criteri: sulle task di un progetto e sui filtri
    expect(isAppRoute("#/p/AUD/tasks?view=board&group=assignee")).toBe(true);
    expect(isAppRoute("#/filters/flt-open?view=timeline&group=week")).toBe(true);
    expect(isAppRoute("#/p/AUD/tasks?view=week")).toBe(false);
    expect(isAppRoute("#/p/AUD/tasks?group=colour")).toBe(false);
    expect(isAppRoute("#/home?group=status")).toBe(false);
    const filters = encodeURIComponent(JSON.stringify({ families: ["todo"] }));
    expect(isAppRoute(`#/p/AUD/tasks?filters=${filters}`)).toBe(true);
    expect(isAppRoute("#/p/AUD/tasks?filters=nope")).toBe(false);
    expect(isAppRoute(`#/p/AUD/overview?filters=${filters}`)).toBe(false);
    // parametri della palette
    expect(isAppRoute("#/home?newTask=1&project=AUD")).toBe(true);
    expect(isAppRoute("#/p/AUD/tasks?newRequest=AUD")).toBe(true);
    expect(isAppRoute("#/home?pippo=1")).toBe(false);
    expect(isAppRoute("#/home?")).toBe(false);
  });

  it("area 6: la Posta, la conversazione aperta e i suoi filtri", () => {
    expect(isAppRoute("#/mail")).toBe(true);
    expect(isAppRoute("#/mail/th-aud-billing-vat")).toBe(true);
    expect(isAppRoute("#/mail/th/x")).toBe(false);
    expect(
      isAppRoute(
        "#/mail/th-aud-billing-vat?mailbox=giulia.ferri@example.com&importance=high&project=AUD&q=vat",
      ),
    ).toBe(true);
    expect(isAppRoute("#/mail?project=none")).toBe(true);
    expect(isAppRoute("#/mail?importance=urgent")).toBe(false);
    expect(isAppRoute("#/mail?mailbox=not-an-address")).toBe(false);
    // `none` e i filtri della Posta solo nella Posta.
    expect(isAppRoute("#/home?project=none")).toBe(false);
    expect(isAppRoute("#/home?importance=high")).toBe(false);
    expect(isAppRoute("#/chat?mailbox=giulia.ferri@example.com")).toBe(false);
  });

  it("area 6: la nuova email nel pannello di lettura (`compose=new`, solo su #/mail)", () => {
    expect(isAppRoute("#/mail?compose=new")).toBe(true);
    expect(isAppRoute("#/mail?compose=new&importance=high")).toBe(true);
    expect(isAppRoute("#/mail?compose=reply")).toBe(false);
    expect(isAppRoute("#/mail/th-aud-billing-vat?compose=new")).toBe(false);
    expect(isAppRoute("#/chat?compose=new")).toBe(false);
  });

  it("area 7: Automations — elenco, automazione, esecuzione, sorgenti e i loro parametri", () => {
    expect(isAppRoute("#/automations")).toBe(true);
    expect(isAppRoute("#/automations?view=runs")).toBe(true);
    expect(isAppRoute("#/automations?view=attention")).toBe(true);
    expect(isAppRoute("#/automations?view=week")).toBe(false);
    expect(isAppRoute("#/automations?project=AUD&status=active&owner=p-matteo")).toBe(true);
    expect(isAppRoute("#/automations?general=1&mine=1&automation=AUT-1")).toBe(true);
    expect(isAppRoute("#/automations?status=finished")).toBe(true);
    expect(isAppRoute("#/automations?status=gone")).toBe(false);
    expect(isAppRoute("#/automations/AUD-A1")).toBe(true);
    expect(isAppRoute("#/automations/AUT-1")).toBe(true);
    expect(isAppRoute("#/automations/aud-a1")).toBe(false);
    expect(isAppRoute("#/automations/AUD-A1/runs/2")).toBe(true);
    expect(isAppRoute("#/automations/AUD-A1/runs/x")).toBe(false);
    expect(isAppRoute(runHref("AUD-A1", 2, "3/then/0/mancano informazioni/0"))).toBe(true);
    expect(isAppRoute("#/automations/AUD-A1?entry=0")).toBe(false);
    expect(isAppRoute("#/automations/sources")).toBe(true);
    expect(isAppRoute("#/automations/sources?source=src-audin")).toBe(true);
    expect(isAppRoute("#/automations?source=src-audin")).toBe(false);
    expect(isAppRoute("#/drive?source=google")).toBe(true);
    expect(isAppRoute("#/automations/AUD-A1/edit")).toBe(true);
    expect(isAppRoute("#/automations/AUD-A1/test")).toBe(true);
    expect(isAppRoute("#/automations/AUD-A1/other")).toBe(false);
    expect(isAppRoute("#/automations/AUD-A1?problems=1")).toBe(true);
    expect(isAppRoute("#/automations?problems=1")).toBe(false);
    expect(isAppRoute("#/home?status=active")).toBe(false);
    expect(automationHref("AUD-A1")).toBe("#/automations/AUD-A1");
  });

  it("area 7: link di notifiche e ricerca verso le route vere delle Automations", async () => {
    setLatency(0);
    resetApi();
    const results = await automations.searchAutomations("AUD-A1");
    expect(results.map((r) => r.route)).toEqual(
      expect.arrayContaining(["#/automations/AUD-A1", "#/automations/AUD-A1/runs/1"]),
    );
    for (const r of results) expect(isAppRoute(r.route), r.route).toBe(true);
  });

  it("area 8b: il dettaglio di un server", () => {
    expect(isAppRoute("#/p/STW/servers")).toBe(true);
    expect(isAppRoute("#/p/STW/servers/SRV-2")).toBe(true);
    expect(isAppRoute(servers.serverHref("AUD", "SRV-12"))).toBe(true);
    expect(isAppRoute("#/p/STW/servers/srv-2")).toBe(false);
    expect(isAppRoute("#/p/STW/servers/SRV-")).toBe(false);
    expect(isAppRoute("#/p/STW/releases/SRV-2")).toBe(false);
  });

  it("area 9b: il dettaglio dall'Amministrazione, e 30d/90d in entrambi", () => {
    expect(isAppRoute("#/admin/servers")).toBe(true);
    expect(isAppRoute("#/admin/servers/SRV-2")).toBe(true);
    expect(isAppRoute("#/admin/servers/srv-2")).toBe(false);
    expect(isAppRoute("#/admin/servers/SRV-2?range=90d&section=checks")).toBe(true);
    expect(isAppRoute("#/p/STW/servers/SRV-2?range=30d")).toBe(true);
    expect(isAppRoute("#/p/STW/servers/SRV-2?range=month")).toBe(false);
    expect(isAppRoute("#/admin/repositories")).toBe(true);
  });

  it("area 9b: i filtri di WORK dello Stato dell'istanza (stato, progetto, tipo), solo lì", () => {
    expect(isAppRoute("#/admin/status")).toBe(true);
    expect(isAppRoute("#/admin/status?status=failed&project=ACQ&kind=task_run")).toBe(true);
    expect(isAppRoute("#/admin/status?status=waiting")).toBe(true);
    expect(isAppRoute("#/admin/status?kind=server_fix")).toBe(true);
    expect(isAppRoute("#/admin/status?status=paused")).toBe(false);
    expect(isAppRoute("#/admin/status?kind=nightly")).toBe(false);
    expect(isAppRoute("#/admin/status?project=acq")).toBe(false);
    // Le chiavi restano dove valgono: niente `kind` dei lavori su People.
    expect(isAppRoute("#/admin/people?kind=task_run")).toBe(false);
  });

  it("area 8b: gli avvisi dei server (tranne la diagnosi, che apre la task) portano al dettaglio", () => {
    const serverAlerts = NOTIFICATIONS.filter(
      (n) =>
        (n.kind.startsWith("server.") || n.kind.startsWith("monitor.")) &&
        n.kind !== "server.diagnosis_ready",
    );
    // server.trouble, server.down, server.recovered, monitor.alert, monitor.recovered.
    expect(serverAlerts).toHaveLength(5);
    for (const n of serverAlerts) {
      expect(n.link).toBe(`#/p/${n.projectId!.slice(4).toUpperCase()}/servers/${n.objectCode}`);
    }
  });

  it("i link delle notifiche sono nella grammatica", () => {
    for (const n of NOTIFICATIONS) {
      expect(isAppRoute(n.link), n.link).toBe(true);
      const c = codeOf(n.link);
      if (c) expect(codes.has(c)).toBe(true);
    }
  });

  it("le route della ricerca sono nella grammatica", async () => {
    setLatency(0);
    for (const q of ["cbv", "giulia", "audin"]) {
      const results = await search(q);
      expect(results.length).toBeGreaterThan(0);
      for (const r of results) {
        expect(isAppRoute(r.route), r.route).toBe(true);
        const c = codeOf(r.route);
        if (c) expect(codes.has(c)).toBe(true);
      }
    }
  });
});
