import { Link, useNavigate } from "@tanstack/react-router";
import { createContext, useContext, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { richSegments } from "../../domain/productDocs/richText";
import { useCreateProductPage, useDeleteProductPage, usePeople } from "../../data/queries";
import type {
  ProductBlock,
  ProductPageView,
  ProductSpaceView,
  Project,
  RichText,
} from "../../data/types";
import { Dialog } from "../../tasks-ui/Dialog";
import { useToast } from "../../tasks-ui/Toast";
import { dangerButton } from "../task/parts";
import { secondaryButton } from "../tasks/controls";
import { DocNotFound, backLinkClass } from "../docs/parts";

// I pezzi comuni dello spazio Prodotto (shape product-space.md): lo spazio
// aperto per le viste figlie, i link, la creazione di una pagina, la pagina
// che non c'è, il dialogo d'eliminazione e la lettura del corpo finché
// l'editor (Task 8) non la sostituisce. Le regole (chi scrive, chi elimina,
// cosa si vede) arrivano dalla vista: qui non si ricalcola niente.

export interface ProductSpaceContextValue {
  project: Project;
  space: ProductSpaceView;
  /** Apre i genitori di una pagina nell'albero (dopo «+» o un'apertura da fuori). */
  reveal: (pageId: string) => void;
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

// Le pagine appena create: il loro h1 prende il fuoco quando si aprono (il
// titolo modificabile arriva col Task 8, P17). Una sola volta per pagina.
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

/** Una frase coi suoi segni: grassetto, corsivo, link (sempre http(s): il dato lo garantisce). */
function Rich({ content }: { content: RichText }) {
  return (
    <>
      {richSegments(content).map((s, i) => {
        let node: ReactNode = s.text;
        if (s.bold) node = <strong className="font-semibold">{node}</strong>;
        if (s.italic) node = <em>{node}</em>;
        if (s.href)
          node = (
            <a
              href={s.href}
              target="_blank"
              rel="noreferrer"
              className="text-ink underline decoration-ink/40 underline-offset-4 hover:decoration-ink"
            >
              {node}
            </a>
          );
        return <span key={i}>{node}</span>;
      })}
    </>
  );
}

/** Un blocco che non è testo, finché i Task 8 e 9 non lo disegnano: una riga tenue. */
function Placeholder({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-md border border-dashed border-rule px-3 py-2 text-sm text-ink-muted">
      {children}
    </p>
  );
}

function Block({
  block,
  page,
  number,
}: {
  block: ProductBlock;
  page: ProductPageView;
  /** Il numero di una voce numerata (le voci di fila allo stesso rientro). */
  number: number;
}) {
  const { t } = useTranslation();
  switch (block.type) {
    case "heading": {
      const size = ["text-xl", "text-lg", "text-md"][block.level - 1];
      const Tag = (["h2", "h3", "h4"] as const)[block.level - 1]!;
      return (
        <Tag className={`${size} mt-4 font-semibold text-balance text-ink`}>
          <Rich content={block.content} />
        </Tag>
      );
    }
    case "paragraph":
      return (
        <p className="text-md text-pretty text-ink">
          <Rich content={block.content} />
        </p>
      );
    case "quote":
      return (
        <blockquote className="border-l-2 border-rule-strong pl-3 text-md text-ink-muted">
          <Rich content={block.content} />
        </blockquote>
      );
    case "bullet":
    case "numbered":
      return (
        <p style={{ paddingLeft: 24 + block.indent * 20 }} className="relative text-md text-ink">
          <span
            aria-hidden="true"
            style={{ left: 4 + block.indent * 20 }}
            className="num absolute text-ink-muted"
          >
            {block.type === "bullet" ? "•" : `${number}.`}
          </span>
          <Rich content={block.content} />
        </p>
      );
    case "todo":
      return (
        <p className="flex items-start gap-2 text-md text-ink">
          <span
            aria-hidden="true"
            className={`mt-1 grid size-3.5 shrink-0 place-items-center rounded-[3px] border ${block.checked ? "border-ink bg-ink" : "border-rule-strong"}`}
          />
          <span className={block.checked ? "text-ink-muted line-through" : undefined}>
            <Rich content={block.content} />
          </span>
        </p>
      );
    case "divider":
      return <hr className="my-2 border-rule" />;
    case "table":
      return <Placeholder>{t("productDocs.space.blockTable")}</Placeholder>;
    case "image":
      return <Placeholder>{block.caption || t("productDocs.space.blockImage")}</Placeholder>;
    case "drive":
      return <Placeholder>{t("productDocs.space.blockDrive", { code: block.code })}</Placeholder>;
    case "decision": {
      // Una decisione che chi legge non vede non dice titolo né data (R-G5).
      const d = page.decisions[block.decisionId];
      return <Placeholder>{d ? d.title : t("productDocs.space.blockDecision")}</Placeholder>;
    }
  }
}

/** Il corpo da leggere (Task 7): l'editor del Task 8 lo sostituisce. */
export function ReadBody({ page }: { page: ProductPageView }) {
  // Le voci numerate contano di fila, per rientro; un altro blocco riparte da 1.
  const counters: number[] = [];
  const numbers = page.blocks.map((block) => {
    if (block.type !== "numbered") {
      counters.length = 0;
      return 0;
    }
    counters.length = block.indent + 1;
    counters[block.indent] = (counters[block.indent] ?? 0) + 1;
    return counters[block.indent]!;
  });
  return (
    <div className="flex flex-col gap-3">
      {page.blocks.map((block, i) => (
        <Block key={block.id} block={block} page={page} number={numbers[i]!} />
      ))}
    </div>
  );
}
