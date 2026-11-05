import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import {
  useContextIdOf,
  useConversation,
  useDescribeContext,
  useProjects,
  useSessionPersonId,
  useTasks,
} from "../../data/queries";
import { onStoreReset } from "../../data/store";
import type { ContextRef } from "../../data/types";
import { NewConversationComposer } from "../../pages/claude/ClaudePage";
import { keepUnsent, type ComposerDraft } from "../../pages/claude/conversation/Composer";
import { Conversation } from "../../pages/claude/conversation/Conversation";
import { usePersonName } from "../../pages/claude/conversation/parts";
import { shortcutLabel } from "../../platform/platform";
import { useMediaQuery } from "../useMediaQuery";
import { ContextChip, contextShort } from "./ContextChip";
import { usePageEventRunner, type TrialOpening } from "./pageActions";
import { pageContextOf, pageObjectOf } from "./pageContext";
import {
  CLAUDE_PANEL_EVENT,
  CLAUDE_PANEL_ID,
  setClaudeBeside,
  setClaudePanelStatus,
  type ClaudePanelEventDetail,
} from "./panelEvents";

// Il riquadro di Claude (area 10a, Task 8, shape claude-panel.md): la
// conversazione libera dell'area 3, da ogni pagina. Una colonna agganciata a
// destra che COPRE l'area di lavoro senza stringerla, a sinistra del
// pannello della task se è aperto [CP 10]; senza ombra, col filetto
// `rule-strong` [CP 1]. Sta a `z-40` come il pannello sovrapposto e la
// palette: decide l'ordine del layout (il pannello della task prima, la
// palette e le notifiche dopo). Montato una volta dal layout e mai smontato: chiuso è
// `hidden` e `inert`, così conversazione, scorrimento e testo non inviato
// restano. Ha chiave per persona: col «vedi come» rinasce con le
// conversazioni dell'altra, senza niente della prima.

/** Larghezza: 400 da 1440 px in su, 360 sotto [CP 2]. */
const WIDE_QUERY = "(min-width: 1440px)";
/** Quanto resta la riga «Now showing …» dopo il cambio di persona [CP 13]. */
export const PERSONA_NOTICE_MS = 4000;

/** L'ultima conversazione del riquadro, per persona, in memoria: un reset del prototipo la dimentica. */
const lastConversation = new Map<string, string>();
onStoreReset(() => lastConversation.clear());

/**
 * La CASELLA del riquadro (`data-claude-box`), non la prima textarea: nel
 * flusso ce ne sono altre prima («Other…» di una domanda, il rifiuto di un
 * piano). Un solo punto per i quattro posti che ci mettono il fuoco o la
 * leggono (review finale, 2).
 */
const claudeBoxIn = (root: HTMLElement | null | undefined) =>
  root?.querySelector<HTMLTextAreaElement>("textarea[data-claude-box]") ?? null;
const focusClaudeBox = (root: HTMLElement | null | undefined) => claudeBoxIn(root)?.focus();

/**
 * Dove sta il riquadro: `right` è la larghezza del pannello di dettaglio
 * aperto (la task, una richiesta…), affiancato o sovrapposto, che sta al
 * bordo destro — il riquadro subito alla sua sinistra; `room` è lo spazio
 * fra il pannello e l'inizio dell'area di lavoro. A 1024 col pannello della
 * task sovrapposto (400) il riquadro si stringe lì, così binario e colonna
 * restano a vista (shape §4).
 */
function useDockGeometry(): { right: number; room: number } {
  const [geometry, setGeometry] = useState({ right: 0, room: Number.POSITIVE_INFINITY });
  useEffect(() => {
    let frame = 0;
    let watched: Element[] = [];
    const resize =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => schedule());
    function measure() {
      frame = 0;
      // Il pannello di dettaglio e, a 1024, la colonna dei commenti o della
      // cronologia di una pagina di prodotto, sovrapposta (area 11a, [PE 22]):
      // il riquadro sta a sinistra della più larga delle due.
      const els = [...document.querySelectorAll('[data-detail-panel], [data-product-side="overlay"]')];
      if (els.length !== watched.length || els.some((el, i) => el !== watched[i])) {
        for (const el of watched) resize?.unobserve(el);
        for (const el of els) resize?.observe(el);
        watched = els;
      }
      const right = Math.max(0, ...els.map((el) => Math.round(el.getBoundingClientRect().width)));
      const workLeft =
        document.querySelector('[data-zone="work-row"]')?.getBoundingClientRect().left ?? 0;
      const room = window.innerWidth > 0 ? window.innerWidth - right - workLeft : Infinity;
      setGeometry((g) => (g.right === right && g.room === room ? g : { right, room }));
    }
    function schedule() {
      if (frame === 0) frame = requestAnimationFrame(measure);
    }
    const mutations = new MutationObserver(schedule);
    mutations.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", schedule);
    measure();
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      mutations.disconnect();
      window.removeEventListener("resize", schedule);
      resize?.disconnect();
    };
  }, []);
  return geometry;
}

/** Un testo per la casella (⌘K, la riga «Claude can help you…»); `fresh` = in una conversazione nuova. */
type IncomingDraft = ComposerDraft & { fresh: boolean };

/** Sotto questa larghezza il riquadro non si stringe più (copre la colonna, piuttosto). */
const MIN_WIDTH = 300;

/** L'host del layout: apre, chiude, tiene il fuoco e dice al binario come sta. */
export function ClaudePanelHost() {
  const me = useSessionPersonId();
  const [open, setOpen] = useState(false);
  const [incoming, setIncoming] = useState<IncomingDraft | undefined>(undefined);
  const [working, setWorking] = useState(false);
  const [unseen, setUnseen] = useState(false);
  // D2: la pagina aperta dal riquadro c'è ancora («Back to …»): le sta accanto.
  const [landed, setLanded] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const wide = useMediaQuery(WIDE_QUERY);
  const { right, room } = useDockGeometry();
  const width = Math.max(MIN_WIDTH, Math.min(wide ? 400 : 360, room));
  // Il contenuto nasce alla prima apertura, poi resta: prima non legge niente
  // (la pagina sotto non divide con lui letture né errori iniettati).
  const [born, setBorn] = useState(false);
  if (open && !born) setBorn(true);
  // Il testo da ⌘K si prende una volta sola, anche se il contenuto rinasce.
  const taken = useRef(0);
  const takeIncoming = useCallback((): IncomingDraft | null => {
    if (!incoming || incoming.nonce === taken.current) return null;
    taken.current = incoming.nonce;
    return incoming;
  }, [incoming]);

  // Il «vedi come» appena cambiato: il riquadro rinasce e lo dice [CP 13].
  const previousPerson = useRef(me);
  const switched = previousPerson.current !== me;
  useEffect(() => {
    previousPerson.current = me;
  }, [me]);

  useEffect(() => {
    function onEvent(e: Event) {
      const detail = (e as CustomEvent<ClaudePanelEventDetail>).detail ?? {};
      if (detail.draft !== undefined || detail.fresh) {
        const text = detail.draft ?? "";
        const fresh = detail.fresh === true;
        setIncoming((d) => ({ text, nonce: (d?.nonce ?? 0) + 1, fresh }));
      }
      setOpen((was) => (detail.mode === "toggle" ? !was : true));
    }
    window.addEventListener(CLAUDE_PANEL_EVENT, onEvent);
    return () => window.removeEventListener(CLAUDE_PANEL_EVENT, onEvent);
  }, []);

  const close = useCallback(() => setOpen(false), []);

  // Il fuoco: all'apertura nella casella, alla chiusura a chi l'ha aperto (il
  // bottone del binario, o ciò che aveva il fuoco prima di ⌘J). Si legge al
  // fotogramma dopo l'apertura: dalla palette il fuoco è già tornato dov'era.
  const wasOpen = useRef(false);
  useLayoutEffect(() => {
    const root = panel.current;
    if (open && !wasOpen.current) {
      const frame = requestAnimationFrame(() => {
        const active = document.activeElement;
        if (active instanceof HTMLElement && active !== document.body && !root?.contains(active)) {
          opener.current = active;
        }
        if (!root?.contains(document.activeElement)) {
          focusClaudeBox(root);
        }
      });
      wasOpen.current = true;
      return () => cancelAnimationFrame(frame);
    }
    if (!open && wasOpen.current) {
      wasOpen.current = false;
      const active = document.activeElement;
      const lost = !active || active === document.body || (root?.contains(active) ?? false);
      if (lost) {
        const back = opener.current?.isConnected
          ? opener.current
          : document.querySelector<HTMLElement>("[data-claude-rail]");
        back?.focus();
      }
      opener.current = null;
    }
    return undefined;
  }, [open]);

  // Il segno del binario: pulsa mentre Claude risponde a riquadro chiuso, poi
  // il punto «ti aspetta» finché non si riapre [CP 6].
  const wasWorking = useRef(false);
  useEffect(() => {
    if (open) setUnseen(false);
    else if (wasWorking.current && !working) setUnseen(true);
    wasWorking.current = working;
  }, [open, working]);
  useEffect(() => {
    setClaudePanelStatus({
      open,
      signal: open ? null : working ? "answering" : unseen ? "answered" : null,
    });
  }, [open, working, unseen]);
  useEffect(() => () => setClaudePanelStatus({ open: false, signal: null }), []);
  useEffect(() => setClaudeBeside(open && landed ? width : 0), [open, landed, width]);
  useEffect(() => () => setClaudeBeside(0), []);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    // Esc chiude: prima i menu «#», «@», «/» della casella (lo prendono loro).
    if (e.key !== "Escape" || e.shiftKey || e.defaultPrevented) return;
    e.preventDefault();
    close();
  };

  const { t } = useTranslation();
  return (
    <aside
      ref={panel}
      id={CLAUDE_PANEL_ID}
      role="complementary"
      aria-label={t("claude.panel.label")}
      hidden={!open}
      inert={!open}
      data-claude-panel={open ? "open" : "closed"}
      onKeyDown={onKeyDown}
      style={{ width, right }}
      className="panel-enter fixed inset-y-0 z-40 flex max-w-[100vw] min-w-0 flex-col border-l border-rule-strong bg-surface text-ink"
    >
      {born && (
        <PanelBody
          key={me}
          open={open}
          takeIncoming={takeIncoming}
          // Solo se il riquadro era aperto: chiuso, non c'è niente da dire a chi lo riapre.
          announce={switched && open}
          onClose={close}
          onWorking={setWorking}
          onLanded={setLanded}
        />
      )}
    </aside>
  );
}

function PanelBody({
  open,
  takeIncoming,
  announce,
  onClose,
  onWorking,
  onLanded,
}: {
  open: boolean;
  /** Il testo da ⌘K non ancora preso, una volta sola. */
  takeIncoming: () => IncomingDraft | null;
  announce: boolean;
  onClose: () => void;
  onWorking: (working: boolean) => void;
  /** D2: la pagina aperta dal riquadro è arrivata e «Back to» c'è ancora. */
  onLanded: (landed: boolean) => void;
}) {
  const { t } = useTranslation();
  const me = useSessionPersonId();
  const navigate = useNavigate();
  const [conversationId, setConversationId] = useState<string | null>(
    () => lastConversation.get(me) ?? null,
  );
  const [archivedNotice, setArchivedNotice] = useState(false);
  const [draft, setDraft] = useState<ComposerDraft | undefined>(undefined);
  const nonce = useRef(0);
  const put = (text: string) => setDraft({ text, nonce: (nonce.current += 1) });

  // Il testo da ⌘K, anche quello che ha fatto nascere il contenuto. Dalla riga
  // «Claude can help you…» (`fresh`) in una conversazione nuova: il testo non
  // inviato di quella di prima resta suo, e la ritrova chi la riapre ([SG 6]).
  // Si legge la CASELLA (`data-claude-box`), non la prima textarea: nel flusso
  // ce ne sono altre prima («Other…» di una domanda, il rifiuto di un piano).
  // Limite accettato: il testo di una conversazione nuova non ancora inviata
  // lascia il posto alla richiesta (lo shape protegge solo quella di prima).
  useEffect(() => {
    const incoming = takeIncoming();
    if (!incoming) return;
    if (incoming.fresh) {
      if (conversationId) {
        const box = claudeBoxIn(document.getElementById(CLAUDE_PANEL_ID));
        if (box?.value.trim()) keepUnsent(me, conversationId, box.value);
      }
      startNew();
      // La richiesta parla della pagina: il chip torna, anche se era stato tolto.
      context.setRemoved(false);
    }
    put(incoming.text);
    // Solo a ogni testo nuovo: la conversazione di adesso si legge a quel momento.
  }, [takeIncoming]);

  // «Now showing Sara Montanari's conversations.» per 4 s, finché non si scrive.
  const [notice, setNotice] = useState(announce);
  const name = usePersonName(me);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(false), PERSONA_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  // La conversazione: l'ultima della persona, finché non si preme New.
  const detailQuery = useConversation(conversationId ?? "");
  const detail = conversationId ? detailQuery.data : undefined;
  const context = usePageContext(open);
  // Area 10b (D2): finita la prova, il costruttore si apre da sé; il riquadro
  // resta aperto e in cima dice «Back to <pagina>» (shape claude-automations §3.5).
  const [back, setBack] = useState<BackTo | null>(null);
  const [announced, setAnnounced] = useState("");
  const contextRef = useRef(context);
  contextRef.current = context;
  const onTrial = useCallback(
    (opening: TrialOpening) => {
      const d = contextRef.current.description;
      setBack({
        from: opening.from,
        label: d ? contextShort(d, t) : null,
        target: `/automations/${opening.code}/${opening.simId ? "test" : "edit"}`,
        arrived: false,
      });
      setAnnounced(
        opening.simId
          ? t("claude.panel.openedTest", { code: opening.code })
          : t("claude.panel.openedBuilder", { code: opening.code }),
      );
    },
    [t],
  );
  // Area 10b (Task 9): le azioni della pagina della conversazione, eseguite qui (P22).
  usePageEventRunner(conversationId, { onTrial });
  const working = detail?.state === "working";
  useEffect(() => {
    onWorking(working);
  }, [working, onWorking]);
  useEffect(() => {
    if (!conversationId || detailQuery.isPending || detailQuery.isError) return;
    const gone = detailQuery.data === null;
    const archived = detailQuery.data?.archived === true;
    if (!gone && !archived) return;
    // Archiviata o eliminata dalla destinazione: il compositore vuoto (la
    // frase solo per l'archiviata).
    lastConversation.delete(me);
    setConversationId(null);
    setDraft(undefined);
    setArchivedNotice(archived);
  }, [conversationId, detailQuery.isPending, detailQuery.isError, detailQuery.data, me]);

  // Cambiando conversazione (nata dal primo invio, o «New») la casella di
  // prima sparisce: il fuoco va in quella nuova appena c'è, mai sul body.
  const refocus = useRef(false);
  useEffect(() => {
    const root = document.getElementById(CLAUDE_PANEL_ID);
    if (!refocus.current || !root) return;
    const focusBox = () => {
      const field = claudeBoxIn(root);
      if (!field) return false;
      refocus.current = false;
      field.focus();
      return true;
    };
    if (focusBox()) return;
    const watch = new MutationObserver(() => {
      if (focusBox()) watch.disconnect();
    });
    watch.observe(root, { childList: true, subtree: true });
    return () => watch.disconnect();
  }, [conversationId]);

  // «Back to» sparisce al primo cambio di pagina fatto dalla persona ([AU 7]).
  const pathname = useRouterState({ select: (st) => st.location.pathname });
  useEffect(() => {
    if (!back) return;
    if (pathname === back.target) {
      if (!back.arrived) setBack({ ...back, arrived: true });
    } else if (back.arrived) setBack(null);
  }, [pathname, back]);
  const landed = back?.arrived === true;
  useEffect(() => onLanded(landed), [landed, onLanded]);
  useEffect(() => () => onLanded(false), [onLanded]);
  const goBack = () => {
    if (!back) return;
    const root = document.getElementById(CLAUDE_PANEL_ID);
    setBack(null);
    void navigate({ href: back.from } as never);
    // La riga sparisce col fuoco sopra: torna nella casella, mai sul body.
    requestAnimationFrame(() => focusClaudeBox(root));
  };

  const startNew = () => {
    setBack(null);
    lastConversation.delete(me);
    refocus.current = true;
    setConversationId(null);
    setDraft(undefined);
    setArchivedNotice(false);
  };
  const created = (id: string) => {
    lastConversation.set(me, id);
    refocus.current = true;
    setDraft(undefined);
    setArchivedNotice(false);
    setConversationId(id);
  };

  const title = conversationId
    ? detail?.title || t("claude.panel.newConversation")
    : t("claude.panel.newConversation");
  const openDisabledId = useId();

  return (
    <>
      <header className="page-header flex h-12 shrink-0 items-center gap-1 pl-4 [--page-header-pr:8px]">
        <h2 className="min-w-0 flex-1 truncate text-md font-semibold text-ink" title={title}>
          {title}
        </h2>
        <HeaderButton label={t("claude.panel.new")} onClick={startNew}>
          <path d="M8 3v10M3 8h10" />
        </HeaderButton>
        <HeaderButton
          label={t("claude.panel.openInClaude")}
          disabledReason={conversationId ? null : t("claude.panel.openDisabled")}
          disabledId={openDisabledId}
          onClick={() => {
            if (!conversationId) return;
            onClose();
            void navigate({ to: "/claude/$id", params: { id: conversationId } });
          }}
        >
          <path d="M6 3.5H3.5v9h9V10M9 3h4v4M13 3 7.5 8.5" />
        </HeaderButton>
        <HeaderButton
          label={t("claude.panel.close")}
          title={t("claude.panel.closeShortcut", { shortcut: shortcutLabel(["mod", "J"]) })}
          shortcut="Meta+J Control+J"
          onClick={onClose}
        >
          <path d="M4 4l8 8M12 4l-8 8" />
        </HeaderButton>
      </header>
      {back && <BackRow back={back} onBack={goBack} />}
      <ContextRow context={context} />
      <p role="status" aria-live="polite" className="sr-only" data-panel-announce>
        {announced}
      </p>
      {notice && (
        <p role="status" className="shrink-0 px-4 pt-3 text-sm text-ink-muted">
          {t("claude.panel.nowShowing", { name })}
        </p>
      )}
      <div className="flex min-h-0 flex-1 flex-col">
        {conversationId ? (
          <Conversation id={conversationId} draft={draft} context={context.sent} inPanel />
        ) : (
          <>
            <EmptyConversation
              archived={archivedNotice}
              context={context}
              onTry={(text) => {
                put(text);
                setNotice(false);
              }}
            />
            <NewConversationComposer
              variant="panel"
              draft={draft}
              context={context.sent}
              contextProjectId={context.sent ? (context.description?.projectId ?? null) : null}
              onCreated={created}
              onText={(text) => {
                if (text) setNotice(false);
              }}
            />
          </>
        )}
      </div>
    </>
  );
}

/** D2: dove torna «Back to …» (l'indirizzo lasciato) e con quale etichetta (il chip di allora). */
export interface BackTo {
  from: string;
  label: string | null;
  /** La pagina del costruttore aperta dal riquadro. */
  target: string;
  /** Il costruttore è stato raggiunto: da qui un cambio di pagina toglie la riga. */
  arrived: boolean;
}

/** «← Back to ACQ · Support», sopra il chip: torna all'indirizzo di prima ([AU 7]). */
export function BackRow({ back, onBack }: { back: BackTo; onBack: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="event-enter flex h-8 shrink-0 items-center px-4 text-sm">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex min-w-0 items-center gap-1.5 rounded-md text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:text-ink"
      >
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
          className="shrink-0"
        >
          <path d="M13 8H3.5M7.5 4 3.5 8l4 4" />
        </svg>
        <span className="min-w-0 truncate">
          {back.label
            ? t("claude.panel.back", { label: back.label })
            : // Senza il chip di allora c'è comunque la strada indietro (m11).
              t("claude.panel.backPlain")}
        </span>
      </button>
    </div>
  );
}

/** Il contesto della pagina di adesso, riletto quando il riquadro si apre. */
interface PageContext {
  ref: ContextRef | null;
  description: ReturnType<typeof useDescribeContext>["data"];
  /** Tolto con la × per i messaggi successivi; torna cambiando pagina [CP 3]. */
  removed: boolean;
  setRemoved: (removed: boolean) => void;
  /** Ciò che parte col messaggio: il chip mostrato, o niente. */
  sent: ContextRef | null;
}

function usePageContext(open: boolean): PageContext {
  const location = useRouterState({ select: (s) => s.location });
  const pathname = location.pathname;
  const search = location.search as Record<string, unknown>;
  const projects = useProjects().data;
  const object = pageObjectOf({ pathname, search });
  const objectQuery = useContextIdOf(object);
  const objectId = objectQuery.data ?? null;
  const ref = pageContextOf(
    { pathname, search },
    {
      projectIdOf: (code) => projects?.find((p) => p.code === code)?.id ?? null,
      objectIdOf: (kind, code) =>
        object && object.kind === kind && object.code === code ? objectId : null,
    },
  );
  const describe = useDescribeContext(ref);
  const [removed, setRemoved] = useState(false);
  const where = `${pathname}?${JSON.stringify(search)}`;
  useEffect(() => setRemoved(false), [where]);
  // Il chip si rilegge all'apertura: un oggetto diventato invisibile sparisce.
  const { refetch: refetchObject } = objectQuery;
  const { refetch: refetchDescribe } = describe;
  useEffect(() => {
    if (!open) return;
    if (object) void refetchObject();
    if (ref) void refetchDescribe();
    // Solo all'apertura.
  }, [open]);
  const description = ref ? describe.data : null;
  return {
    ref,
    description,
    removed,
    setRemoved,
    sent: !removed && description ? ref : null,
  };
}

/** «You're looking at: [ACQ-14 · task ×]», o «Not using this page · Use it». Niente per un oggetto che non si vede. */
function ContextRow({ context }: { context: PageContext }) {
  const { t } = useTranslation();
  const d = context.description;
  if (!d) return null;
  return (
    <div
      key={JSON.stringify(context.ref)}
      className="event-enter flex h-9 shrink-0 items-center gap-2 border-b border-rule px-4 text-sm"
    >
      {context.removed ? (
        <p className="min-w-0 truncate text-ink-faint">
          {t("claude.panel.notUsing")}
          <span aria-hidden="true"> · </span>
          <button
            type="button"
            onClick={() => context.setRemoved(false)}
            className="font-medium text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink"
          >
            {t("claude.panel.useIt")}
          </button>
        </p>
      ) : (
        <>
          <span className="shrink-0 text-ink-muted">{t("claude.panel.lookingAt")}</span>
          <ContextChip description={d} onRemove={() => context.setRemoved(true)} />
        </>
      )}
    </div>
  );
}

/** La conversazione vuota: titolo, le due frasi, e PROVA con tre righe scelte dal contesto [CP 8]. */
function EmptyConversation({
  archived,
  context,
  onTry,
}: {
  archived: boolean;
  context: PageContext;
  onTry: (text: string) => void;
}) {
  const { t } = useTranslation();
  const me = useSessionPersonId();
  const projects = useProjects().data;
  const mine = useTasks({ assigneeIds: [me] }).data;
  const tryId = useId();
  const d = context.sent ? context.description : null;
  const projectCode = d?.projectId
    ? (projects?.find((p) => p.id === d.projectId)?.code ?? null)
    : null;
  let tries: string[];
  if (d && context.sent?.kind === "task" && d.code) {
    tries = (["summarize", "plan", "waiting"] as const).map((k) =>
      t(`claude.panel.empty.task.${k}`, { code: d.code }),
    );
  } else if (projectCode) {
    tries = (["stand", "stalled", "create"] as const).map((k) =>
      t(`claude.panel.empty.project.${k}`, { code: projectCode }),
    );
  } else {
    const explain = mine?.[0]?.code;
    tries = [
      t("claude.destination.landing.suggest.today"),
      t("claude.destination.landing.suggest.projects"),
      ...(explain ? [t("claude.destination.landing.suggest.explain", { code: explain })] : []),
    ];
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-5 pb-4">
      {archived && <p className="pb-3 text-sm text-ink-faint">{t("claude.panel.archived")}</p>}
      <h3 className="text-lg font-semibold text-ink">{t("claude.panel.empty.title")}</h3>
      <p className="pt-1.5 text-md text-ink-muted">{t("claude.destination.landing.intro")}</p>
      <p id={tryId} className="heading-group pt-6 pb-1">
        {t("claude.panel.empty.try")}
      </p>
      <ul aria-labelledby={tryId} className="flex flex-col">
        {tries.map((s) => (
          <li key={s}>
            <button
              type="button"
              onClick={() => onTry(s)}
              className="flex h-8 w-full min-w-0 items-center rounded-md px-2 text-left text-md text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/4 hover:text-ink"
            >
              <span className="min-w-0 truncate">{s}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Un bottone icona di 32 px della testata, con nome accessibile e tooltip.
 * Spento per una regola: resta raggiungibile, e la frase che dice perché è
 * il suo tooltip e la sua descrizione.
 */
function HeaderButton({
  label,
  title,
  shortcut,
  disabledReason = null,
  disabledId,
  onClick,
  children,
}: {
  label: string;
  title?: string;
  shortcut?: string;
  disabledReason?: string | null;
  disabledId?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  const disabled = disabledReason !== null;
  return (
    <>
      <button
        type="button"
        aria-label={label}
        title={disabledReason ?? title ?? label}
        aria-disabled={disabled || undefined}
        aria-describedby={disabled ? disabledId : undefined}
        aria-keyshortcuts={shortcut}
        onClick={disabled ? undefined : onClick}
        className={`grid size-8 shrink-0 place-items-center rounded-md transition-colors duration-[var(--duration-fast)] ease-out ${disabled ? "cursor-default text-ink-faint/60" : "text-ink-muted hover:bg-ink/6 hover:text-ink active:bg-ink/10"}`}
      >
        <svg
          viewBox="0 0 16 16"
          width={16}
          height={16}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.4}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          {children}
        </svg>
      </button>
      {disabled && (
        <span id={disabledId} className="sr-only">
          {disabledReason}
        </span>
      )}
    </>
  );
}
