import { Link, useNavigate } from "@tanstack/react-router";
import { createContext, useContext, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useCreateProductPage, useDeleteProductPage, usePeople } from "../../data/queries";
import type { ProductPageView, ProductSpaceView, Project } from "../../data/types";
import { Dialog } from "../../tasks-ui/Dialog";
import { useToast } from "../../tasks-ui/Toast";
import { dangerButton } from "../task/parts";
import { secondaryButton } from "../tasks/controls";
import { DocNotFound, backLinkClass } from "../docs/parts";

// I pezzi comuni dello spazio Prodotto (shape product-space.md): lo spazio
// aperto per le viste figlie, i link, la creazione di una pagina, la pagina
// che non c'è e il dialogo d'eliminazione. Il corpo è dell'editor
// (`editor/BlockEditor`). Le regole (chi scrive, chi elimina, cosa si vede)
// arrivano dalla vista: qui non si ricalcola niente.

/**
 * Lo stato di salvataggio dell'editor della pagina aperta, per la barra
 * dello spazio ([PE 15]): la barra è una sola per spazio e pagina, l'editor
 * sta nella lettura.
 */
export interface EditorStatus {
  state: "idle" | "saving" | "saved" | "error";
  /** L'ultimo ⌘Z / ⇧⌘Z saltato perché altri hanno cambiato quei blocchi. */
  skipped: boolean;
  /** L'ultima scrittura rifiutata dal livello dati (`invalid: …`) e scartata. */
  dropped: boolean;
  retry: () => void;
}

export interface ProductSpaceContextValue {
  project: Project;
  space: ProductSpaceView;
  /** Apre i genitori di una pagina nell'albero (dopo «+» o un'apertura da fuori). */
  reveal: (pageId: string) => void;
  /** L'editor della pagina aperta dice come va il salvataggio (`null` = nessun editor). */
  setEditorStatus: (status: EditorStatus | null) => void;
}

export const ProductSpaceContext = createContext<ProductSpaceContextValue | null>(null);

export function useProductSpaceContext(): ProductSpaceContextValue {
  const value = useContext(ProductSpaceContext);
  if (!value) throw new Error("useProductSpaceContext fuori dallo spazio Prodotto");
  return value;
}

export const productIndexLink = (code: string) =>
  ({ to: "/p/$code/docs/product", params: { code } }) as const;

export const productPageLink = (code: string, page: string) =>
  ({ to: "/p/$code/docs/product/$page", params: { code, page } }) as const;

/** Il link da copiare (hash dell'app), lo stesso delle citazioni e di ⌘K. */
export const productPageHref = (code: string, page: string) => `#/p/${code}/docs/product/${page}`;

// Le pagine appena create: il loro titolo prende il fuoco quando si aprono,
// col testo selezionato per chi scrive ([PE 2]). Una sola volta per pagina.
const fresh = new Set<string>();

export const markFresh = (code: string) => void fresh.add(code);
export const takeFresh = (code: string) => fresh.delete(code);

/**
 * Crea «Untitled» / «Senza titolo» (in fondo ai fratelli di `parentId`) e la
 * apre. Un doppio clic non fa due pagine: chi la usa spegne il bottone con
 * `isPending`, e qui una creazione in volo ferma la seconda.
 */
export function useCreateAndOpen(project: Project, onCreated?: (pageId: string) => void) {
  const { t } = useTranslation();
  const create = useCreateProductPage();
  const navigate = useNavigate();
  const toast = useToast();
  const inflight = useRef(false);
  async function run(parentId: string | null) {
    if (inflight.current) return;
    inflight.current = true;
    const page = await create
      .mutateAsync({ projectId: project.id, title: t("productDocs.space.untitled"), parentId })
      .catch(() => null)
      .finally(() => {
        inflight.current = false;
      });
    if (!page) {
      toast.error(t("productDocs.space.createFailed"));
      return;
    }
    onCreated?.(page.id);
    markFresh(page.code);
    void navigate(productPageLink(project.code, page.code));
  }
  return { run, isPending: create.isPending };
}

/** Il nome di chi ha scritto; chi non c'è più ha la sua frase. */
export function usePersonName() {
  const { t } = useTranslation();
  const people = usePeople().data;
  return (id: string | null) =>
    (id && people?.find((p) => p.id === id)?.name) || t("productDocs.space.someone");
}

/**
 * La pagina è di questo spazio. Un codice di un altro progetto nell'indirizzo
 * di questo (`/p/ACQ/docs/product/AUD-D3`) è una pagina che qui non c'è (R-G5).
 */
export const inSpace = (page: ProductPageView | null, project: Project): page is ProductPageView =>
  !!page && page.projectId === project.id;

/** La chiave «appena aperto» dell'indice dello spazio (dopo l'eliminazione di una radice). */
export const indexFreshKey = (code: string) => `index:${code}`;

/**
 * La pagina che non c'è, o che chi guarda non legge: la stessa frase (R-G5,
 * [PS 20]). Dentro lo spazio torna all'indice; fuori (`outside`: progetto
 * invisibile o modulo spento, lo spazio stesso non c'è) alla pagina iniziale
 * dei Docs, così il link non riporta alla stessa pagina.
 */
export function ProductNotFound({ code, outside = false }: { code: string; outside?: boolean }) {
  const { t } = useTranslation();
  return (
    <DocNotFound
      back={
        <Link
          {...(outside ? ({ to: "/p/$code/docs", params: { code } } as const) : productIndexLink(code))}
          className={backLinkClass}
        >
          {t("docs.page.backToIndex")}
        </Link>
      }
    />
  );
}

/** Il lucchetto della riga di sola lettura (14 px). */
export function LockIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width={14}
      height={14}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="shrink-0 text-ink-faint"
    >
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </svg>
  );
}

/**
 * «Delete “Bills”?»: i commenti e la cronologia se ne vanno con la pagina, e
 * i link al suo codice smettono di funzionare. In corso «Deleting…», spento:
 * un doppio clic elimina una volta. Dopo, `onDeleted` (il genitore o l'indice).
 */
export function DeletePageDialog({
  page,
  onClose,
  onDeleted,
}: {
  page: { id: string; code: string; title: string };
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const remove = useDeleteProductPage();
  return (
    <Dialog
      title={t("productDocs.space.deleteTitle", { title: page.title })}
      description={t("productDocs.space.deleteBody", { code: page.code })}
      onClose={onClose}
      width={460}
      footer={
        <>
          <button type="button" onClick={onClose} className={secondaryButton}>
            {t("productDocs.space.cancel")}
          </button>
          <button
            type="button"
            disabled={remove.isPending}
            onClick={() =>
              remove.mutate(page.id, {
                onSuccess: () => {
                  toast.show(t("productDocs.space.deleted"));
                  onDeleted();
                },
                onError: () =>
                  toast.error(t("productDocs.space.deleteFailed", { title: page.title })),
              })
            }
            className={`${dangerButton} h-8 px-3 disabled:opacity-60`}
          >
            {remove.isPending ? t("productDocs.space.deleting") : t("productDocs.space.delete")}
          </button>
        </>
      }
    >
      {null}
    </Dialog>
  );
}
