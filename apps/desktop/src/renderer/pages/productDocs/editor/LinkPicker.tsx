import { useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { useMentionSuggestions, type Suggestion } from "../../claude/conversation/MentionMenu";
import { EditorPicker, type PickerGroup } from "./EditorPicker";

// «/link» (shape product-editor.md §3.9, [PE 12]): gli oggetti del menu `#`
// (Task 6) — le stesse letture, quindi solo ciò che chi scrive vede — in
// gruppi TASKS, REQUESTS, PAGES, PRODUCT PAGES, FILES; righe codice · nome.
// Scelto, entra nel testo IL CODICE: fuori dal fuoco diventa `CodeLink`,
// come un codice scritto a mano. Gli oggetti senza codice (file dei
// repository, progetti) qui non ci sono.

type LinkGroup = "tasks" | "requests" | "pages" | "productPages" | "files";
const ORDER: LinkGroup[] = ["tasks", "requests", "pages", "productPages", "files"];

const groupOf = (s: Suggestion): LinkGroup | null => {
  if (!s.code) return null;
  switch (s.group) {
    case "task":
      return "tasks";
    case "request":
      return "requests";
    case "doc":
      return s.space === "product" ? "productPages" : "pages";
    case "drive":
      return "files";
    default:
      return null;
  }
};

export function LinkPicker({
  id,
  style,
  onPick,
  onClose,
  onLeave,
}: {
  id: string;
  style: CSSProperties;
  onPick: (code: string) => void;
  onClose: () => void;
  onLeave: (related: Element | null) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const { groups, loading } = useMentionSuggestions("objects", query.trim(), true);
  const all = groups.flatMap((g) => g.items);
  const byCode = new Map(all.filter((s) => s.code).map((s) => [s.id, s.code!]));
  const picker: PickerGroup[] = ORDER.map((g) => ({
    label: t(`productDocs.blocks.link.${g}`),
    rows: all
      .filter((s) => groupOf(s) === g)
      .map((s) => ({
        id: s.id,
        node: (
          <>
            <span className="num shrink-0 text-xs font-semibold tracking-[0.02em] text-ink">{s.code}</span>
            <span className="min-w-0 truncate">{s.label}</span>
          </>
        ),
      })),
  }));
  return (
    <EditorPicker
      id={id}
      label={t("productDocs.blocks.link.find")}
      query={query}
      onQuery={setQuery}
      active={active}
      onActive={setActive}
      loading={loading}
      note={t("productDocs.blocks.link.noMatch", { q: query.trim() })}
      groups={picker}
      onPick={(rowId) => {
        const code = byCode.get(rowId);
        if (code) onPick(code);
      }}
      onClose={onClose}
      onLeave={onLeave}
      style={style}
    />
  );
}
