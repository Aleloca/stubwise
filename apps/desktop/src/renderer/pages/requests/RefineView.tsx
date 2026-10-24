import { Link, useNavigate } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import {
  useCloseRefine,
  useConversationStream,
  usePatchRequestCache,
  usePeople,
  useProjects,
  useRefineOf,
  useRequest,
  useStartRefineConversation,
  useTasks,
} from "../../data/queries";
import type {
  ConversationEvent,
  ConversationRow,
  Project,
  ProjectRequest,
  RefinePatch,
} from "../../data/types";
import { can, useViewer } from "../../data/viewer";
import { DOCKED_PANEL_QUERY, DetailPanel } from "../../layout/useDetailPanel";
import { useMediaQuery } from "../../layout/useMediaQuery";
import { Dialog } from "../../tasks-ui/Dialog";
import { Markdown } from "../../tasks-ui/Markdown";
import { PageEmpty } from "../../tasks-ui/PageStates";
import { PersonChip } from "../../tasks-ui/PersonChip";
import { SizeMark } from "../../tasks-ui/SizeMark";
import { useToast } from "../../tasks-ui/Toast";
import { Conversation } from "../claude/conversation/Conversation";
import { WorkingRing } from "../claude/conversation/parts";
import { WorkResultSeeContext } from "../claude/conversation/WorkResultRow";
import { CloseIcon, dangerButton, ghostButton, Section } from "../task/parts";
import { primaryButton, quietButton, secondaryButton } from "../tasks/controls";
import { RequestStatusLabel, RiskMark, UrgencyMark } from "./marks";

/** Quanto resta «Updated by Claude · now» accanto a un campo appena scritto (ms). */
export const UPDATED_LABEL_MS = 6000;
/** Quante righe di design e piano si leggono prima di «Show all». */
const CLAMP_LINES = 8;

type Field = keyof RefinePatch;
/** La sezione del lato in cui sta un campo: «See» porta lì. */
type SideSection = "fields" | "design" | "plan";
const sectionOf = (field: Field): SideSection =>
  field === "design" ? "design" : field === "plan" ? "plan" : "fields";

/**
 * Il refine di una richiesta come conversazione (`?request=<id>&refine=1`
 * nelle Requests del progetto): a sinistra la conversazione con Claude, a
 * destra la richiesta stessa — urgenza, taglia, rischio, design, piano —
 * che cambia nello stesso istante in cui una riga del flusso dice che
 * Claude l'ha scritta. Da 1200 px il lato è agganciato; sotto si apre dal
 * bottone in testata, che dice «Updated» se nel frattempo è cambiato
 * qualcosa. Scrive, chiude e ne avvia uno nuovo chi ha `backlog.edit`; chi
 * non ce l'ha non vede la conversazione (regola di oggi), solo la richiesta.
 */
export function RefineView({ requestId, projectCode }: { requestId: string; projectCode: string }) {
  const { t } = useTranslation();
  const { viewer } = useViewer();
  const navigate = useNavigate();
  const toast = useToast();
  const requestQuery = useRequest(requestId);
  const request = requestQuery.data ?? null;
  const project = useProjects().data?.find((p) => p.id === request?.projectId);
  const refineQuery = useRefineOf(requestId);
  const refine = refineQuery.data ?? null;
  const docked = useMediaQuery(DOCKED_PANEL_QUERY);
  const [sideOpen, setSideOpen] = useState(false);
  const [unseen, setUnseen] = useState(false);
  const [closing, setClosing] = useState(false);
  const close = useCloseRefine();
  const start = useStartRefineConversation();
  const patchCache = usePatchRequestCache();

  const canEdit = request !== null && can(viewer, "backlog.edit", request.projectId);
  const live = refine !== null && refine.state !== "finished";

  // --- i campi appena scritti da Claude: l'etichetta resta qualche secondo,
  // la tinta sfuma in 2 s (rimontata a ogni scrittura) ---
  const [updated, setUpdated] = useState<Partial<Record<Field, number>>>({});
  const [flash, setFlash] = useState<{ section: SideSection; n: number } | null>(null);
  const timers = useRef(new Map<Field, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const all = timers.current;
    return () => {
      for (const timer of all.values()) clearTimeout(timer);
      all.clear();
    };
  }, []);
  const sideVisible = docked || sideOpen;
  const sideVisibleRef = useRef(sideVisible);
  sideVisibleRef.current = sideVisible;
  const onWrite = useCallback(
    (event: Extract<ConversationEvent, { type: "work_result" }>) => {
      const patch = event.requestPatch;
      if (!patch) return;
      patchCache(requestId, patch);
      const fields = Object.keys(patch) as Field[];
      setUpdated((map) => {
        const next = { ...map };
        for (const f of fields) next[f] = (map[f] ?? 0) + 1;
        return next;
      });
      for (const f of fields) {
        clearTimeout(timers.current.get(f));
        timers.current.set(
          f,
          setTimeout(() => {
            timers.current.delete(f);
            setUpdated((map) => {
              const next = { ...map };
              delete next[f];
              return next;
            });
          }, UPDATED_LABEL_MS),
        );
      }
      if (!sideVisibleRef.current) setUnseen(true);
    },
    [patchCache, requestId],
  );

  // --- «See»: apre il lato (se sta chiuso), lo scorre alla sezione e la segna ---
  const side = useRef<HTMLDivElement>(null);
  const [scrollTo, setScrollTo] = useState<{ section: SideSection; n: number } | null>(null);
  const see = useCallback((event: Extract<ConversationEvent, { type: "work_result" }>) => {
    const fields = Object.keys(event.requestPatch ?? {}) as Field[];
    const section: SideSection = fields.includes("design")
      ? "design"
      : fields.includes("plan")
        ? "plan"
        : "fields";
    setSideOpen(true);
    setUnseen(false);
    setScrollTo((s) => ({ section, n: (s?.n ?? 0) + 1 }));
  }, []);
  useLayoutEffect(() => {
    if (!scrollTo) return;
    const el = side.current?.querySelector(`[data-refine-section="${scrollTo.section}"]`);
    if (!(el instanceof HTMLElement)) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView?.({ block: "start", behavior: reduce ? "auto" : "smooth" });
    setFlash({ section: scrollTo.section, n: scrollTo.n });
  }, [scrollTo, sideVisible]);

  const back = () =>
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, refine: undefined }),
    } as never);
  const startNew = () =>
    start.mutate(requestId, { onError: () => toast.error(t("requests.refine.startFailed")) });
  const confirmClose = () => {
    if (!refine) return;
    close.mutate(refine.id, {
      onSuccess: () => {
        setClosing(false);
        toast.show(t("requests.refine.closed", { code: request?.code ?? "" }));
      },
      onError: () => {
        setClosing(false);
        toast.error(t("requests.refine.closeFailed"));
      },
    });
  };

  if (requestQuery.isPending) {
    return (
      <div aria-busy="true" className="skeleton-breathe flex flex-col gap-3 px-8 pt-8">
        <span role="status" className="sr-only">
          {t("taskUi.states.loading")}
        </span>
        <span className="h-3 w-20 rounded-sm bg-ink/8" />
        <span className="h-7 w-64 rounded-sm bg-ink/8" />
        <span className="h-3 w-80 rounded-sm bg-ink/8" />
      </div>
    );
  }
  if (!request || (project && project.code !== projectCode)) {
    return (
      <section className="flex flex-col">
        <BackRow onBack={back} />
        <PageEmpty title={t("requests.refine.notFound")} />
      </section>
    );
  }

  const sideNode = (onClose?: () => void) => (
    <RefineSide
      request={request}
      project={project}
      updated={updated}
      flash={flash}
      sideRef={side}
      onClose={onClose}
    />
  );

  let body: ReactNode;
  // Gli stati vuoti stanno sul bordo della testata (32 px), non su quello dei pannelli.
  if (!canEdit) {
    body = (
      <PageEmpty
        title={t("requests.refine.noAccess", { code: project?.code ?? projectCode })}
      />
    );
  } else if (refineQuery.isPending) {
    body = null;
  } else if (!refine) {
    body = (
      <PageEmpty
        title={t("requests.refine.noneTitle", { code: request.code })}
        body={t("requests.refine.noneBody")}
        action={
          <button
            type="button"
            className={primaryButton}
            disabled={start.isPending}
            onClick={startNew}
          >
            {t("requests.refine.start")}
          </button>
        }
      />
    );
  } else {
    body = (
      <WorkResultSeeContext.Provider value={see}>
        <LiveWrites key={refine.id} conversationId={refine.id} onWrite={onWrite} />
        <Conversation id={refine.id} />
      </WorkResultSeeContext.Provider>
    );
  }

  return (
    <section data-refine-view={request.id} className="flex h-full min-h-0">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <RefineHeader
          request={request}
          refine={refine}
          actions={
            <>
              {!docked && (
                <button
                  type="button"
                  aria-expanded={sideOpen}
                  className={secondaryButton}
                  onClick={() => {
                    setSideOpen((o) => !o);
                    setUnseen(false);
                  }}
                >
                  {t("requests.refine.sideToggle", { code: request.code })}
                  {unseen && (
                    <span className="flex items-center gap-1 text-xs font-semibold text-ink">
                      <span aria-hidden="true" className="size-1.5 rounded-full bg-ink" />
                      {t("requests.refine.sideUpdated")}
                    </span>
                  )}
                </button>
              )}
              {canEdit && live && (
                <button type="button" className={secondaryButton} onClick={() => setClosing(true)}>
                  {t("requests.refine.close")}
                </button>
              )}
              {canEdit && refine && !live && request.status !== "converted" && request.status !== "archived" && (
                <button
                  type="button"
                  className={secondaryButton}
                  disabled={start.isPending}
                  onClick={startNew}
                >
                  {t("requests.refine.startNew")}
                </button>
              )}
            </>
          }
          onBack={back}
        />
        <div
          className={`edit-enter relative min-h-0 flex-1 ${refine && canEdit ? "" : "px-4"}`}
        >
          {body}
        </div>
      </div>
      {docked ? (
        // Agganciato il lato non si chiude: si esce dal refine con «← Requests».
        <DetailPanel
          mode="docked"
          label={t("requests.refine.side.label", { code: request.code })}
          onClose={noop}
        >
          {sideNode()}
        </DetailPanel>
      ) : (
        sideOpen && (
          <DetailPanel
            mode="overlay"
            label={t("requests.refine.side.label", { code: request.code })}
            onClose={() => setSideOpen(false)}
          >
            {sideNode(() => setSideOpen(false))}
          </DetailPanel>
        )
      )}
      {closing && (
        <Dialog
          title={t("requests.refine.closeTitle")}
          width={480}
          onClose={() => setClosing(false)}
          footer={
            <>
              <button
                type="button"
                data-autofocus
                className={secondaryButton}
                onClick={() => setClosing(false)}
              >
                {t("requests.refine.cancel")}
              </button>
              <button
                type="button"
                className={`${dangerButton} h-8 px-3 disabled:opacity-40`}
                disabled={close.isPending}
                onClick={confirmClose}
              >
                {t("requests.refine.closeConfirm")}
              </button>
            </>
          }
        >
          <p className="text-md text-ink-muted">{t("requests.refine.closeBody")}</p>
        </Dialog>
      )}
    </section>
  );
}

const noop = () => {};

function BackRow({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation();
  return (
    <button type="button" onClick={onBack} className={`${quietButton} -ml-2.5 self-start`}>
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        className="size-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M13 8H3m4-4L3 8l4 4" />
      </svg>
      {t("requests.refine.back")}
    </button>
  );
}

/**
 * La testata: «← Requests», l'h1 «Refine STW-R4», il titolo della richiesta,
 * poi la riga meta (chi l'ha avviata, cosa sta succedendo) con le azioni.
 */
function RefineHeader({
  request,
  refine,
  actions,
  onBack,
}: {
  request: ProjectRequest;
  refine: ConversationRow | null;
  actions: ReactNode;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const owner = usePeople().data?.find((p) => p.id === refine?.ownerId)?.name ?? "";
  let state: ReactNode = null;
  if (refine?.state === "working") {
    state = (
      <span className="flex items-center gap-1.5">
        <WorkingRing />
        {t("requests.refine.state.working")}
      </span>
    );
  } else if (refine?.state === "finished") {
    state =
      request.status === "converted" || request.status === "archived"
        ? t("requests.refine.state.itemClosed")
        : t("requests.refine.state.closed");
  } else if (refine) {
    state = t("requests.refine.state.waiting");
  }
  return (
    <header className="page-header flex shrink-0 flex-col gap-1 border-b border-rule pb-3 pl-8 [--page-header-pr:32px] [--page-header-pt:20px]">
      <BackRow onBack={onBack} />
      <h1 className="num mt-1 truncate text-2xl font-semibold text-ink">
        {t("requests.refine.title", { code: request.code })}
      </h1>
      <p
        title={request.title}
        className="truncate text-lg font-semibold text-ink-muted"
      >
        {request.title}
      </p>
      <div className="mt-1 flex min-h-8 flex-wrap items-center gap-x-3 gap-y-2">
        {refine && (
          <p className="flex min-w-0 flex-wrap items-center gap-x-2 text-sm text-ink-muted">
            <span>{t("requests.refine.startedBy", { name: owner })}</span>
            {state && (
              <>
                <span aria-hidden="true" className="text-ink-faint">
                  ·
                </span>
                <span className="text-ink">{state}</span>
              </>
            )}
          </p>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>
      </div>
    </header>
  );
}

/**
 * Legge dal vivo le righe del refine (iscrizione passiva: la conversazione
 * accanto è già iscritta e fa partire lo script) e passa al lato quelle
 * nuove che scrivono la richiesta. Quelle già nel flusso all'apertura non
 * contano: sono già nella richiesta letta.
 */
function LiveWrites({
  conversationId,
  onWrite,
}: {
  conversationId: string;
  onWrite: (event: Extract<ConversationEvent, { type: "work_result" }>) => void;
}) {
  const { events } = useConversationStream(conversationId, { passive: true });
  const known = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (events.length === 0) return;
    if (known.current === null) {
      known.current = new Set(events.map((e) => e.id));
      return;
    }
    for (const e of events) {
      if (known.current.has(e.id)) continue;
      known.current.add(e.id);
      if (e.type === "work_result" && e.requestPatch) onWrite(e);
    }
  }, [events, onWrite]);
  return null;
}

/**
 * Il lato del refine: la richiesta in variante «refine». Testata (codice,
 * titolo, stato), Urgency · Size · Risk, poi DESIGN e PLAN (chiusi a 8
 * righe) e chi l'ha chiesta. Il piano scritto qui non è approvato, e lo
 * dice sempre. Si legge e basta: Claude scrive, le persone parlano con lui
 * (i metadati a mano restano nel pannello normale della richiesta).
 */
function RefineSide({
  request,
  project,
  updated,
  flash,
  sideRef,
  onClose,
}: {
  request: ProjectRequest;
  project: Project | undefined;
  updated: Partial<Record<Field, number>>;
  flash: { section: SideSection; n: number } | null;
  sideRef: RefObject<HTMLDivElement | null>;
  onClose?: (() => void) | undefined;
}) {
  const { t } = useTranslation();
  const tasks = useTasks({ projectIds: [request.projectId] }).data;
  const born = tasks?.filter((x) => request.taskIds.includes(x.id)) ?? [];
  const f = (key: string) => t(`requests.detail.fields.${key}`);
  /** Il segno di Claude accanto a un campo appena scritto, e la tinta che sfuma. */
  const touch = (field: Field) => {
    const n = updated[field];
    const flashing = flash !== null && flash.section === sectionOf(field);
    const key = `${field}:${n ?? 0}:${flashing ? flash.n : 0}`;
    return {
      key,
      className: n !== undefined || flashing ? "claude-touch" : "",
      /** Cambia a ogni scrittura di Claude o «See»; `null` quando non c'è niente da mostrare. */
      reveal: n !== undefined || flashing ? key : null,
      label:
        n !== undefined ? (
          <span className="shrink-0 text-xs text-ink-muted">{t("requests.refine.side.updated")}</span>
        ) : null,
    };
  };
  const row = (field: Field, label: string, value: ReactNode) => {
    const { key, className, label: mark } = touch(field);
    return (
      <div key={key} data-refine-field={field} className={`contents`}>
        <dt className="flex h-8 items-center text-sm text-ink-muted">{label}</dt>
        <dd
          className={`-mx-1.5 flex min-h-8 min-w-0 flex-wrap items-center gap-x-2 rounded-md px-1.5 ${className}`}
        >
          {value}
          {mark}
        </dd>
      </div>
    );
  };
  const design = touch("design");
  const plan = touch("plan");

  return (
    <div ref={sideRef} className="flex flex-col pb-6">
      <div className="page-header box-content flex h-12 shrink-0 items-center gap-2 pl-4 [--page-header-pr:8px]">
        <span className="num shrink-0 text-xs font-semibold tracking-[0.02em] text-ink-muted">
          {request.code}
        </span>
        {project && (
          <span className="min-w-0 truncate text-xs text-ink-faint" title={project.name}>
            {project.name}
          </span>
        )}
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label={t("requests.refine.side.close")}
            title={t("requests.refine.side.close")}
            className={`${ghostButton} ml-auto w-8 justify-center px-0`}
          >
            <CloseIcon />
          </button>
        )}
      </div>
      <div className="flex flex-col gap-1.5 px-4 pt-1 pb-3">
        <h2 className="text-xl font-semibold text-balance text-ink [overflow-wrap:anywhere]">
          {request.title}
        </h2>
        <span className="text-sm text-ink">
          <RequestStatusLabel status={request.status} />
        </span>
        {born.map((task) => (
          <Link
            key={task.id}
            to="."
            search={((prev: Record<string, unknown>) => ({
              ...prev,
              refine: undefined,
              request: undefined,
              task: task.code,
            })) as never}
            className="self-start text-sm font-medium text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink"
          >
            {t("requests.refine.side.task", { code: task.code })}
          </Link>
        ))}
      </div>
      <dl
        data-refine-section="fields"
        className="grid scroll-mt-2 grid-cols-[88px_minmax(0,1fr)] gap-x-3 px-4 pb-3"
      >
        {row("urgency", f("urgency"), <UrgencyMark urgency={request.urgency} />)}
        {row("size", f("size"), <SizeMark size={request.size ?? null} />)}
        {row("risk", f("risk"), <RiskMark risk={request.risk} />)}
        {request.riskNote &&
          row(
            "riskNote",
            f("riskNote"),
            <span className="py-1.5 text-sm text-ink [overflow-wrap:anywhere]">{request.riskNote}</span>,
          )}
      </dl>
      <div data-refine-section="design" className="scroll-mt-2">
        <Section
          title={t("requests.refine.side.design")}
          empty={request.design?.trim() ? undefined : t("requests.refine.side.noDesign")}
        >
          {design.label}
          {request.design?.trim() && (
            <Touched touch={design}>
              <Clamped source={request.design} reveal={design.reveal} />
            </Touched>
          )}
        </Section>
      </div>
      <div data-refine-section="plan" className="scroll-mt-2">
        <Section
          title={t("requests.refine.side.plan")}
          empty={request.plan?.trim() ? undefined : t("requests.refine.side.noPlan")}
          action={
            // Il piano scritto nel refine non passa dal gate: non è approvato.
            request.plan?.trim() ? (
              <span data-plan-approval="none" className="text-xs text-ink-muted">
                {t("requests.refine.side.notApproved")}
              </span>
            ) : undefined
          }
        >
          {plan.label}
          {request.plan?.trim() && (
            <Touched touch={plan}>
              <Clamped source={request.plan} reveal={plan.reveal} />
            </Touched>
          )}
        </Section>
      </div>
      <Section title={t("requests.detail.requesters")} count={request.requesterIds.length}>
        <ul className="flex flex-col gap-1">
          {request.requesterIds.map((id) => (
            <li key={id} className="flex min-h-7 items-center">
              <PersonChip personId={id} />
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

/**
 * Il testo di una sezione con la tinta di Claude dietro: la tinta (un
 * livello a sé, rimontato a ogni scrittura) riparte senza rimontare il
 * testo, che tiene aperto o chiuso com'era.
 */
function Touched({
  touch,
  children,
}: {
  touch: { key: string; className: string };
  children: ReactNode;
}) {
  return (
    <div className="relative -mx-1.5 rounded-md px-1.5">
      {touch.className && (
        <span
          key={touch.key}
          aria-hidden="true"
          className={`pointer-events-none absolute inset-0 rounded-md ${touch.className}`}
        />
      )}
      <div className="relative">{children}</div>
    </div>
  );
}

/**
 * Design e piano: chiusi a 8 righe (l'ultima sfuma), con «Show all» solo se
 * c'è altro da leggere. Quando Claude li scrive o «See» li indica
 * (`reveal` cambia) si aprono: ciò che è cambiato non resta sotto il taglio.
 */
function Clamped({ source, reveal }: { source: string; reveal: string | null }) {
  const { t } = useTranslation();
  const box = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    if (reveal !== null) setOpen(true);
  }, [reveal]);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || open) return;
    setOverflows(el.scrollHeight > el.clientHeight + 1);
  }, [source, open]);
  return (
    <div className="flex flex-col items-start gap-1">
      <div
        ref={box}
        className={`w-full overflow-hidden text-md ${!open && overflows ? "[mask-image:linear-gradient(to_bottom,black_75%,transparent)]" : ""}`}
        style={open ? undefined : { maxHeight: `${CLAMP_LINES * 20}px` }}
      >
        <Markdown source={source} />
      </div>
      {(overflows || open) && (
        <button type="button" className={ghostButton + " -ml-2"} onClick={() => setOpen((o) => !o)}>
          {open ? t("requests.refine.side.showLess") : t("requests.refine.side.showAll")}
        </button>
      )}
    </div>
  );
}
