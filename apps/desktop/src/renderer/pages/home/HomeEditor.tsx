import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { useId, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  useResetPersonalHome,
  useSavedFilters,
  useSetDepartmentHome,
  useSetPersonalHome,
} from "../../data/queries";
import type { DepartmentHome, HomeBlockRef, PersonalHome, Person } from "../../data/types";
import { useViewer } from "../../data/viewer";
import { FIXED_BLOCKS, resolveHome, sameBlock } from "../../domain/home";
import { Dialog } from "../../tasks-ui/Dialog";
import { MenuGroup, MenuNote, itemClass } from "../../tasks-ui/Menu";
import { useToast } from "../../tasks-ui/Toast";
import { ghostButton } from "../task/parts";
import { MenuButton, primaryButton, quietButton, secondaryButton } from "../tasks/controls";
import { blockKey, useBlockTitle } from "./blockTitle";
import { CATALOG_KINDS, BLOCKS } from "./blocks/registry";

export type EditTarget =
  | { kind: "mine" }
  | { kind: "department"; departmentId: string; name: string };

const isFixed = (b: HomeBlockRef) => FIXED_BLOCKS.includes(b.kind);

/**
 * La modalità modifica della Home (shape home.md §6): la pagina resta sulla
 * stessa route e ogni blocco diventa una riga compatta — maniglia, titolo,
 * «Hide» (Decide e My week col lucchetto: «Always shown»). Si riordina col
 * trascinamento, col mouse e con la tastiera (Spazio prende, frecce
 * spostano, Spazio lascia, Esc annulla; ogni passo è annunciato). In fondo
 * «Add block» dal catalogo (solo ciò che chi guarda può avere, più i filtri
 * che vede); in testa «Done», «Cancel» e, per la propria Home
 * personalizzata, «Reset to department Home» con conferma. Si riordinano
 * titoli, non liste: i contenuti dei blocchi qui non ci sono.
 */
export function HomeEditor({
  target,
  home,
  onClose,
}: {
  target: EditTarget;
  home: {
    person: Person;
    blocks: HomeBlockRef[];
    personal: PersonalHome | null;
    departmentHomes: DepartmentHome[];
  };
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { viewer } = useViewer();
  const toast = useToast();
  const title = useBlockTitle();
  const filters = useSavedFilters().data;
  const savePersonal = useSetPersonalHome();
  const saveDepartment = useSetDepartmentHome();
  const reset = useResetPersonalHome();
  const [draft, setDraft] = useState<HomeBlockRef[]>(() =>
    target.kind === "mine"
      ? home.blocks
      : resolveHome(
          { ...home.person, departmentIds: [target.departmentId] },
          home.departmentHomes,
          null,
        ).blocks,
  );
  const [confirmReset, setConfirmReset] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const saving = savePersonal.isPending || saveDepartment.isPending;
  const instructionsId = useId();
  const listRef = useRef<HTMLUListElement>(null);

  const save = async () => {
    try {
      if (target.kind === "mine") {
        await savePersonal.mutateAsync(draft);
        toast.show(t("home.editor.saved"));
      } else {
        await saveDepartment.mutateAsync({ departmentId: target.departmentId, blocks: draft });
        toast.show(t("home.editor.departmentSaved", { name: target.name }));
      }
      onClose();
    } catch {
      toast.error(t("home.editor.saveFailed"));
    }
  };

  const doReset = async () => {
    try {
      await reset.mutateAsync();
      toast.show(t("home.editor.resetDone"));
      onClose();
    } catch {
      setConfirmReset(false);
      toast.error(t("home.editor.resetFailed"));
    }
  };

  const catalog = CATALOG_KINDS.filter(
    (kind) =>
      !FIXED_BLOCKS.includes(kind) &&
      BLOCKS[kind].available(viewer) &&
      !draft.some((b) => b.kind === kind),
  );
  const filterChoices = (filters ?? [])
    // La Home di un reparto la vedono tutti: solo filtri pubblici, o per gli altri sarebbe «non disponibile».
    .filter((f) => target.kind === "mine" || f.visibility === "public")
    .filter((f) => !draft.some((b) => sameBlock(b, { kind: "filter", filterId: f.id })))
    .sort((a, b) => a.name.localeCompare(b.name));
  const add = (block: HomeBlockRef) => {
    setDraft((d) => [...d, block]);
    setAnnouncement(t("home.editor.added", { title: title(block) }));
  };
  const hide = (index: number) => {
    const block = draft[index]!;
    setDraft((d) => d.filter((_, i) => i !== index));
    // Il fuoco va alla riga che prende il posto (o all'ultima): non si perde nel vuoto.
    requestAnimationFrame(() => {
      const handles = listRef.current?.querySelectorAll<HTMLElement>("[data-block-handle]");
      handles?.[Math.min(index, handles.length - 1)]?.focus();
    });
    setAnnouncement(t("home.editor.hidden", { title: title(block) }));
  };

  // --- trascinamento col puntatore (dnd-kit), annunciato coi nomi veri ------
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const ids = draft.map(blockKey);
  const at = (id: unknown) => ids.indexOf(String(id));
  const titleOf = (id: unknown) => {
    const b = draft[at(id)];
    return b ? title(b) : "";
  };
  const announcements: Announcements = {
    onDragStart: ({ active }) =>
      t("home.editor.picked", {
        title: titleOf(active.id),
        position: at(active.id) + 1,
        total: ids.length,
      }),
    onDragOver: ({ active, over }) =>
      over
        ? t("home.editor.moved", {
            title: titleOf(active.id),
            position: at(over.id) + 1,
            total: ids.length,
          })
        : undefined,
    onDragEnd: ({ active, over }) =>
      t("home.editor.dropped", {
        title: titleOf(active.id),
        position: (over ? at(over.id) : at(active.id)) + 1,
        total: ids.length,
      }),
    onDragCancel: ({ active }) =>
      t("home.editor.cancelled", { title: titleOf(active.id), position: at(active.id) + 1 }),
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    setDraft((d) => arrayMove(d, at(active.id), at(over.id)));
  };

  // --- tastiera: Spazio prende, frecce spostano, Spazio lascia, Esc annulla --
  const [picked, setPicked] = useState<{ key: string; from: number } | null>(null);
  const onHandleKey = (e: KeyboardEvent, index: number) => {
    const block = draft[index]!;
    const key = blockKey(block);
    const say = (k: string, position: number) =>
      setAnnouncement(t(k, { title: title(block), position, total: draft.length }));
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      if (picked?.key === key) {
        setPicked(null);
        say("home.editor.dropped", index + 1);
      } else {
        setPicked({ key, from: index });
        say("home.editor.picked", index + 1);
      }
      return;
    }
    if (picked?.key !== key) return;
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const to = index + (e.key === "ArrowUp" ? -1 : 1);
      if (to < 0 || to >= draft.length) return;
      setDraft((d) => arrayMove(d, index, to));
      say("home.editor.moved", to + 1);
      // La riga si è spostata: il fuoco la segue.
      requestAnimationFrame(() =>
        listRef.current?.querySelector<HTMLElement>(`[data-block-handle="${key}"]`)?.focus(),
      );
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setDraft((d) => arrayMove(d, index, picked.from));
      setPicked(null);
      say("home.editor.cancelled", picked.from + 1);
      requestAnimationFrame(() =>
        listRef.current?.querySelector<HTMLElement>(`[data-block-handle="${key}"]`)?.focus(),
      );
    }
  };

  return (
    <div className="edit-enter flex flex-col">
      <div className="flex flex-wrap items-center gap-2 border-t border-rule py-3">
        <p className="min-w-0 flex-1 text-sm text-ink-muted">
          {target.kind === "mine"
            ? t("home.editor.editingMine")
            : t("home.editor.editingDepartment", { name: target.name })}
        </p>
        {target.kind === "mine" && home.personal && (
          <button type="button" className={quietButton} onClick={() => setConfirmReset(true)}>
            {t("home.editor.reset")}
          </button>
        )}
        <button type="button" className={secondaryButton} onClick={onClose}>
          {t("home.editor.cancel")}
        </button>
        <button
          type="button"
          className={primaryButton}
          disabled={saving}
          onClick={() => void save()}
        >
          {t("home.editor.done")}
        </button>
      </div>
      <p id={instructionsId} className="sr-only">
        {t("home.editor.instructions")}
      </p>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={onDragEnd}
        accessibility={{ announcements }}
      >
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          <ul ref={listRef} aria-label={t("home.editor.list")} className="border-t border-rule">
            {draft.map((block, index) => (
              <EditorRow
                key={blockKey(block)}
                id={blockKey(block)}
                title={title(block)}
                fixed={isFixed(block)}
                picked={picked?.key === blockKey(block)}
                describedBy={instructionsId}
                onKeyDown={(e) => onHandleKey(e, index)}
                onBlur={() => {
                  if (picked?.key === blockKey(block)) setPicked(null);
                }}
                onHide={() => hide(index)}
              />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
      <div className="pt-3">
        <MenuButton
          label={t("home.editor.addBlock")}
          menuLabel={t("home.editor.addBlock")}
          className={secondaryButton}
        >
          {(close) => (
            <>
              {catalog.length === 0 && filterChoices.length === 0 && (
                <MenuNote>{t("home.editor.nothingToAdd")}</MenuNote>
              )}
              {catalog.length > 0 && (
                <MenuGroup label={t("home.editor.catalog")}>
                  {catalog.map((kind) => (
                    <button
                      key={kind}
                      type="button"
                      role="menuitem"
                      tabIndex={-1}
                      className={itemClass}
                      onClick={() => {
                        close();
                        add({ kind });
                      }}
                    >
                      {t(BLOCKS[kind].titleKey)}
                    </button>
                  ))}
                </MenuGroup>
              )}
              {filterChoices.length > 0 && (
                <MenuGroup label={t("home.editor.filters")}>
                  {filterChoices.map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      role="menuitem"
                      tabIndex={-1}
                      className={itemClass}
                      onClick={() => {
                        close();
                        add({ kind: "filter", filterId: f.id });
                      }}
                    >
                      <span className="min-w-0 truncate">{f.name}</span>
                    </button>
                  ))}
                </MenuGroup>
              )}
            </>
          )}
        </MenuButton>
      </div>
      {confirmReset && (
        <Dialog
          title={t("home.editor.resetTitle")}
          description={t("home.editor.resetBody")}
          onClose={() => setConfirmReset(false)}
          width={440}
          footer={
            <>
              <button
                type="button"
                className={secondaryButton}
                onClick={() => setConfirmReset(false)}
              >
                {t("home.editor.cancel")}
              </button>
              <button
                type="button"
                data-autofocus
                className={primaryButton}
                disabled={reset.isPending}
                onClick={() => void doReset()}
              >
                {t("home.editor.resetConfirm")}
              </button>
            </>
          }
        >
          {null}
        </Dialog>
      )}
    </div>
  );
}

function GripIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width={16}
      height={16}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      {[4, 8, 12].flatMap((y) =>
        [6, 10].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r={1.1} />),
      )}
    </svg>
  );
}

function LockIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width={14}
      height={14}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" strokeLinecap="round" />
    </svg>
  );
}

function EditorRow({
  id,
  title,
  fixed,
  picked,
  describedBy,
  onKeyDown,
  onBlur,
  onHide,
}: {
  id: string;
  title: string;
  fixed: boolean;
  picked: boolean;
  describedBy: string;
  onKeyDown: (e: KeyboardEvent) => void;
  onBlur: () => void;
  onHide: () => void;
}) {
  const { t } = useTranslation();
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({ id });
  return (
    <li
      ref={setNodeRef}
      data-editor-row={id}
      style={{
        transform: transform ? `translate3d(0, ${Math.round(transform.y)}px, 0)` : undefined,
        transition,
      }}
      className={`relative flex h-11 items-center gap-3 border-b border-rule bg-ground pr-3 pl-1 ${picked || isDragging ? "z-10 bg-surface shadow-[0_12px_32px_-8px_oklch(0_0_0/0.4)]" : ""}`}
    >
      <button
        type="button"
        data-block-handle={id}
        aria-label={t("home.editor.handle", { title })}
        aria-describedby={describedBy}
        aria-pressed={picked}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        {...listeners}
        className={`grid size-8 shrink-0 cursor-grab touch-none place-items-center rounded-md text-ink-faint transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink active:cursor-grabbing ${picked ? "bg-ink/10 text-ink" : ""}`}
      >
        <GripIcon />
      </button>
      <span className="min-w-0 flex-1 truncate text-lg font-semibold text-ink">{title}</span>
      {fixed ? (
        <span className="flex items-center gap-1.5 pr-2 text-sm text-ink-muted">
          <LockIcon />
          {t("home.editor.alwaysShown")}
        </span>
      ) : (
        <button
          type="button"
          aria-label={t("home.editor.hideLabel", { title })}
          className={ghostButton}
          onClick={onHide}
        >
          {t("home.editor.hide")}
        </button>
      )}
    </li>
  );
}
