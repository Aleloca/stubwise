import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useDeleteFilter,
  useDepartmentHomes,
  useMarkDepartmentHomeSeen,
  usePeople,
  usePersonalHome,
  usePinnedFilters,
  useSavedFilter,
  useSetFilterPinned,
  useSetPersonalHome,
} from "../../data/queries";
import type { HomeBlockRef, SavedFilter } from "../../data/types";
import { can, useViewer } from "../../data/viewer";
import { resolveHome, sameBlock } from "../../domain/home";
import { Dialog } from "../../tasks-ui/Dialog";
import { PageError, PageSkeleton } from "../../tasks-ui/PageStates";
import { useToast } from "../../tasks-ui/Toast";
import { dangerButton } from "../task/parts";
import { quietButton, secondaryButton } from "../tasks/controls";
import { TasksPage, type TasksPageState } from "../tasks/TasksPage";
import { SaveFilterDialog } from "./SaveFilterDialog";

/** Modifica ed eliminazione: solo l'autore o un full admin (spec §4). */
export function canManageFilter(
  filter: SavedFilter,
  viewer: ReturnType<typeof useViewer>["viewer"],
): boolean {
  return filter.ownerId === viewer.personId || can(viewer, "instance.full_admin");
}

/** «Private», oppure «Public · by <autore>». */
function FilterMeta({ filter }: { filter: SavedFilter }) {
  const { t } = useTranslation();
  const owner = usePeople().data?.find((p) => p.id === filter.ownerId);
  return (
    <p className="text-sm text-ink-muted">
      {filter.visibility === "private"
        ? t("filter.visibility.private")
        : t("filter.publicBy", { name: owner?.name ?? "…" })}
    </p>
  );
}

/**
 * «Add to Home»: un blocco del filtro in fondo alla Home della persona. Chi
 * non ha ancora una Home personale parte da quella dei suoi reparti (la
 * stessa che vede), e ne ha visto le ultime modifiche: la riga «è cambiata»
 * non deve comparire per un cambiamento che ha appena fatto lei.
 */
function useAddToHome(filter: SavedFilter) {
  const { t } = useTranslation();
  const { viewer } = useViewer();
  const toast = useToast();
  const navigate = useNavigate();
  const person = usePeople().data?.find((p) => p.id === viewer.personId);
  const departmentHomes = useDepartmentHomes().data;
  const personal = usePersonalHome().data;
  const setHome = useSetPersonalHome();
  const markSeen = useMarkDepartmentHomeSeen();
  const block: HomeBlockRef = { kind: "filter", filterId: filter.id };
  const ready = !!person && !!departmentHomes && personal !== undefined;
  const blocks = ready ? resolveHome(person, departmentHomes, personal).blocks : undefined;
  const onHome = !!blocks?.some((b) => sameBlock(b, block));

  const add = async () => {
    if (!ready || !blocks || onHome) return;
    const fresh = personal === null;
    try {
      await setHome.mutateAsync([...(personal?.blocks ?? blocks), block]);
      if (fresh) {
        for (const id of person.departmentIds) markSeen.mutate(id);
      }
      toast.show(t("filter.addedHome", { name: filter.name }), {
        action: { label: t("filter.openHome"), run: () => void navigate({ to: "/home" }) },
      });
    } catch {
      toast.error(t("filter.addHomeFailed", { name: filter.name }));
    }
  };
  return { ready, onHome, add };
}

/**
 * Le azioni del filtro, accanto all'h1: «Edit» e «Delete» solo a chi può
 * (autore o full admin), «Pin to column» / «Unpin from column» e «Add to
 * Home» a tutti. Fissare è ottimistico e torna indietro dicendolo.
 */
function FilterActions({
  filter,
  current,
  onLeaving,
}: {
  filter: SavedFilter;
  current: TasksPageState;
  onLeaving: (leaving: boolean) => void;
}) {
  const { t } = useTranslation();
  const { viewer } = useViewer();
  const toast = useToast();
  const navigate = useNavigate();
  const pinnedIds = usePinnedFilters().data;
  const setPinned = useSetFilterPinned();
  const remove = useDeleteFilter();
  const home = useAddToHome(filter);
  const [dialog, setDialog] = useState<"edit" | "delete" | null>(null);
  const [deleteFailed, setDeleteFailed] = useState(false);
  const manage = canManageFilter(filter, viewer);
  const pinned = !!pinnedIds?.includes(filter.id);

  const togglePin = () =>
    setPinned.mutate(
      { filterId: filter.id, pinned: !pinned },
      {
        onError: () =>
          toast.error(
            t(pinned ? "filter.unpinFailed" : "filter.pinFailed", { name: filter.name }),
          ),
      },
    );

  const confirmDelete = async () => {
    setDeleteFailed(false);
    // La pagina se ne va: niente «Filter not found» mentre il filtro sparisce.
    onLeaving(true);
    try {
      await remove.mutateAsync(filter.id);
      toast.show(t("filter.deleted", { name: filter.name }));
      void navigate({ to: "/filters" });
    } catch {
      onLeaving(false);
      setDeleteFailed(true);
    }
  };

  // Dopo una modifica i criteri salvati sono quelli correnti: l'indirizzo torna pulito.
  const afterEdit = () =>
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        view: undefined,
        group: undefined,
        filters: undefined,
      }),
      replace: true,
    } as never);

  return (
    <>
      <div role="group" aria-label={t("filter.actions")} className="-mr-2.5 flex flex-wrap gap-0.5">
        {manage && (
          <button type="button" className={quietButton} onClick={() => setDialog("edit")}>
            {t("filter.edit")}
          </button>
        )}
        <button
          type="button"
          className={quietButton}
          disabled={pinnedIds === undefined}
          onClick={togglePin}
        >
          {pinned ? t("filter.unpin") : t("filter.pin")}
        </button>
        <button
          type="button"
          className={quietButton}
          disabled={!home.ready || home.onHome}
          onClick={() => void home.add()}
        >
          {home.onHome ? t("filter.onHome") : t("filter.addToHome")}
        </button>
        {manage && (
          <button type="button" className={quietButton} onClick={() => setDialog("delete")}>
            {t("filter.delete")}
          </button>
        )}
      </div>
      {dialog === "edit" && (
        <SaveFilterDialog
          filter={filter}
          criteria={current.criteria}
          view={current.view}
          groupBy={current.groupBy}
          changed={current.changed}
          onClose={() => setDialog(null)}
          onSaved={(saved) => {
            const sameAsPage =
              saved.view === current.view &&
              saved.groupBy === current.groupBy &&
              JSON.stringify(saved.criteria) === JSON.stringify(current.criteria);
            if (current.changed && sameAsPage) afterEdit();
          }}
        />
      )}
      {dialog === "delete" && (
        <Dialog
          title={t("filter.deleteTitle", { name: filter.name })}
          description={
            filter.visibility === "public"
              ? t("filter.deleteBodyPublic")
              : t("filter.deleteBodyPrivate")
          }
          onClose={() => setDialog(null)}
          width={440}
          footer={
            <>
              <button type="button" className={secondaryButton} onClick={() => setDialog(null)}>
                {t("filter.dialog.cancel")}
              </button>
              <button
                type="button"
                data-autofocus
                className={`${dangerButton} h-8 px-3`}
                disabled={remove.isPending}
                onClick={() => void confirmDelete()}
              >
                {t("filter.deleteConfirm")}
              </button>
            </>
          }
        >
          {deleteFailed ? (
            <p role="alert" className="rounded-md bg-critical/10 px-3 py-2 text-sm text-ink">
              {t("filter.deleteFailed", { name: filter.name })}
            </p>
          ) : null}
        </Dialog>
      )}
    </>
  );
}

/**
 * Un filtro salvato: la stessa pagina delle task (`TasksPage` col filtro),
 * con il nome per h1, sotto «Private» o «Public · by <autore>», e accanto le
 * azioni. Su più progetti la board ha colonne per famiglia e la timeline
 * raggruppa per progetto. Le task sono sempre quelle che chi guarda può
 * vedere, anche in un filtro pubblico di un altro. Un filtro privato di un
 * altro risponde come uno che non esiste.
 */
export function FilterPage({ id }: { id: string }) {
  const { t } = useTranslation();
  const { data: loaded, isPending, isError, refetch } = useSavedFilter(id);
  // Durante l'eliminazione resta a schermo l'ultimo filtro letto.
  const [leaving, setLeaving] = useState<SavedFilter | null>(null);
  const filter = leaving ?? loaded;
  if (isError) {
    return (
      <section className="page-header flex h-full flex-col pl-8 [--page-header-pr:32px] [--page-header-pt:32px]">
        <PageError message={t("filter.error")} onRetry={() => void refetch()} />
      </section>
    );
  }
  if (isPending) {
    return (
      <section className="page-header flex h-full flex-col gap-4 [--page-header-pr:32px] [--page-header-pt:32px]">
        <span className="ml-8 block h-7 w-56 rounded-sm bg-ink/8" aria-hidden="true" />
        <div className="border-t border-rule">
          <PageSkeleton />
        </div>
      </section>
    );
  }
  if (!filter) {
    return (
      <section className="page-header flex h-full flex-col items-start gap-2 pb-8 pl-8 [--page-header-pr:32px] [--page-header-pt:32px]">
        <h1 className="text-2xl font-semibold text-ink">{t("filter.notFound")}</h1>
        <p className="text-md text-ink-muted">{t("filter.notFoundBody")}</p>
        <Link to="/filters" className="text-md text-ink underline underline-offset-4">
          {t("filter.backAll")}
        </Link>
        <Link to="/home" className="text-md text-ink underline underline-offset-4">
          {t("filter.backHome")}
        </Link>
      </section>
    );
  }
  return (
    <TasksPage
      key={filter.id}
      savedFilter={filter}
      meta={<FilterMeta filter={filter} />}
      actions={(current) => (
        <FilterActions
          filter={filter}
          current={current}
          onLeaving={(on) => setLeaving(on ? filter : null)}
        />
      )}
    />
  );
}
