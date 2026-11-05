import { useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { useDriveFiles } from "../../../data/queries";
import type { DriveFileRow } from "../../../data/types";
import { TypeGlyph } from "../../drive/glyphs";
import { EditorPicker } from "./EditorPicker";

// «/drive» (shape product-editor.md §3.7, [PE 10]): i file del Drive del
// progetto, con le stesse letture del Drive — solo ciò che chi scrive vede,
// mai un nascosto. Righe: glifo · nome · codice · cartella.

export function DrivePicker({
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
  onPick: (file: Pick<DriveFileRow, "id" | "code">) => void;
  onClose: () => void;
  onLeave: (related: Element | null) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const files = useDriveFiles({ projectId: project.id, sort: "name" });
  const needle = query.trim().toLowerCase();
  const rows = (files.data ?? []).filter(
    (f) => !needle || f.name.toLowerCase().includes(needle) || f.code.toLowerCase().includes(needle),
  );
  const note = files.isError
    ? t("productDocs.blocks.drive.listFailed")
    : needle && (files.data?.length ?? 0) > 0
      ? t("productDocs.blocks.drive.noMatch", { q: query.trim() })
      : t("productDocs.blocks.drive.empty", { code: project.code });
  return (
    <EditorPicker
      id={id}
      label={t("productDocs.blocks.drive.find", { code: project.code })}
      query={query}
      onQuery={setQuery}
      active={active}
      onActive={setActive}
      loading={files.isPending}
      note={note}
      groups={[
        {
          label: null,
          rows: rows.map((f) => ({
            id: f.id,
            node: (
              <>
                <span className="text-ink-muted">
                  <TypeGlyph type={f.type} />
                </span>
                <span className="min-w-0 truncate">{f.name}</span>
                <span className="num shrink-0 text-xs font-semibold text-ink-muted">{f.code}</span>
                {f.folder && <span className="ml-auto min-w-0 shrink truncate text-xs text-ink-faint">{f.folder.name}</span>}
              </>
            ),
          })),
        },
      ]}
      onPick={(rowId) => {
        const file = rows.find((f) => f.id === rowId);
        if (file) onPick(file);
      }}
      onClose={onClose}
      onLeave={onLeave}
      style={style}
    />
  );
}
