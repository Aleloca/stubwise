import { describe, expect, it } from "vitest";
import { search, setLatency } from "./api";
import { isAppRoute } from "./routes";
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
      isAppRoute("#/mail/th-aud-billing-vat?mailbox=giulia.ferri@example.com&importance=high&project=AUD&q=vat"),
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
