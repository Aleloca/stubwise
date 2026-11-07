import { useCallback, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import { useTranslation } from "react-i18next";
import { useReadProductExport } from "../../../data/queries";
import type { ProductExportView } from "../../../data/types";
import { exportModelOf, type ExportDoc } from "../../../domain/productDocs/exportModel";
import { fitFileName, MAX_SAVE_BYTES, saveExport } from "../../../platform/saveFile";
import { useToast } from "../../../tasks-ui/Toast";
import { buildDocx, svgToPng, wordLeftOutReasons } from "./docx";
import { printRoot } from "./PrintView";

// L'esportazione (area 11a, Task 12; shape product-space.md §3.8). Una sola
// alla volta: un doppio clic (o «Export» mentre si prepara) non ne fa due.
// Il livello dati risolve file e decisioni per chi esporta (P20); qui le
// frasi si compongono in en o it, e basta. Il PDF monta la vista di stampa
// in `#print-root` solo per la durata della chiamata; il Word si costruisce
// col modello e si passa coi suoi byte. Annullata: nessun avviso. Errore
// (anche un Word che non si costruisce): «Couldn't export · Retry», e Retry
// rifà la stessa esportazione. Un Word oltre il tetto del processo
// principale: l'avviso dice il perché e il PDF, senza Retry (fallirebbe uguale).

export type ExportScope = "page" | "space";
export type ExportFormat = "pdf" | "docx";

export function useProductExport({
  projectId,
  projectCode,
  page,
  button,
}: {
  projectId: string;
  projectCode: string;
  /** La pagina aperta; `null` sull'indice dello spazio. */
  page: { id: string; code: string; title: string } | null;
  /** «Export ▾»: il fuoco ci torna alla fine (e al Retry, che sparisce). */
  button: RefObject<HTMLButtonElement | null>;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const read = useReadProductExport();
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const [printing, setPrinting] = useState<ExportDoc | null>(null);

  const modelOf = useCallback(
    (view: ProductExportView, title: string): ExportDoc =>
      exportModelOf(
        { title, pages: view.pages },
        {
          driveLine: (fileId, code) => {
            const file = view.files[fileId];
            return file
              ? t("productDocs.export.fileLine", { name: file.name, code })
              : t("productDocs.export.fileGone", { code });
          },
          decisionLine: (id) => {
            const decision = view.decisions[id];
            return decision
              ? t("productDocs.export.decisionLine", { title: decision.title })
              : t("productDocs.export.decisionHidden");
          },
          // 11b: l'SVG lo dà il livello dati (le pagine non leggono il seme).
          wireframe: (id, variant) => view.wireframes?.[`${id}:${variant}`] ?? null,
        },
      ),
    [t],
  );

  const start = useCallback(
    async function run(scope: ExportScope, format: ExportFormat): Promise<void> {
      if (running.current) return;
      if (scope === "page" && !page) return;
      running.current = true;
      setBusy(true);
      // Il fuoco su «Export ▾» (spento ma raggiungibile): un Retry che sparisce non lo lascia sul body.
      button.current?.focus();
      const retry = () => void run(scope, format);
      const failed = () =>
        toast.error(t("productDocs.export.failed"), { action: { label: t("productDocs.export.retry"), run: retry } });
      try {
        const view = await read(projectId, scope === "page" ? { pageId: page!.id } : {});
        if (!view) {
          failed();
          return;
        }
        // La pagina com'è adesso (un titolo appena cambiato vale già).
        const current = view.pages[0]?.page;
        const title =
          scope === "page" && current ? current.title : t("productDocs.export.spaceTitle", { code: projectCode });
        const name = scope === "page" && current ? `${current.code} ${current.title}` : title;
        const doc = modelOf(view, title);
        if (format === "pdf") {
          flushSync(() => setPrinting(doc));
          document.body.dataset.printing = "";
          try {
            await Promise.all(
              [...printRoot().querySelectorAll("img")].map((img) => img.decode().catch(() => undefined)),
            );
            const result = await saveExport({ format: "pdf", name: fitFileName(name, "pdf") });
            if (result.saved) toast.show(t("productDocs.export.savedPdf"));
            else if (result.reason !== "canceled") failed();
          } finally {
            delete document.body.dataset.printing;
            flushSync(() => setPrinting(null));
          }
        } else {
          const data = await buildDocx(doc, {
            label: t("productDocs.wireframe.exportLabel"),
            name: t("productDocs.wireframe.kind"),
            gone: t("productDocs.wireframe.gone"),
            missing: t("productDocs.wireframe.exportMissing"),
            toPng: svgToPng,
          });
          if (data.byteLength > MAX_SAVE_BYTES) {
            toast.error(t("productDocs.export.tooLarge"));
            return;
          }
          const result = await saveExport({ format: "docx", name: fitFileName(name, "docx"), data });
          // L'avviso dice il motivo vero di ogni immagine rimasta fuori (formato, o non `data:`), senza ripeterlo.
          const leftOut = wordLeftOutReasons(doc);
          const reasons = [
            ...new Set(leftOut.map((r) => ("format" in r ? r.format : t("productDocs.export.notDataImage")))),
          ].join(", ");
          if (result.saved) {
            toast.show(
              leftOut.length > 0
                ? t("productDocs.export.savedWordLeftOut", { count: leftOut.length, reasons })
                : t("productDocs.export.savedWord"),
            );
          } else if (result.reason !== "canceled") failed();
        }
      } catch {
        failed();
      } finally {
        running.current = false;
        setBusy(false);
        // Alla fine il fuoco torna su «Export ▾», se nel frattempo non è andato altrove.
        const active = document.activeElement;
        if (!active || active === document.body || active === button.current) button.current?.focus();
      }
    },
    [button, modelOf, page, projectCode, projectId, read, t, toast],
  );

  return { busy, printing, start };
}
