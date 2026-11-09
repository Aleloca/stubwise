import { useTranslation } from "react-i18next";
import { useDriveFile } from "../../../data/queries";
import type { ProductBlock } from "../../../data/types";
import { formatSize } from "../../drive/format";
import { TypeGlyph, UnavailableGlyph } from "../../drive/glyphs";
import { useOpenDriveFile } from "../../drive/openFile";
import { secondaryButton } from "../../tasks/controls";
import { selectOnMouseDown } from "./ImageBlock";

// Un file del Drive in una pagina (shape product-editor.md §3.7, [PE 10]):
// riga di 48 px, bordo 1 px `rule`, raggio 8 — glifo 20 · nome 14 600 ·
// codice tnum · tipo e dimensione 12 faint · «Open» a destra
// (`useOpenDriveFile`: rilegge il file e apre l'anteprima del Drive). Il
// file si legge come lo legge il Drive per chi guarda: nascosto, tolto o di
// un progetto che non vede → «This file is no longer available» e il solo
// codice, che la pagina già porta: nessun nome, nessun «Open» (R-G5).

type Drive = Extract<ProductBlock, { type: "drive" }>;

const rowClass = "flex h-12 min-w-0 items-center gap-3 rounded-lg border border-rule px-3";

export function DriveBlock({ block, onSelect }: { block: Drive; onSelect?: () => void }) {
  const { t, i18n } = useTranslation();
  const file = useDriveFile(block.fileId);
  const open = useOpenDriveFile();
  const code = <span className="num shrink-0 text-sm font-semibold text-ink-muted">{block.code}</span>;

  if (file.isPending) {
    return (
      <div aria-busy="true" onMouseDown={selectOnMouseDown(onSelect)} className={`${rowClass} skeleton-breathe`}>
        <span className="sr-only" role="status">
          {t("productDocs.blocks.drive.loading")}
        </span>
        <span aria-hidden="true" className="size-5 shrink-0 rounded-sm bg-ink/8" />
        <span aria-hidden="true" className="h-2.5 w-40 rounded-sm bg-ink/8" />
      </div>
    );
  }
  const row = file.data;
  if (!row || row.hidden || file.isError) {
    return (
      <div onMouseDown={selectOnMouseDown(onSelect)} className={rowClass}>
        <span className="grid size-5 shrink-0 place-items-center text-ink-faint">
          <UnavailableGlyph />
        </span>
        <span className="min-w-0 truncate text-md text-ink-muted">
          {t(file.isError ? "productDocs.blocks.drive.failed" : "productDocs.blocks.drive.gone")}
        </span>
        {code}
      </div>
    );
  }
  const kind = t(`drive.${row.source === "google" ? "googleTypes" : "types"}.${row.type}`);
  return (
    <div onMouseDown={selectOnMouseDown(onSelect)} className={rowClass}>
      <span className="shrink-0 text-ink-muted">
        <TypeGlyph type={row.type} size={20} />
      </span>
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="min-w-0 truncate text-md font-semibold text-ink">{row.name}</span>
        {code}
        <span className="num min-w-0 truncate text-xs text-ink-faint">
          {row.sizeBytes === null ? kind : `${kind} · ${formatSize(row.sizeBytes, i18n.language)}`}
        </span>
      </span>
      <button
        type="button"
        aria-label={t("productDocs.blocks.drive.openLabel", { name: row.name })}
        onClick={() => open(row.id)}
        className={`${secondaryButton} h-7 px-2.5`}
      >
        {t("productDocs.blocks.drive.open")}
      </button>
    </div>
  );
}
