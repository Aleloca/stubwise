import { useSearch } from "@tanstack/react-router";
import { Component, useCallback, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  useDepartments,
  useHome,
  useMarkDepartmentHomeSeen,
  useSetPersonalHome,
} from "../../data/queries";
import type { HomeBlockRef } from "../../data/types";
import { canInDepartment, useViewer } from "../../data/viewer";
import { sameBlock } from "../../domain/home";
import { DeptLegend } from "../../layout/DeptStrip";
import { MenuGroup, itemClass } from "../../tasks-ui/Menu";
import { PageError, PageSkeleton } from "../../tasks-ui/PageStates";
import { useToast } from "../../tasks-ui/Toast";
import { ghostButton } from "../task/parts";
import { MenuButton, secondaryButton } from "../tasks/controls";
import { useTaskKeys } from "../tasks/useTaskKeys";
import { blockKey, useBlockTitle } from "./blockTitle";
import { BlockSection, DepartmentsReport, useOpenTask } from "./blocks/BlockSection";
import { BLOCKS, useBlockContext } from "./blocks/registry";
import { HomeEditor, type EditTarget } from "./HomeEditor";

/**
 * La Home (shape home.md): un indice a sezioni in una sola colonna di
 * lettura (fino a 960 px, allineata a sinistra). In testa l'h1 e
 * «Customize»; sotto, se la Home di un reparto è cambiata dopo che la
 * persona ha personalizzato la sua, una riga discreta «Your department's
 * Home has changed · See what's new»; poi i blocchi risolti, «Decide» e «My
 * week» per primi. Ogni blocco ha i suoi stati: l'errore di uno resta lì.
 * «Customize» apre la modalità modifica sulla stessa route; chi gestisce la
 * Home di un suo reparto sceglie prima quale.
 */
export function HomePage() {
  const { t } = useTranslation();
  const { viewer } = useViewer();
  const blockCtx = useBlockContext();
  const home = useHome();
  const departments = useDepartments().data;
  const [editing, setEditing] = useState<EditTarget | null>(null);
  const [whatsNew, setWhatsNew] = useState<HomeBlockRef[] | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const search = useSearch({ strict: false }) as { task?: string };
  const openTask = useOpenTask();
  useTaskKeys({ body, openCode: search.task, onOpen: openTask });
  // I reparti delle strisce a schermo, blocco per blocco: la legenda ne fa l'unione.
  const [shownDepts, setShownDepts] = useState<Record<string, string[]>>({});
  const report = useCallback(
    (block: string, ids: string[]) =>
      setShownDepts((prev) =>
        prev[block]?.join() === ids.join() ? prev : { ...prev, [block]: ids },
      ),
    [],
  );

  const data = home.data;
  const managed = (data?.person.departmentIds ?? [])
    .filter((id) => canInDepartment(viewer, "department.home.manage", id))
    .flatMap((id) => {
      const d = departments?.find((x) => x.id === id);
      return d ? [{ id: d.id, name: d.name }] : [];
    });

  const header = (
    <header className="page-header flex shrink-0 items-center gap-6 pb-5 [--page-header-pr:32px] [--page-header-pt:32px]">
      <h1 className="text-2xl font-semibold text-ink">{t("nav.home")}</h1>
      {data && !editing && (
        <span className="flex min-w-0 flex-1 justify-end">
          <DeptLegend departmentIds={Object.values(shownDepts).flat()} />
        </span>
      )}
      {data && !editing && (
        <span className="shrink-0">
          {managed.length === 0 ? (
            <button
              type="button"
              className={secondaryButton}
              onClick={() => setEditing({ kind: "mine" })}
            >
              {t("home.customize")}
            </button>
          ) : (
            <MenuButton
              label={t("home.customize")}
              menuLabel={t("home.customizeMenu")}
              className={secondaryButton}
              align="right"
            >
              {(close) => (
                <MenuGroup>
                  {[
                    { kind: "mine" } as EditTarget,
                    ...managed.map(
                      (d): EditTarget => ({ kind: "department", departmentId: d.id, name: d.name }),
                    ),
                  ].map((target) => (
                    <button
                      key={target.kind === "mine" ? "mine" : target.departmentId}
                      type="button"
                      role="menuitem"
                      tabIndex={-1}
                      className={itemClass}
                      onClick={() => {
                        close();
                        setEditing(target);
                      }}
                    >
                      {target.kind === "mine"
                        ? t("home.editor.mine")
                        : t("home.editor.department", { name: target.name })}
                    </button>
                  ))}
                </MenuGroup>
              )}
            </MenuButton>
          )}
        </span>
      )}
    </header>
  );

  let content: ReactNode;
  if (home.isError) {
    content = (
      <PageError
        message={t("home.block.error", { title: t("nav.home") })}
        onRetry={() => void home.refetch()}
      />
    );
  } else if (!data) {
    content = (
      <div className="border-t border-rule pt-5">
        <span aria-hidden="true" className="mb-4 block h-5 w-32 rounded-sm bg-ink/8" />
        <PageSkeleton rows={4} />
      </div>
    );
  } else if (editing) {
    content = (
      <HomeEditor
        key={editing.kind === "mine" ? "mine" : editing.departmentId}
        target={editing}
        home={data}
        onClose={() => setEditing(null)}
      />
    );
  } else {
    const blocks = data.blocks.filter((b) => BLOCKS[b.kind].available(viewer, blockCtx));
    content = (
      <>
        {whatsNew ? (
          <WhatsNew blocks={whatsNew} onClose={() => setWhatsNew(null)} />
        ) : (
          data.departmentChanged.length > 0 && <ChangedLine onSee={(found) => setWhatsNew(found)} />
        )}
        {blocks.map((block) => (
          <BlockBoundary key={blockKey(block)} block={block}>
            <HomeBlock block={block} />
          </BlockBoundary>
        ))}
      </>
    );
  }

  return (
    <DepartmentsReport.Provider value={report}>
      <section className="flex min-h-full flex-col pb-16 pl-8">
        <div ref={body} className="flex w-full max-w-[960px] flex-col pr-8">
          {header}
          {content}
        </div>
      </section>
    </DepartmentsReport.Provider>
  );
}

function HomeBlock({ block }: { block: HomeBlockRef }) {
  const Block = BLOCKS[block.kind].component;
  return <Block block={block} />;
}

/**
 * «Your department's Home has changed · See what's new». Vedere le novità
 * segna viste le Home cambiate (la riga non torna fino al prossimo cambio)
 * e mostra al suo posto i blocchi nuovi, ognuno con «Add».
 */
function ChangedLine({ onSee }: { onSee: (found: HomeBlockRef[]) => void }) {
  const { t } = useTranslation();
  const { viewer } = useViewer();
  const blockCtx = useBlockContext();
  const home = useHome().data!;
  const markSeen = useMarkDepartmentHomeSeen();
  const see = () => {
    const found: HomeBlockRef[] = [];
    for (const id of home.departmentChanged) {
      const dept = home.departmentHomes.find((h) => h.departmentId === id);
      for (const b of dept?.blocks ?? []) {
        if (!BLOCKS[b.kind].available(viewer, blockCtx)) continue;
        if (home.blocks.some((x) => sameBlock(x, b)) || found.some((x) => sameBlock(x, b)))
          continue;
        found.push(b);
      }
      markSeen.mutate(id);
    }
    onSee(found);
  };
  return (
    <p className="flex items-center gap-2 border-t border-rule py-2.5 text-sm text-ink-muted">
      <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-ink" />
      <span>{t("home.changed")}</span>
      <span aria-hidden="true" className="text-ink-faint">
        ·
      </span>
      <button
        type="button"
        onClick={see}
        className="font-medium text-ink underline underline-offset-4 hover:no-underline"
      >
        {t("home.seeNew")}
      </button>
    </p>
  );
}

/** I blocchi nuovi della Home del reparto, con «Add» accanto: aggiungerne uno lo mette in fondo. */
function WhatsNew({ blocks, onClose }: { blocks: HomeBlockRef[]; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const home = useHome().data!;
  const title = useBlockTitle();
  const save = useSetPersonalHome();
  const add = (block: HomeBlockRef) =>
    save.mutate([...(home.personal?.blocks ?? home.blocks), block], {
      onError: () => toast.error(t("home.editor.saveFailed")),
    });
  return (
    <section
      aria-label={t("home.whatsNewTitle")}
      className="mb-2 flex flex-col gap-2 border-t border-rule py-3"
    >
      <div className="flex items-center gap-2">
        <h2 className="heading-group">{t("home.whatsNewTitle")}</h2>
        <button type="button" className={`${ghostButton} ml-auto`} onClick={onClose}>
          {t("home.close")}
        </button>
      </div>
      {blocks.length === 0 ? (
        <p className="text-sm text-ink-muted">{t("home.nothingNew")}</p>
      ) : (
        <ul className="flex flex-col">
          {blocks.map((b) => {
            const on = home.blocks.some((x) => sameBlock(x, b));
            return (
              <li
                key={blockKey(b)}
                className="flex h-9 items-center gap-3 border-b border-rule pl-4 last:border-b-0"
              >
                <span className="min-w-0 flex-1 truncate text-md text-ink">{title(b)}</span>
                <button
                  type="button"
                  className={ghostButton}
                  disabled={on || save.isPending}
                  aria-label={on ? undefined : t("home.addTo", { title: title(b) })}
                  onClick={() => add(b)}
                >
                  {on ? t("filter.onHome") : t("home.add")}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * Un blocco che si rompe nel disegno resta un blocco in errore, con
 * «Retry» che lo ridisegna: il resto della Home continua.
 */
class BlockBoundary extends Component<
  { block: HomeBlockRef; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return <FailedBlock block={this.props.block} retry={() => this.setState({ failed: false })} />;
  }
}

function FailedBlock({ block, retry }: { block: HomeBlockRef; retry: () => void }) {
  const title = useBlockTitle();
  return <BlockSection title={title(block)} state={{ status: "error", retry }} />;
}
