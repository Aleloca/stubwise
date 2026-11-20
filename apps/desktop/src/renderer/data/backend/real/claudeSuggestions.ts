import { ApiError } from "@stubwise/api-client";
import { CLAUDE_SUGGESTION_KINDS } from "@stubwise/shared";
import type * as Fake from "../../api";
import type { ClaudeSuggestion, SuggestionPlace } from "../../claude/suggestions";
import { appClient } from "./client";

// «Claude can help you…» nella build app (area 10, F7 di 72): la riga la
// decide il SERVER per chi guarda (`GET /api/claude/suggestions?page&objectId`:
// budget del mese, «Not now», permessi e dati, le regole del «mai se» del
// prototipo), e la pagina mostra ciò che arriva, con le frasi del prototipo.
// «Not now» lo salva il server per persona e per oggetto (`POST …/dismiss`).
// L'oggetto: `<repository>:<numero>` per la PR (l'id della build app è
// `<repository>#<numero>`), l'id del progetto per Automations e Overview,
// nessuno per Usage.

const KINDS = new Set<string>(CLAUDE_SUGGESTION_KINDS);
const PR_ID = /^(.+)#(\d+)$/;

function pageOf(place: SuggestionPlace): { page: string; objectId: string } | null {
  switch (place.kind) {
    case "pr": {
      const m = PR_ID.exec(place.prId);
      return m && Number(m[2]) > 0 ? { page: "pr", objectId: `${m[1]}:${m[2]}` } : null;
    }
    case "automations":
    case "overview":
      return { page: place.kind, objectId: place.projectId };
    case "usage":
      return { page: "usage", objectId: "" };
  }
}

const K = "claude.suggestions";

export const getClaudeSuggestion: typeof Fake.getClaudeSuggestion = async (place) => {
  const where = pageOf(place);
  if (!where) return null;
  const q = new URLSearchParams({
    page: where.page,
    ...(where.objectId ? { objectId: where.objectId } : {}),
  });
  let row: { kind?: unknown; params?: unknown } | null;
  try {
    row = (await appClient().request("GET", `/api/claude/suggestions?${q}`)) as typeof row;
  } catch (error) {
    // Un server senza la rotta: nessuna riga.
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
  if (!row || typeof row.kind !== "string" || !KINDS.has(row.kind)) return null;
  const id = row.kind as ClaudeSuggestion["id"];
  const params = Object.fromEntries(
    Object.entries((row.params ?? {}) as Record<string, unknown>).filter(
      (e): e is [string, string] => typeof e[1] === "string",
    ),
  );
  return {
    id,
    lineKey: `${K}.${id}.line`,
    promptKey: `${K}.${id}.prompt`,
    ...(Object.keys(params).length > 0 ? { params } : {}),
  };
};

export const dismissClaudeSuggestion: typeof Fake.dismissClaudeSuggestion = async (place, kind) => {
  const where = pageOf(place);
  if (!where) return;
  await appClient().request("POST", "/api/claude/suggestions/dismiss", {
    kind,
    objectId: where.objectId,
  });
};
