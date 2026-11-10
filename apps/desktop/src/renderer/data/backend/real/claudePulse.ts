import { appClient } from "./client";

// Claude nel polso della build app (integrazione area 3, 3e.2). «Claude al
// lavoro»: una sessione di lavoro su una task (`ai_job`) dal vivo, al lavoro o
// in coda, nel progetto (`/api/agent-sessions`, le sole che chi guarda vede).
// Le sessioni di sfondo (Docs, brief, report, posta) non contano: girano ogni
// notte su tutti i progetti, e il segnale non direbbe più niente. «Claude
// aspetta te»: le voci di Claude in «Da decidere» (`/api/me/claude-decisions`:
// i piani a chi li approva, le domande a chi risponde). Fail-open: senza
// queste letture il polso resta, senza Claude.

/** I progetti con Claude al lavoro su una task. */
export async function claudeWorkingProjectIds(): Promise<Set<string>> {
  try {
    const { live } = await appClient().agentSessions.list({});
    return new Set(
      live.flatMap((s) =>
        s.kind === "ai_job" && (s.state === "working" || s.state === "queued") && s.projectId ? [s.projectId] : [],
      ),
    );
  } catch {
    return new Set();
  }
}

/** Quante voci di Claude aspettano chi guarda, per progetto. */
export async function claudeWaitingCounts(): Promise<Map<string, number>> {
  try {
    const counts = new Map<string, number>();
    // Letta qui e non da `listClaudeDecisions`: `projects.ts` la importa, e
    // `claudeActions` → `claude` → `projects` farebbe un giro di import.
    for (const d of await appClient().me.claudeDecisions()) {
      if (d.kind !== "__unknown__" && d.projectId) counts.set(d.projectId, (counts.get(d.projectId) ?? 0) + 1);
    }
    return counts;
  } catch {
    return new Map();
  }
}
