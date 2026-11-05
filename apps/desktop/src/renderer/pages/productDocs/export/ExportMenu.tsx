import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Chevron, itemClass, Menu, MenuGroup, MenuNote } from "../../../tasks-ui/Menu";
import { Spinner } from "../../drive/glyphs";
import { pageBarButton } from "../FollowButton";
import { useProductExport, type ExportFormat, type ExportScope } from "./exportProduct";
import { PrintView } from "./PrintView";

// «Export ▾» nella barra dello spazio Prodotto (shape product-space.md §3.8,
// [PS 17], [PS 18]): un menu di 240 px con THIS PAGE (sulla pagina) e WHOLE
// SPACE × PDF / Word, la riga «8 pages, in tree order» subito sotto WHOLE
// SPACE (vale per i due formati) e «Comments aren't included.». Uno spazio
// senza pagine non ha «Export» (come non ha la ricerca). In
// corso il bottone dice «Preparing…» col cerchio d'attesa neutro, ed è
// spento con `aria-disabled` (non `disabled`): il fuoco ci resta sopra, e un
// clic non apre nulla. Il fuoco torna qui alla chiusura del menu e alla fine
// dell'esportazione. A 1024, se la barra non ci sta, gli stessi gruppi
// stanno nel «⋯» della pagina ([PS 10], `ExportGroups`).

/**
 * I gruppi dell'esportazione, nel menu «Export ▾» o nel «⋯» della pagina:
 * THIS PAGE (se c'è una pagina) e WHOLE SPACE, ciascuno con PDF e Word.
 * `busy`: un'esportazione in corso, le voci sono spente (con la frase).
 */
export function ExportGroups({
  hasPage,
  pageCount,
  busy = false,
  onChoose,
}: {
  hasPage: boolean;
  pageCount: number;
  busy?: boolean;
  onChoose: (scope: ExportScope, format: ExportFormat) => void;
}) {
  const { t } = useTranslation();
  const items = (scope: ExportScope) => (
    <>
      {(["pdf", "docx"] as const).map((format) => (
        <button
          key={format}
          type="button"
          role="menuitem"
          tabIndex={-1}
          aria-disabled={busy || undefined}
          className={`${itemClass} aria-disabled:text-ink-muted aria-disabled:hover:bg-transparent`}
          onClick={() => {
            if (!busy) onChoose(scope, format);
          }}
        >
          {t(format === "pdf" ? "productDocs.export.pdf" : "productDocs.export.word")}
        </button>
      ))}
    </>
  );
  return (
    <>
      {hasPage && <MenuGroup label={t("productDocs.export.thisPage")}>{items("page")}</MenuGroup>}
      <MenuGroup label={t("productDocs.export.wholeSpace")}>
        {/* Sotto il titolo, prima dei formati: vale per il PDF come per il Word (Impeccable 15). */}
        <span className="num px-2 pb-1 text-xs text-ink-faint">
          {t("productDocs.export.treeOrder", { count: pageCount })}
        </span>
        {items("space")}
      </MenuGroup>
      <div className="mt-1 border-t border-rule pt-1">
        <MenuNote>{t("productDocs.export.noComments")}</MenuNote>
      </div>
    </>
  );
}

export function ExportMenu({
  project,
  page,
  pageCount,
}: {
  project: { id: string; code: string };
  /** La pagina aperta; `null` sull'indice (solo WHOLE SPACE). */
  page: { id: string; code: string; title: string } | null;
  pageCount: number;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const { busy, printing, start } = useProductExport({
    projectId: project.id,
    projectCode: project.code,
    page,
    button,
  });

  const close = (restore: boolean) => {
    setOpen(false);
    if (restore) button.current?.focus();
  };
  const choose = (scope: ExportScope, format: ExportFormat) => {
    close(true);
    void start(scope, format);
  };

  return (
    // Aperto, il menu sta sopra la colonna dei commenti sovrapposta (z-45, sotto i 1200).
    <span className={`relative inline-flex shrink-0 ${open ? "z-50" : ""}`}>
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-disabled={busy || undefined}
        onClick={() => {
          if (busy) return;
          setOpen((o) => !o);
        }}
        className={`${pageBarButton} aria-expanded:bg-ink/10 aria-expanded:text-ink aria-disabled:cursor-default aria-disabled:hover:bg-transparent aria-disabled:hover:text-ink-muted`}
      >
        {busy ? (
          <>
            <Spinner />
            {t("productDocs.export.preparing")}
          </>
        ) : (
          <>
            {t("productDocs.export.button")}
            <Chevron />
          </>
        )}
      </button>
      {open && !busy && (
        <Menu label={t("productDocs.export.menu")} onClose={close} align="right">
          <div className="flex w-[228px] flex-col">
            <ExportGroups hasPage={page !== null} pageCount={pageCount} onChoose={choose} />
          </div>
        </Menu>
      )}
      {printing && <PrintView doc={printing} label={t("productDocs.export.printLabel")} />}
    </span>
  );
}
