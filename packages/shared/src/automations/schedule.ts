// Quando cade un inizio a orario (area 7, F2, R6): una RRULE semplice
// (`FREQ=DAILY|WEEKLY|MONTHLY`, `BYDAY=MO,TH`, `BYMONTHDAY=n`, `BYHOUR=h`)
// letta nel fuso dato. Il worker usa Europe/Rome, il prototipo UTC (il suo
// orologio). Un giorno del mese che il mese non ha cade all'ultimo (Q13 = a).
// «Una volta al giorno» lo garantisce chi scatta, con `localDate` come chiave.

const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  weekday: (typeof DAYS)[number];
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function partsIn(at: string, timeZone: string): LocalParts {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      weekday: "short",
      hourCycle: "h23",
    });
    formatters.set(timeZone, f);
  }
  const get = (type: string) => f!.formatToParts(new Date(at)).find((p) => p.type === type)?.value ?? "";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    weekday: get("weekday").slice(0, 2).toUpperCase() as LocalParts["weekday"],
  };
}

const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** Il giorno (`YYYY-MM-DD`) di `at` nel fuso. */
export function localDate(at: string, timeZone: string): string {
  const p = partsIn(at, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** La regola cade nel giorno di `at` (nel fuso), e l'ora è raggiunta? */
export function scheduleDue(rule: string, at: string, timeZone: string): boolean {
  const parts = Object.fromEntries(rule.split(";").map((p) => p.split("=") as [string, string | undefined]));
  const hour = Number(parts.BYHOUR ?? 0);
  if (!Number.isInteger(hour)) return false;
  const local = partsIn(at, timeZone);
  if (local.hour < hour) return false;
  switch (parts.FREQ) {
    case "DAILY":
      return true;
    case "WEEKLY":
      return (parts.BYDAY ?? "").split(",").includes(local.weekday);
    case "MONTHLY": {
      const wanted = Number(parts.BYMONTHDAY ?? 1);
      if (!Number.isInteger(wanted) || wanted < 1) return false;
      return local.day === Math.min(wanted, daysInMonth(local.year, local.month));
    }
    default:
      return false;
  }
}
