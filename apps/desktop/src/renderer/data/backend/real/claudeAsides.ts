import type { AgentSessionEvent, Reader } from "@stubwise/shared";
import i18n from "../../../i18n";
import type { ConversationEvent } from "../../types";

// «Hypothesis» e «Details» sotto la risposta di S2 (area 10, F3 di 72). Il
// server scrive l'evento `aside` con soli id e chiavi, e alla lettura lo
// arricchisce per chi guarda: le righe dei progetti che vede ancora (al più
// 5, dalla ferma più vecchia) e l'ipotesi, null se la sua riga non c'è più.
// Qui diventano le due righe del prototipo, nella lingua di chi guarda:
// - l'ipotesi dalla chiave (`out_of_plan`) e dal codice della task; una
//   chiave che questo renderer non conosce non si dice;
// - «Details» come il prototipo: la soglia dei progetti mostrati
//   (`thresholdDays`, la regola della lista delle task, decisione del
//   maintainer), col codice del primo se è la stessa per tutti, la frase
//   generica se cambia o manca (un server di prima); poi l'ora della lettura
//   (`at`).
// Nessuna riga visibile: niente sotto la risposta.

const K = "claude.answers.stalled";

type Hypothesis = { taskCode: string; key: string };
type Row = { projectCode: string; thresholdDays: number | null };

function readData(data: unknown): { rows: Row[]; hypothesis: Hypothesis | null } | null {
  if (!data || typeof data !== "object") return null;
  const { rows, hypothesis } = data as { rows?: unknown; hypothesis?: unknown };
  if (!Array.isArray(rows)) return null;
  const h = hypothesis as { taskCode?: unknown; key?: unknown } | null | undefined;
  return {
    rows: rows.flatMap((r: unknown): Row[] => {
      const x = r as { projectCode?: unknown; thresholdDays?: unknown } | null;
      if (!x || typeof x.projectCode !== "string") return [];
      return [
        {
          projectCode: x.projectCode,
          thresholdDays: typeof x.thresholdDays === "number" ? x.thresholdDays : null,
        },
      ];
    }),
    hypothesis:
      h && typeof h.taskCode === "string" && typeof h.key === "string"
        ? { taskCode: h.taskCode, key: h.key }
        : null,
  };
}

export function asideEventsOf(raw: readonly Reader<AgentSessionEvent>[]): ConversationEvent[] {
  const out: ConversationEvent[] = [];
  for (const e of raw) {
    if ((e.type as string) !== "aside") continue;
    const data = readData(e.data);
    if (!data || data.rows.length === 0) continue;
    if (data.hypothesis?.key === "out_of_plan") {
      out.push({
        id: `aside:${e.id}:hypothesis`,
        at: e.at,
        type: "aside",
        kind: "hypothesis",
        text: i18n.t(`${K}.hypothesis`, { task: data.hypothesis.taskCode }),
      } as ConversationEvent);
    }
    out.push({
      id: `aside:${e.id}:details`,
      at: e.at,
      type: "aside",
      kind: "details",
      text: `${howCounted(data.rows)} ${i18n.t(`${K}.readAt`, { at: new Date(e.at) })}`,
    } as ConversationEvent);
  }
  return out;
}

/** La soglia del primo progetto se è la stessa per tutti quelli mostrati, o la frase generica ([SC 3]). */
function howCounted(rows: Row[]): string {
  const first = rows[0]!;
  const same =
    first.thresholdDays !== null && rows.every((r) => r.thresholdDays === first.thresholdDays);
  return same
    ? i18n.t(`${K}.details`, {
        code: first.projectCode,
        days: i18n.t(`${K}.days`, { count: first.thresholdDays }),
      })
    : i18n.t(`${K}.detailsMixed`);
}
