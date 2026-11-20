import type { AgentSessionEvent, Reader } from "@stubwise/shared";
import { CAPABILITIES } from "../../../domain/claude/intents/general";
import type { CapabilityId, ConversationEvent } from "../../types";

// S0 nella build app (area 10, F7 di 72): «cosa sai fare» è l'evento
// `capabilities` che il PONTE scrive con gli id che chi chiede può davvero
// usare (le firme vere, mai il ruolo; F7-1 = a: niente `product*` finché
// l'area 11 non c'è). Il modello sceglie solo QUANDO. Qui diventa la lista
// del prototipo (`CapabilitiesList`), con le frasi del renderer nella lingua
// di chi guarda. Un id che questo renderer non conosce (letto `UNKNOWN`, o di
// un server più nuovo) si salta; senza id noti, niente lista.

const KNOWN = new Set<string>(CAPABILITIES);

export function capabilitiesEventsOf(
  raw: readonly Reader<AgentSessionEvent>[],
): ConversationEvent[] {
  return raw.flatMap((e): ConversationEvent[] => {
    if ((e.type as string) !== "capabilities") return [];
    const items = (e.data as { items?: unknown } | null)?.items;
    if (!Array.isArray(items)) return [];
    const known = items.filter((id): id is CapabilityId => typeof id === "string" && KNOWN.has(id));
    return known.length > 0
      ? [{ id: `capabilities:${e.id}`, at: e.at, type: "capabilities", items: known }]
      : [];
  });
}
