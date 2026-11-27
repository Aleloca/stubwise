import { ApiError } from "@stubwise/api-client";
import type { InboxItem } from "@stubwise/shared";
import type * as Fake from "../../api";
import type { PulseProposalView, PulseStartResult, PulseUrgency } from "../../pulse/types";
import { appClient } from "./client";
import { projectCodesById } from "./projects";

// Le proposte del polso nella build app (ritiro del web vecchio, inventario
// 1.4; shape `pulse-proposals.md`, PQ-1b: si decide solo in «Da decidere»).
// Sono le card `project.pulse` aperte dell'inbox. Chi può deciderle lo dice
// il SERVER (l'azione `answer` fra le `actions` della card), non il client.
// Start è `POST /api/inbox/:id/actions/answer` con l'indice dell'opzione: il
// server converte la voce in task e lancia il run con l'approvazione del
// piano. Not now è la `handled`, igiene personale.

/** Le rotte che servono, iniettabili nei test. */
export interface PulseApi {
  /** Una pagina delle card `project.pulse` aperte (filtrate dal server); `null` = la prima. */
  page(cursor: string | null): Promise<{ items: unknown[]; nextCursor: string | null }>;
  projectCodes(): Promise<Map<string, string>>;
  /** `runStatus` viene da un enum aperto (`readerSchema`): un valore ignoto non è il gate. */
  answer(id: string, optionIndex: number): Promise<{ ticketNumber?: number; runStatus?: string }>;
  handled(id: string): Promise<unknown>;
}

type PulseItem = Pick<InboxItem, "id" | "kind" | "projectId" | "createdAt" | "actions" | "question" | "pulse">;

const URGENCIES: readonly string[] = ["low", "medium", "high", "urgent"];

const decidable = (i: PulseItem): boolean =>
  i.kind === "project.pulse" && !!i.pulse && !!i.projectId && (i.actions as readonly string[]).includes("answer");

/** Oltre questo numero di pagine non si continua: un tetto contro un cursore che non finisce. */
const MAX_PAGES = 20;

export function createRealPulse(api: PulseApi) {
  // Revisione, I3: Decide è l'unico posto dove si decide, quindi si leggono
  // TUTTE le card del pulse, filtrate dal server (`kind`), pagina dopo pagina.
  const allPages = async (): Promise<unknown[]> => {
    const out: unknown[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < MAX_PAGES; i++) {
      const page = await api.page(cursor);
      out.push(...page.items);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return out;
  };

  // Il codice del progetto di ogni card vista, per dire «TRM-7» dopo Start.
  const projectOfCard = new Map<string, string>();

  const listPulseProposals = async (): Promise<PulseProposalView[]> => {
    const [items, codes] = await Promise.all([allPages(), api.projectCodes()]);
    return (items as PulseItem[]).filter(decidable).flatMap((i) => {
      const code = codes.get(i.projectId!);
      if (!code) return [];
      projectOfCard.set(i.id, code);
      const recommended = i.question?.recommendedIndex;
      return [
        {
          id: i.id,
          projectId: i.projectId!,
          projectCode: code,
          projectName: i.pulse!.projectName,
          idleDays: i.pulse!.idleDays,
          createdAt: i.createdAt,
          options: i.pulse!.proposals.map((p, index) => ({
            title: p.title,
            urgency: p.urgency && URGENCIES.includes(p.urgency) ? (p.urgency as PulseUrgency) : null,
            effort: p.effort ?? null,
            suggested: index === recommended,
          })),
        },
      ];
    });
  };

  const taskCode = (id: string, n: number | undefined) => {
    const code = projectOfCard.get(id);
    return code && n ? `${code}-${n}` : "";
  };

  const startPulseProposal = async (id: string, optionIndex: number): Promise<PulseStartResult> => {
    try {
      const r = await api.answer(id, optionIndex);
      return { ok: true, taskCode: taskCode(id, r.ticketNumber), awaitingApproval: r.runStatus === "awaiting_plan_approval" };
    } catch (error) {
      if (!(error instanceof ApiError)) return { ok: false, reason: "failed" };
      switch (error.code) {
        case "proposal_stale":
        case "already_handled":
        case "invalid_answer":
          return { ok: false, reason: "stale" };
        case "run_not_started": {
          const n = (error.details as { ticketNumber?: unknown } | undefined)?.ticketNumber;
          return { ok: false, reason: "run_not_started", taskCode: taskCode(id, typeof n === "number" ? n : undefined) };
        }
        case "forbidden":
          return { ok: false, reason: "forbidden" };
        default:
          return { ok: false, reason: "failed" };
      }
    }
  };

  const dismissPulseProposal = async (id: string): Promise<void> => {
    await api.handled(id);
  };

  return { listPulseProposals, startPulseProposal, dismissPulseProposal };
}

const PAGE = 100;

export const pulse: typeof Fake.pulse = createRealPulse({
  page: async (cursor) => {
    const r = await appClient().inbox.list({ status: "open", kind: "project.pulse" }, cursor ?? undefined, PAGE);
    return { items: r.items, nextCursor: r.nextCursor ?? null };
  },
  projectCodes: projectCodesById,
  answer: async (id, optionIndex) => {
    const r = await appClient().inbox.act(id, "answer", { optionIndex });
    return { ticketNumber: r.ticketNumber, runStatus: r.runStatus };
  },
  handled: (id) => appClient().inbox.handled(id),
});
