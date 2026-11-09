import { afterEach, describe, expect, it } from "vitest";
import i18n from "../i18n";
import { sinceText } from "../components/InstanceBlock";
import { relativeTime } from "../notifications/time";
import { modifiedLabel } from "../pages/drive/format";
import { resetApi } from "./api";
import { accessState } from "./access/index";
import { advanceNow, now, state } from "./store";
import { grantInstancePermission } from "./viewer";

// Un solo «adesso» (orologio unico): tutto ciò che dice un'età o un «quando»
// misura contro `now()` del livello dati, lo stesso orologio con cui il
// livello dati scrive i tempi. Prima c'erano due «adesso» (`NOW` delle
// notifiche alle 23:00, `now()` a mezzogiorno) e una sessione appena avviata
// diceva «11h ago». Eccezione dichiarata (ruling T13 I3), fuori da qui:
// «Updated hh:mm:ss» e «Couldn't update at…» dello Stato dell'istanza usano
// l'orologio vero della finestra.

const t = i18n.getFixedT("en");

afterEach(() => resetApi());

describe("orologio unico: i formattatori misurano su now()", () => {
  it("un evento scritto adesso dice «Just now», non «11h ago»", () => {
    expect(relativeTime(now(), t, "en")).toBe("Just now");
  });

  it("«da ieri alle …» quando l'orologio passa la mezzanotte", () => {
    const at = now();
    advanceNow(13 * 3_600_000);
    expect(sinceText(t, at, "en")).toBe(
      t("instanceEffects.since.yesterday", { time: at.slice(11, 16) }),
    );
  });

  it("una concessione scritta dopo «Fai passare il tempo» porta l'ora di now()", () => {
    advanceNow(45 * 60_000);
    grantInstancePermission("p-sara", "instance.status.view");
    const grant = accessState().grants.find(
      (g) => g.personId === "p-sara" && g.permission === "instance.status.view",
    );
    expect(grant?.at).toBe(now());
  });

  it("l'età si sposta con l'orologio del livello dati («Fai passare il tempo»)", () => {
    const at = now();
    advanceNow(30 * 60_000);
    expect(relativeTime(at, t, "en")).toBe("30m ago");
    expect(modifiedLabel(at, t, "en")).toBe(t("drive.time.minutes", { count: 30 }));
  });
});

// Le superfici non si costruiscono un loro «adesso»: niente costante `NOW`
// (né `…_NOW`), niente orologio scritto a mano sul giorno fisso. La
// mezzanotte di `TODAY` resta lecita: è un confine di giorno, non un adesso.
// La guardia prende solo queste due forme: un adesso scritto come
// `${daysFromToday(0)}T15:00:00Z` o come stringa letterale le sfugge. Per un
// prototipo basta (Minor 5 della revisione, in `ossatura-follow-ups.md`).
const SURFACES = import.meta.glob(
  [
    "../pages/**/*.{ts,tsx}",
    "../tasks-ui/**/*.{ts,tsx}",
    "../layout/**/*.{ts,tsx}",
    "../components/**/*.{ts,tsx}",
    "../palette/**/*.{ts,tsx}",
    "../notifications/**/*.{ts,tsx}",
    "!**/*.test.{ts,tsx}",
  ],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

const SECOND_CLOCK = [/\b[A-Z_]*NOW\b/, /\$\{TODAY\}T(?!00:00:00Z)/];

describe("orologio unico: nessun secondo riferimento", () => {
  it("trova i sorgenti delle superfici", () => {
    expect(Object.keys(SURFACES).length).toBeGreaterThan(10);
  });

  it("nessuna superficie dichiara un suo «adesso»", () => {
    const offenders = Object.entries(SURFACES)
      .filter(([, source]) => SECOND_CLOCK.some((re) => re.test(source)))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});

// Con un solo adesso, i tempi del seme che dicono un'età stanno nel passato:
// un tempo dopo `now()` direbbe «Just now» invece della sua età.
describe("orologio unico: il seme non scrive nel futuro", () => {
  it("notifiche, attività, task e registro della sicurezza sono <= now()", () => {
    const at = now();
    const future = [
      ...state.notifications.map((n) => [n.id, n.createdAt] as const),
      ...state.activity.map((a) => [a.id, a.at] as const),
      ...state.tasks.map((x) => [x.id, x.lastActivityAt] as const),
      ...state.securityEvents.map((e) => [e.id, e.at] as const),
    ].filter(([, iso]) => iso > at);
    expect(future).toEqual([]);
  });
});
