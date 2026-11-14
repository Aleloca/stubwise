import { serverPlanSchema, type ServerPlan } from "@stubwise/shared";

// Il piano di correzione di un server (area 8, F4b). Il piano lo propone
// Claude: è contenuto del modello, NON fidato. Diventa una proposta solo se
// sta nello schema CHIUSO di `@stubwise/shared` (`serverPlanSchema`: 1–10
// passi, solo azioni che cambiano dell'insieme `SERVER_ACTIONS`, parametri
// stretti, ognuno col perché) e se ogni container è uno che l'agente
// riporta e non è legato a un altro progetto. Il testo libero non diventa
// mai un comando.
//
// ⚠️ «Libera spazio» (`docker.prune`) si propone su OGNI server, anche
// condiviso (decisione del maintainer, 14 nov 2026): su un server condiviso
// la scheda del piano lo dice PRIMA dell'approvazione, coi progetti che lo
// usano. Il `validateServerPlan` di shared oggi invece la rifiuta su un
// server condiviso (`prune_on_shared_server`): va allineato lì.

export type PlanCheck =
  | { ok: true; plan: ServerPlan }
  | {
      ok: false;
      reason: "schema" | "unknown_container" | "container_of_other_project";
      step: number | null;
    };

/**
 * Se il piano proposto si può scrivere: lo schema chiuso, poi ogni container
 * VISTO sul server (`seenContainers`) e non legato a un altro progetto
 * (`otherProjectContainers`).
 */
export function checkProposedPlan(
  plan: unknown,
  ctx: { seenContainers: readonly string[]; otherProjectContainers: readonly string[] },
): PlanCheck {
  const parsed = serverPlanSchema.safeParse(plan);
  if (!parsed.success) return { ok: false, reason: "schema", step: null };
  for (const [i, step] of parsed.data.steps.entries()) {
    if (step.action === "docker.prune") continue;
    const { container } = step.params as { container: string };
    if (!ctx.seenContainers.includes(container))
      return { ok: false, reason: "unknown_container", step: i };
    if (ctx.otherProjectContainers.includes(container))
      return { ok: false, reason: "container_of_other_project", step: i };
  }
  return { ok: true, plan: parsed.data };
}

/** Il piano libera spazio: tocca tutto il server, non un container. */
export const prunes = (plan: ServerPlan): boolean =>
  plan.steps.some((s) => s.action === "docker.prune");

/** La chiave dell'etichetta di un'azione (`container.restart` → `container_restart`). */
export const actionKey = (action: string): string => action.replace(".", "_");
