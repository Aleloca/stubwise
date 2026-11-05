import { useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { useDecisionLog, usePeople } from "../../../data/queries";
import { formatDate } from "../../../notifications/time";
import { EditorPicker } from "./EditorPicker";

// «/decision» (shape product-editor.md §3.8): una riga del registro del
// progetto — titolo, e sotto «Laura Costa · Oct 21». Il blocco poi CITA la
// riga: non la copia e non la cambia.

export function DecisionPicker({
  id,
  project,
  style,
  onPick,
  onClose,
  onLeave,
}: {
  id: string;
  project: { id: string; code: string };
  style: CSSProperties;
  onPick: (decisionId: string) => void;
  onClose: () => void;
  onLeave: (related: Element | null) => void;
}) {
  const { t, i18n } = useTranslation();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const log = useDecisionLog(project.id);
  const people = usePeople().data;
  const needle = query.trim().toLowerCase();
  const rows = (log.data ?? []).filter((d) => !needle || d.title.toLowerCase().includes(needle));
  const note = log.isError
    ? t("productDocs.blocks.decision.failed")
    : needle && (log.data?.length ?? 0) > 0
      ? t("productDocs.blocks.decision.noMatch", { q: query.trim() })
      : t("productDocs.blocks.decision.empty", { code: project.code });
  return (
    <EditorPicker
      id={id}
      label={t("productDocs.blocks.decision.find", { code: project.code })}
      query={query}
      onQuery={setQuery}
      active={active}
      onActive={setActive}
      loading={log.isPending}
      note={note}
      groups={[
        {
          label: null,
          rows: rows.map((d) => {
            const name = people?.find((p) => p.id === d.decidedById)?.name ?? null;
            const date = formatDate(d.decidedAt, i18n.language);
            return {
              id: d.id,
              node: (
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{d.title}</span>
                  <span className="num truncate text-xs text-ink-muted">
                    {name ? t("productDocs.blocks.decision.row", { name, date }) : date}
                  </span>
                </span>
              ),
            };
          }),
        },
      ]}
      onPick={onPick}
      onClose={onClose}
      onLeave={onLeave}
      style={style}
    />
  );
}
