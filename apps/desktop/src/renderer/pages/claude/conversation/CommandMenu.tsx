import { useTranslation } from "react-i18next";
import { useCommands } from "../../../data/queries";
import type { SuggestionGroup } from "./MentionMenu";

/**
 * I comandi di «/» per il progetto di contesto: «Stubwise» e un gruppo per
 * plugin abilitato (le skill spente nel progetto non arrivano dal livello
 * dati). Filtra per nome e descrizione mentre si scrive.
 */
export function useCommandSuggestions(
  contextProjectId: string | null,
  q: string,
  enabled: boolean,
): { groups: SuggestionGroup[]; loading: boolean } {
  const { t } = useTranslation();
  const query = useCommands(contextProjectId);
  const needle = q.trim().toLowerCase();
  const commands = (query.data ?? []).filter(
    (c) =>
      !needle ||
      c.label.toLowerCase().includes(needle) ||
      c.description.toLowerCase().includes(needle),
  );
  const groups = new Map<string, SuggestionGroup>();
  for (const c of commands) {
    const source = c.source === "stubwise" ? "Stubwise" : c.source.plugin;
    let group = groups.get(source);
    if (!group) {
      group = { label: source, items: [] };
      groups.set(source, group);
    }
    group.items.push({
      id: c.id,
      group: source,
      code: c.label,
      label: c.description,
      detail:
        c.source === "stubwise"
          ? null
          : t("claude.conversation.menus.skillOf", { plugin: c.source.plugin }),
      insert: c.label,
      stacked: true,
    });
  }
  return { groups: [...groups.values()], loading: enabled && query.isPending };
}
