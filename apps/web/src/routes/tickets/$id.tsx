import {
  ticketPrioritySchema,
  ticketStatusSchema,
  type TicketPriority,
  type TicketStatus,
} from "@stubwise/shared";
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityFeed } from "../../components/activity-feed";
import { AIJobTimeline } from "../../components/ai-job-timeline";
import { AttachmentList } from "../../components/attachment-list";
import { AttachmentUpload } from "../../components/attachment-upload";
import { Avatar } from "../../components/avatar";
import {
  PriorityBadge,
  PrStateBadge,
  SOURCE_LABEL_KEYS,
  PRIORITY_LABEL_KEYS,
  STATUS_LABEL_KEYS,
  SourceBadge,
  StatusBadge,
  TypeBadge,
} from "../../components/badges";
import { CollapsibleSection } from "../../components/collapsible-section";
import { ConfirmDeleteButton } from "../../components/confirm-delete-button";
import { SelectField } from "../../components/field";
import { LabelsEditor } from "../../components/labels-editor";
import { Markdown } from "../../components/markdown";
import { answerErrorMessage, QuestionPanel } from "../../components/question-panel";
import { TechnicalPayload } from "../../components/technical-payload";
import { TicketLinks } from "../../components/ticket-links";
import { UsagePanel } from "../../components/usage-panel";
import {
  answerTicketQuestion,
  ApiError,
  approvePlan,
  deleteTicketDesign,
  deleteTicketPlan,
  patchTicket,
  postComment,
  postRunAi,
  rejectPlan,
  type AnswerBody,
  type Ticket,
  type TicketPatch,
  type TicketQuestion,
} from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import { translateApiError } from "../../lib/translate-api-error";
import { meQueryOptions } from "../../lib/auth";
import {
  commentsQueryOptions,
  inboxKeys,
  instanceSettingsQueryOptions,
  milestonesQueryOptions,
  projectsQueryOptions,
  ticketAttachmentsQueryOptions,
  ticketJobsQueryOptions,
  ticketKeys,
  ticketQueryOptions,
  ticketQuestionsQueryOptions,
  ticketUsageQueryOptions,
  usersQueryOptions,
} from "../../lib/queries";

// L'id della route include il layout autenticato (id "authed").
const route = getRouteApi("/authed/tickets/$id");

/**
 * Dettaglio di un ticket: descrizione markdown, payload tecnico
 * collassabile, pannello "AI activity" (timeline dei job + azioni) e
 * timeline di attività unificata (commenti, eventi di audit e marker dei
 * job AI), più il pannello azioni laterale (stato, priorità, assegnatario,
 * label). Il loader della route ha già precaricato tutte le query: le
 * useSuspenseQuery non attendono.
 */
export function TicketDetailPage() {
  const { t } = useTranslation();
  const { id } = route.useParams();
  const queryClient = useQueryClient();

  const { data: ticket } = useSuspenseQuery(ticketQueryOptions(id));
  const { data: comments } = useSuspenseQuery(commentsQueryOptions(id));
  const { data: jobs } = useSuspenseQuery(ticketJobsQueryOptions(id));
  const { data: usage } = useSuspenseQuery(ticketUsageQueryOptions(id));
  const { data: users } = useSuspenseQuery(usersQueryOptions);
  const { data: projects } = useSuspenseQuery(projectsQueryOptions);
  const { data: me } = useSuspenseQuery(meQueryOptions);
  // Ruolo: approvare/rifiutare un piano è una decisione da MAINTAINER (il
  // server risponde 403 a un operatore). La UI non fa da guardia — la guardia è
  // il server — ma non mostra un bottone che sappiamo fallirebbe.
  const isAdmin = me.user.role === "admin";
  // Milestone del progetto del ticket: alimentano il select del pannello, il
  // badge del dettaglio e la risoluzione id→nome del feed. useQuery (non
  // suspense): un fallimento o un caricamento in corso degrada il select a
  // "None" + nessuna risoluzione, senza bloccare il dettaglio.
  const { data: milestones = [] } = useQuery(milestonesQueryOptions(ticket.projectId));

  const projectName = projects.find((project) => project.id === ticket.projectId)?.name ?? "—";
  // id → identità (email + avatar Slack): firma e avatar di commenti/eventi nel
  // feed e dell'assegnatario. L'avatar è null per chi non ha l'identità Slack
  // linkata (l'Avatar degrada a iniziali).
  const authors = new Map(
    users.map((user) => [user.id, { email: user.email, avatarUrl: user.avatarUrl }]),
  );
  const assignee = ticket.assigneeId ? authors.get(ticket.assigneeId) : undefined;
  const milestoneNames = new Map(milestones.map((milestone) => [milestone.id, milestone.name]));
  const currentMilestoneName =
    ticket.milestoneId !== null ? milestoneNames.get(ticket.milestoneId) : undefined;

  // Export del ticket in markdown (frontmatter + corpo), da copiare/scaricare per
  // darlo in pasto a un agente locale. Stesso pattern dell'export del backlog:
  // i valori stringa liberi passano da JSON.stringify (":"/caratteri speciali
  // romperebbero lo YAML se interpolati nudi; JSON è un sottoinsieme di YAML).
  const [copiedMd, setCopiedMd] = useState(false);

  function exportMarkdown(): string {
    const front = [
      "---",
      `ticket: "#${ticket.number}"`,
      `title: ${JSON.stringify(ticket.title)}`,
      `type: ${ticket.type}`,
      `status: ${ticket.status}`,
      `priority: ${ticket.priority}`,
      `effort: ${ticket.effort ?? "-"}`,
      `project: ${JSON.stringify(projectName)}`,
      `milestone: ${currentMilestoneName ? JSON.stringify(currentMilestoneName) : "-"}`,
      `assignee: ${assignee ? JSON.stringify(assignee.email) : "-"}`,
      `labels: ${ticket.labels.length > 0 ? JSON.stringify(ticket.labels.join(", ")) : "-"}`,
      `source: ${ticket.source}`,
      "---",
      "",
      `# #${ticket.number} ${ticket.title}`,
      "",
      ticket.body.trim() === "" ? "_(nessuna descrizione)_" : ticket.body,
    ].join("\n");
    // Il piano, se presente, segue il corpo come sezione dedicata.
    const plan = ticket.implementationPlan
      ? `\n\n## ${t("tickets:detail.plan")}\n\n${ticket.implementationPlan}`
      : "";
    return `${front}${plan}`;
  }

  function slugifyTicket(): string {
    const slug = ticket.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return `ticket-${ticket.number}${slug ? `-${slug}` : ""}`;
  }

  async function copyMarkdown() {
    try {
      await navigator.clipboard?.writeText(exportMarkdown());
      setCopiedMd(true);
      setTimeout(() => setCopiedMd(false), 2000);
    } catch {
      // Clipboard non disponibile/negata: nessun crash, il download resta.
    }
  }

  function downloadMarkdown() {
    const blob = new Blob([exportMarkdown()], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${slugifyTicket()}.md`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  const exportButtonClass =
    "rounded-sm border border-line-strong px-2.5 py-1 font-mono text-[11px] tracking-[0.08em] text-fg-muted uppercase transition-colors hover:text-fg";

  const patchMutation = useMutation({
    mutationFn: (patch: TicketPatch) => patchTicket(id, patch),
    onSuccess: async (updated) => {
      // Un refetch del dettaglio già in volo risolverebbe DOPO il
      // setQueryData, sovrascrivendolo con dati stantii: prima si cancella.
      await queryClient.cancelQueries({ queryKey: ticketKeys.detail(id) });
      // La PATCH restituisce il ticket base (senza lo stato per-repo né
      // design/piano): si fonde conservando `repositories`, `implementationPlan`
      // e `originContent` dalla cache del dettaglio, che una PATCH di metadati
      // non tocca. L'invalidate qui sotto riconcilia comunque col server.
      queryClient.setQueryData(ticketQueryOptions(id).queryKey, (previous) =>
        previous
          ? { ...previous, ...updated }
          : { ...updated, implementationPlan: null, originContent: null, repositories: [] },
      );
      // Il dettaglio resta fresco per i prossimi mount; liste e board
      // mostrano status/priorità/label e le loro cache sono da rifare
      // (boards() matcha ogni board, qualunque filtro progetto).
      void queryClient.invalidateQueries({ queryKey: ticketKeys.detail(id) });
      void queryClient.invalidateQueries({ queryKey: ticketKeys.lists() });
      void queryClient.invalidateQueries({ queryKey: ticketKeys.boards() });
      // Una patch (stato/priorità/tipo/assegnatario/label) genera un evento di
      // audit: il feed va riconciliato col backend.
      void queryClient.invalidateQueries({ queryKey: ticketKeys.activity(id) });
    },
  });

  // Ticket chiuso: le azioni di rimozione di design/piano sono nascoste (come
  // il backlog nasconde le rimozioni sulle voci bloccate). Design/piano restano
  // comunque leggibili.
  const isClosed = ticket.status === "closed";

  // Delete di design/piano: gli endpoint sono requireAuth (non admin) —
  // collegare e scollegare design/piano è lavoro quotidiano. Tornano la forma
  // DETTAGLIO (body ripristinato dall'origine / implementationPlan azzerato),
  // che si scrive in cache; poi si invalida per riconciliare col server. La
  // rimozione del design genera anche un evento di audit → invalida il feed.
  const applyDetail = async (updated: Ticket) => {
    await queryClient.cancelQueries({ queryKey: ticketKeys.detail(id) });
    queryClient.setQueryData(ticketQueryOptions(id).queryKey, updated);
    void queryClient.invalidateQueries({ queryKey: ticketKeys.detail(id) });
    void queryClient.invalidateQueries({ queryKey: ticketKeys.activity(id) });
  };

  const deleteDesignMutation = useMutation({
    mutationFn: () => deleteTicketDesign(id),
    onSuccess: applyDetail,
  });
  const deletePlanMutation = useMutation({
    mutationFn: () => deleteTicketPlan(id),
    onSuccess: applyDetail,
  });

  const commentMutation = useMutation({
    mutationFn: (body: string) => postComment(id, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: commentsQueryOptions(id).queryKey });
      void queryClient.invalidateQueries({ queryKey: ticketKeys.activity(id) });
    },
  });

  // Rilanciato/ripreso il job: la timeline (e lo stato del ticket, che il triage
  // riporta in lavorazione) vanno riconciliati col backend.
  const invalidateJobAndDetail = () => {
    void queryClient.invalidateQueries({ queryKey: ticketKeys.jobs(id) });
    void queryClient.invalidateQueries({ queryKey: ticketKeys.detail(id) });
    // Il marker del job e gli eventuali eventi/commenti AI compaiono nel feed.
    void queryClient.invalidateQueries({ queryKey: ticketKeys.activity(id) });
  };

  const runAiMutation = useMutation({
    // `withInstructions` riprende sul fix (resume_mode=fix) incorporando i
    // commenti utente; senza opzione si rifà il triage da capo.
    mutationFn: (opts?: { withInstructions?: boolean }) => postRunAi(id, opts),
    onSuccess: invalidateJobAndDetail,
  });

  // "Rifiuta" non spara subito: apre un campo istruzioni inline (il testo
  // diventa un commento del team che il re-plan rilegge). Aperto/chiuso e
  // contenuto vivono qui perché il bottone e il campo sono nella stessa card.
  const [rejecting, setRejecting] = useState(false);
  const [rejectInstructions, setRejectInstructions] = useState("");

  const approvePlanMutation = useMutation({
    mutationFn: () => approvePlan(id),
    onSuccess: invalidateJobAndDetail,
  });

  const rejectPlanMutation = useMutation({
    // Istruzioni FACOLTATIVE: vuote (o soli spazi) il body parte senza la
    // chiave, come fa la card dell'inbox.
    mutationFn: (instructions?: string) =>
      rejectPlan(id, instructions ? { instructions } : undefined),
    onSuccess: () => {
      setRejecting(false);
      setRejectInstructions("");
      invalidateJobAndDetail();
    },
  });

  // Il job più recente è il primo della lista (ordinata desc dal server).
  // Da un set di stati TERMINALI un umano può (ri)lanciare il fix manualmente:
  // "held" (gate di automazione in attesa), "pr_closed" (PR rifiutata, ticket
  // riaperto), "failed"/"skipped" (re-run manuale dopo un esito negativo).
  // NON si rilancia da "pr_opened"/"pr_merged" (PR già aperta/mergiata), dagli
  // stati in volo (queued/triaging/fixing) né da "awaiting_plan_approval" (che
  // ha i suoi bottoni Approva/Rifiuta — mutuamente esclusivi col rilancio).
  const latestJob = jobs[0];
  const RELAUNCHABLE_STATUSES = ["held", "pr_closed", "failed", "skipped"] as const;
  const canRelaunch =
    latestJob !== undefined &&
    (RELAUNCHABLE_STATUSES as readonly string[]).includes(latestJob.status);
  const awaitingPlanApproval = latestJob?.status === "awaiting_plan_approval";
  // Il job è fermo su una DOMANDA dell'agente. Non è uno stato da cui si
  // rilancia (per questo `awaiting_input` non è fra i RELAUNCHABLE): il job è
  // vivo e riparte da solo appena qualcuno risponde.
  const awaitingInput = latestJob?.status === "awaiting_input";

  // Q&A dell'agente sul ticket: la domanda aperta (il pannello) e quelle già
  // chiuse (lo storico). useQuery e non suspense: se la lista non arriva il
  // resto del dettaglio resta intero, e la timeline dice comunque che il job
  // aspetta una risposta.
  const { data: questions = [] } = useQuery(ticketQuestionsQueryOptions(id));

  /**
   * CHI vede il pannello di risposta: il richiedente del run — l'unico che sa
   * rispondere nel merito — e i maintainer, che devono poter sbloccare il job
   * di un collega. È la stessa regola di `actorAllows` lato server, dove resta
   * l'AUTORITÀ: qui si decide solo cosa mostrare, e se le due divergessero
   * l'errore del server sarebbe la verità.
   */
  const requesterId = latestJob?.requestedByUserId ?? null;
  const canAnswer = isAdmin || (requesterId !== null && requesterId === me.user.id);
  const requesterEmail = requesterId !== null ? authors.get(requesterId)?.email : undefined;

  /**
   * La domanda APERTA del job fermo. Si guarda `answeredAt` e non `answer`:
   * quest'ultimo è `null` anche su una risposta che il server non è più riuscito
   * a rileggere, e prendere quella per una domanda aperta significherebbe
   * mostrare un pannello di risposta su una decisione già presa.
   */
  const openQuestion = questions.find(
    (question) => question.answeredAt === null && question.jobId === latestJob?.id,
  );
  const pastQuestions = questions.filter((question) => question.answeredAt !== null);

  // Errore dell'ultima risposta, già localizzato: vive qui perché il pannello
  // lo riceve come stringa (le parole sui `code` sono di `answerErrorMessage`,
  // condivise con la card d'inbox).
  const [answerError, setAnswerError] = useState<string | null>(null);
  const answerMutation = useMutation({
    // La domanda viaggia con la risposta: il server rifiuta se nel frattempo il
    // job ne ha aperta un'altra (una scheda ferma sul round vecchio manderebbe
    // un indice scelto leggendo altre opzioni).
    mutationFn: ({ questionId, answer }: { questionId: string; answer: AnswerBody }) =>
      answerTicketQuestion(id, questionId, answer),
    onMutate: () => setAnswerError(null),
    onSuccess: () => {
      invalidateJobAndDetail();
      void queryClient.invalidateQueries({ queryKey: ticketKeys.questions(id) });
      // La risposta chiude anche la riga d'inbox (e il DM Slack): il badge dei
      // non letti mentirebbe finché non ricarica.
      void queryClient.invalidateQueries({ queryKey: inboxKeys.all });
    },
    onError: (cause) => {
      setAnswerError(answerErrorMessage(cause, t));
      // Anche (anzi: soprattutto) dopo un 409 job e Q&A vanno ricaricati: il
      // conflitto DICE che quello che si ha davanti è stantio — un collega ha
      // risposto per primo, e il job può già essere ripartito o aver aperto un
      // round nuovo. È lo stesso riflesso della card d'inbox, e qui è
      // indispensabile: senza polling sulle Q&A e senza refetch al focus, nel
      // caso "stesso job, round nuovo" `awaitingInput` non viene mai osservato
      // falso e `latestJob.id` non cambia — l'effetto qui sotto non rifirerebbe
      // MAI, e la pagina resterebbe sul round vecchio fino a un ricaricamento a
      // mano. Questa superficie è il ripiego di chi ha una card marcia o un DM
      // senza bottoni: deve riallinearsi da sola.
      if (cause instanceof ApiError && cause.status === 409) {
        void queryClient.invalidateQueries({ queryKey: ticketKeys.jobs(id) });
        void queryClient.invalidateQueries({ queryKey: ticketKeys.questions(id) });
      }
    },
  });

  /**
   * La domanda nasce DOPO il job che la pone: quando l'ultimo job entra in
   * `awaiting_input` la lista Q&A in cache è per forza vecchia (quella domanda
   * non c'era). Ricaricarla qui la fa comparire appena la timeline si muove,
   * invece di aspettare il giro di polling successivo — ed è anche ciò che
   * porta a schermo il round nuovo quando lo stesso job ne apre un altro.
   */
  useEffect(() => {
    if (!awaitingInput) return;
    void queryClient.invalidateQueries({ queryKey: ticketKeys.questions(id) });
  }, [queryClient, id, awaitingInput, latestJob?.id]);

  // Un errore appartiene alla domanda su cui è successo: cambiata la domanda
  // (round nuovo), il messaggio vecchio parlerebbe di una decisione che non è
  // più quella che si ha davanti.
  const openQuestionId = openQuestion?.questionId;
  useEffect(() => {
    setAnswerError(null);
  }, [openQuestionId]);
  // Primo avvio: il ticket non ha ancora alcun job (es. creato a mano dalla
  // UI). C'è solo "Avvia fix AI" (stesso handler del rilancio, senza
  // withInstructions): il server accoda un nuovo job e parte il triage. Niente
  // "Rilancia con istruzioni"/hint, che hanno senso solo dopo un primo esito.
  const canStartFix = latestJob === undefined;

  // Hint per "Rilancia con istruzioni": senza commenti dell'utente il rilancio
  // non avrebbe nuove indicazioni da incorporare. Non blocca, solo guida.
  const hasUserComment = comments.some((comment) => comment.authorType === "user");

  /**
   * Il riepilogo del 202 (`runAwaitingApproval`) serve a coprire la finestra fra
   * la risposta e il refetch della timeline. Appena il job cambia — nuovo id o
   * nuovo stato — quel che si vede a schermo lo dice già, e il messaggio
   * diventerebbe rumore o, peggio, contraddirebbe lo stato mostrato (il polling
   * lento sugli stati d'attesa rende la transizione visibile senza ricaricare):
   * si azzera la mutation e resta la sola timeline a raccontare il job.
   */
  const resetRunAi = runAiMutation.reset;
  useEffect(() => {
    resetRunAi();
  }, [resetRunAi, latestJob?.id, latestJob?.status]);

  /**
   * Contorno dei bottoni di avvio/rilancio, identico nei due blocchi: l'avviso
   * per l'OPERATORE (il suo run non parte, si ferma sul gate del piano), la
   * conferma dell'esito quando il 202 dice `awaiting_plan_approval` e l'errore.
   *
   * L'errore passa da {@link translateApiError}: il `code` è contratto, il
   * `message` del server no (ed è in inglese) — così il 409 `job_in_flight`
   * diventa una frase localizzata invece di "A job is already in flight".
   */
  const runAiFeedback = (
    <>
      {!isAdmin && (
        <p className="font-mono text-[11px] text-fg-muted">
          {t("tickets:detail.memberRunHint")}
        </p>
      )}
      {runAiMutation.data?.status === "awaiting_plan_approval" && (
        <p role="status" className="font-mono text-[11px] text-signal">
          {t("tickets:detail.runAwaitingApproval")}
        </p>
      )}
      {runAiMutation.isError && (
        <span role="alert" className="font-mono text-[12px] text-danger">
          {translateApiError(runAiMutation.error, t)}
        </span>
      )}
    </>
  );

  return (
    <div className="page">
      <Link
        to="/tickets"
        className="font-mono text-[11px] tracking-[0.14em] text-fg-faint uppercase transition-colors hover:text-fg-muted"
      >
        {t("tickets:detail.back")}
      </Link>

      <header className="mt-3 border-b border-line pb-5">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="font-mono text-lg text-signal">#{ticket.number}</span>
            <h1 className="text-xl font-semibold">{ticket.title}</h1>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button type="button" onClick={() => void copyMarkdown()} className={exportButtonClass}>
              {copiedMd ? t("tickets:detail.copied") : t("tickets:detail.copyMd")}
            </button>
            <button type="button" onClick={downloadMarkdown} className={exportButtonClass}>
              {t("tickets:detail.downloadMd")}
            </button>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <StatusBadge status={ticket.status} />
          <PriorityBadge priority={ticket.priority} />
          <TypeBadge type={ticket.type} />
          {ticket.effort !== null && (
            <span className="font-mono text-[11px] text-fg-muted" title={t("tickets:detail.effortTitle")}>
              {t("tickets:detail.effort", {
                label: t(`badges:effort.${ticket.effort}`, { defaultValue: String(ticket.effort) }),
                value: ticket.effort,
              })}
            </span>
          )}
          <SourceBadge source={ticket.source} />
          {ticket.source === "widget" && (
            <Link
              to="/projects/$projectId/conversations"
              params={{ projectId: ticket.projectId }}
              search={{ ticketId: ticket.id }}
              className="font-mono text-[11px] tracking-[0.08em] text-signal uppercase transition-colors hover:text-signal-bright"
            >
              {t("widget:conversations.viewConversation")}
            </Link>
          )}
          <span className="font-mono text-[11px] text-fg-muted">{projectName}</span>
          {currentMilestoneName && (
            <span
              className="rounded-sm border border-signal-dim/40 px-1.5 py-px font-mono text-[11px] text-signal"
              title={t("tickets:detail.milestone")}
            >
              {currentMilestoneName}
            </span>
          )}
          {ticket.occurrences > 1 && (
            <span className="font-mono text-[11px] text-signal" title={t("tickets:detail.occurrences")}>
              ×{ticket.occurrences}
            </span>
          )}
        </div>
      </header>

      <div className="mt-6 grid gap-8 lg:grid-cols-[minmax(0,1fr)_17rem]">
        <div className="min-w-0 space-y-6">
          {/* Descrizione: è il DESIGN se collegato (l'origine è preservata in
              `originContent` e mostrata sotto in un blocco collassabile),
              altrimenti la descrizione originale del ticket. */}
          <section aria-label={t("tickets:detail.designDescription")}>
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className={sectionTitleBase}>{t("tickets:detail.designDescription")}</h2>
              {!isClosed && ticket.originContent !== null && (
                <ConfirmDeleteButton
                  label={t("tickets:detail.deleteDesign")}
                  confirmLabel={t("tickets:detail.confirmRemove")}
                  confirmAria={t("tickets:detail.deleteDesignConfirmAria")}
                  pending={deleteDesignMutation.isPending}
                  onConfirm={() => deleteDesignMutation.mutate()}
                />
              )}
            </div>
            {ticket.body.trim() === "" ? (
              <p className="font-mono text-[12px] text-fg-faint">{t("tickets:detail.noDescription")}</p>
            ) : (
              <Markdown source={ticket.body} />
            )}
            {deleteDesignMutation.isError && (
              <p role="alert" className="mt-2 font-mono text-[12px] text-danger">
                {deleteDesignMutation.error.message}
              </p>
            )}
          </section>

          {/* Piano di implementazione: reso in Markdown, con empty state quando
              nessun piano è collegato. Solo render/delete (si crea da Claude Code). */}
          <section aria-label={t("tickets:detail.plan")}>
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className={sectionTitleBase}>{t("tickets:detail.plan")}</h2>
              {!isClosed && ticket.implementationPlan !== null && (
                <ConfirmDeleteButton
                  label={t("tickets:detail.deletePlan")}
                  confirmLabel={t("tickets:detail.confirmRemove")}
                  confirmAria={t("tickets:detail.deletePlanConfirmAria")}
                  pending={deletePlanMutation.isPending}
                  onConfirm={() => deletePlanMutation.mutate()}
                />
              )}
            </div>
            {/*
              RIASSUNTO "IN BREVE" (fase 5): le stesse frasi non tecniche che la
              card d'inbox mostra sopra Approva/Rifiuta, qui sopra il piano.
              Viene dall'ULTIMO job del ticket e vive quanto il suo piano (il
              rifiuto azzera entrambi), quindi non resta mai a descrivere un
              piano che non c'è più. Assente ⇒ la sezione è quella di prima.
            */}
            {ticket.planSummary != null && ticket.planSummary !== "" && (
              <div className="mb-3 border-l-2 border-line-strong pl-3">
                <p className="font-mono text-[11px] tracking-[0.08em] text-fg-faint uppercase">
                  {t("tickets:detail.planSummary")}
                </p>
                <p className="mt-1 text-sm text-fg-muted">{ticket.planSummary}</p>
              </div>
            )}
            {ticket.implementationPlan === null ? (
              <p className="font-mono text-[12px] text-fg-faint">{t("tickets:detail.noPlan")}</p>
            ) : (
              <Markdown source={ticket.implementationPlan} />
            )}
            {deletePlanMutation.isError && (
              <p role="alert" className="mt-2 font-mono text-[12px] text-danger">
                {deletePlanMutation.error.message}
              </p>
            )}
          </section>

          {/* Richiesta originale: presente solo quando un design ha sostituito la
              descrizione. Collassata di default (dettaglio secondario). */}
          {ticket.originContent !== null && (
            <CollapsibleSection title={t("tickets:detail.originalRequest")}>
              <Markdown source={ticket.originContent} />
            </CollapsibleSection>
          )}

          {ticket.technicalPayload !== null && (
            <CollapsibleSection title={t("tickets:detail.technicalPayload")} meta={t(SOURCE_LABEL_KEYS[ticket.source])}>
              <TechnicalPayload payload={ticket.technicalPayload} />
            </CollapsibleSection>
          )}

          <section aria-label={t("tickets:detail.aiActivity")}>
            <h2 className={sectionTitleClass}>{t("tickets:detail.aiActivity")}</h2>
            <AIJobTimeline jobs={jobs} />
            {/* La DOMANDA dell'agente, subito sotto la timeline che la annuncia:
                è la ragione per cui il job è fermo, e finché resta lì non c'è
                nient'altro da fare su questo ticket.

                A chi non può rispondere si dice solo chi si sta aspettando: un
                pannello che il server rifiuterebbe con un 403 sarebbe peggio di
                nessun pannello. Senza la domanda in mano (lista non ancora
                arrivata, o non più leggibile) non si rende nulla: la nota della
                timeline dice comunque perché il job non si muove. */}
            {awaitingInput &&
              (canAnswer ? (
                openQuestion !== undefined && (
                  <QuestionPanel
                    question={openQuestion}
                    pending={answerMutation.isPending}
                    error={answerError}
                    onSubmit={(answer) =>
                      answerMutation.mutate({ questionId: openQuestion.questionId, answer })
                    }
                  />
                )
              ) : (
                <p className="mt-3 font-mono text-[12px] text-fg-muted">
                  {requesterEmail
                    ? t("tickets:detail.awaitingAnswerFrom", { email: requesterEmail })
                    : t("tickets:detail.awaitingAnswerUnknown")}
                </p>
              ))}
            {/* Primo avvio (nessun job): solo "Avvia fix AI". */}
            {canStartFix && (
              <div className="mt-3 space-y-2">
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    disabled={runAiMutation.isPending}
                    onClick={() => runAiMutation.mutate(undefined)}
                    className="rounded-sm bg-signal px-3 py-2 font-mono text-[12px] font-semibold tracking-[0.08em] text-ink-950 uppercase transition-colors hover:bg-signal-bright active:bg-signal-dim disabled:cursor-not-allowed disabled:bg-signal-dim disabled:opacity-60"
                  >
                    {runAiMutation.isPending
                      ? t("tickets:detail.startingFix")
                      : t("tickets:detail.startFix")}
                  </button>
                </div>
                {runAiFeedback}
              </div>
            )}
            {/* Rilancio (job in stato terminale): avvio + rilancio con istruzioni. */}
            {canRelaunch && (
              <div className="mt-3 space-y-2">
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    disabled={runAiMutation.isPending}
                    onClick={() => runAiMutation.mutate(undefined)}
                    className="rounded-sm bg-signal px-3 py-2 font-mono text-[12px] font-semibold tracking-[0.08em] text-ink-950 uppercase transition-colors hover:bg-signal-bright active:bg-signal-dim disabled:cursor-not-allowed disabled:bg-signal-dim disabled:opacity-60"
                  >
                    {runAiMutation.isPending
                      ? t("tickets:detail.startingFix")
                      : t("tickets:detail.startFix")}
                  </button>
                  <button
                    type="button"
                    disabled={runAiMutation.isPending}
                    onClick={() => runAiMutation.mutate({ withInstructions: true })}
                    className="rounded-sm border border-signal-dim px-3 py-2 font-mono text-[12px] font-semibold tracking-[0.08em] text-signal uppercase transition-colors hover:border-signal hover:bg-signal/10 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {t("tickets:detail.relaunchWithInstructions")}
                  </button>
                </div>
                {!hasUserComment && (
                  <p className="font-mono text-[11px] text-fg-muted">
                    {t("tickets:detail.addCommentHint")}
                  </p>
                )}
                {runAiFeedback}
              </div>
            )}
            {/* Piano in attesa: la DECISIONE è dei maintainer. All'operatore si
                dice solo che il piano è fermo lì, senza bottoni che il server
                rifiuterebbe con un 403. */}
            {awaitingPlanApproval && !isAdmin && (
              <p className="mt-3 font-mono text-[12px] text-fg-muted">
                {t("tickets:detail.awaitingMaintainer")}
              </p>
            )}
            {awaitingPlanApproval && isAdmin && (
              <div className="mt-3 space-y-2">
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    disabled={approvePlanMutation.isPending || rejectPlanMutation.isPending}
                    onClick={() => approvePlanMutation.mutate()}
                    className="rounded-sm bg-signal px-3 py-2 font-mono text-[12px] font-semibold tracking-[0.08em] text-ink-950 uppercase transition-colors hover:bg-signal-bright active:bg-signal-dim disabled:cursor-not-allowed disabled:bg-signal-dim disabled:opacity-60"
                  >
                    {approvePlanMutation.isPending
                      ? t("tickets:detail.approving")
                      : t("tickets:detail.approve")}
                  </button>
                  <button
                    type="button"
                    disabled={approvePlanMutation.isPending || rejectPlanMutation.isPending}
                    aria-expanded={rejecting}
                    onClick={() => setRejecting((open) => !open)}
                    className="rounded-sm border border-line-strong px-3 py-2 font-mono text-[12px] font-semibold tracking-[0.08em] text-fg-muted uppercase transition-colors hover:border-danger hover:text-danger disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {rejectPlanMutation.isPending
                      ? t("tickets:detail.rejecting")
                      : t("tickets:detail.reject")}
                  </button>
                </div>
                {rejecting && (
                  <div>
                    <label
                      htmlFor="reject-instructions"
                      className="font-mono text-[10px] tracking-[0.16em] text-fg-faint uppercase"
                    >
                      {t("tickets:detail.rejectInstructionsLabel")}
                    </label>
                    <textarea
                      id="reject-instructions"
                      rows={3}
                      value={rejectInstructions}
                      onChange={(event) => setRejectInstructions(event.target.value)}
                      placeholder={t("tickets:detail.rejectInstructionsPlaceholder")}
                      className="mt-1 w-full rounded-sm border border-line-strong bg-ink-950/70 px-2 py-1.5 text-sm text-fg transition-colors focus-visible:border-signal-dim"
                    />
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={rejectPlanMutation.isPending}
                        onClick={() => rejectPlanMutation.mutate(rejectInstructions.trim() || undefined)}
                        className="rounded-sm bg-signal px-3 py-2 font-mono text-[11px] font-semibold tracking-[0.08em] text-ink-950 uppercase transition-colors hover:bg-signal-bright disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {t("tickets:detail.rejectSubmit")}
                      </button>
                      <button
                        type="button"
                        disabled={rejectPlanMutation.isPending}
                        onClick={() => setRejecting(false)}
                        className="rounded-sm border border-line-strong px-3 py-2 font-mono text-[11px] tracking-[0.08em] text-fg-muted uppercase transition-colors hover:text-fg disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {t("tickets:detail.rejectCancel")}
                      </button>
                    </div>
                    <p className="mt-2 font-mono text-[11px] text-fg-muted">
                      {t("tickets:detail.rejectHint")}
                    </p>
                  </div>
                )}
                {approvePlanMutation.isError && (
                  <span role="alert" className="font-mono text-[12px] text-danger">
                    {translateApiError(approvePlanMutation.error, t)}
                  </span>
                )}
                {rejectPlanMutation.isError && (
                  <span role="alert" className="font-mono text-[12px] text-danger">
                    {translateApiError(rejectPlanMutation.error, t)}
                  </span>
                )}
              </div>
            )}
            {/* Le domande già CHIUSE: consultazione, non decisione — collassate
                di default. Quella ancora aperta non entra qui: si risponde nel
                pannello, e vederla due volte confonderebbe. */}
            {pastQuestions.length > 0 && (
              <div className="mt-3">
                <CollapsibleSection
                  title={t("tickets:detail.pastQuestions")}
                  meta={String(pastQuestions.length)}
                >
                  <ol className="space-y-3">
                    {pastQuestions.map((question) => (
                      <PastQuestion key={question.questionId} question={question} />
                    ))}
                  </ol>
                </CollapsibleSection>
              </div>
            )}
          </section>

          <section aria-label={t("tickets:repositories.title")}>
            <h2 className={sectionTitleClass}>{t("tickets:repositories.title")}</h2>
            {ticket.repositories.length === 0 ? (
              <p className="font-mono text-[12px] text-fg-faint">
                {t("tickets:repositories.empty")}
              </p>
            ) : (
              <ul className="rounded-sm border border-line bg-ink-900">
                {ticket.repositories.map((repo) => (
                  <li
                    key={repo.repositoryId}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line px-4 py-3 last:border-b-0"
                  >
                    <Link
                      to="/repositories/$slug"
                      params={{ slug: repo.repositorySlug }}
                      className="text-sm font-medium text-fg transition-colors hover:text-signal"
                    >
                      {repo.repositoryName ?? repo.repositorySlug}
                    </Link>
                    <span className="font-mono text-[11px] text-fg-faint">{repo.branch}</span>
                    <PrStateBadge state={repo.prState} />
                    {repo.prUrl && (
                      <a
                        href={repo.prUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="ml-auto font-mono text-[11px] tracking-[0.08em] text-signal uppercase transition-colors hover:text-signal-bright"
                      >
                        {t("tickets:repositories.viewPr")}
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Solo quando ci sono consumi: un CLI senza usage non mostra nulla. */}
          {usage.byModel.length > 0 && <UsagePanel usage={usage} />}

          <section aria-label={t("tickets:links.title")}>
            <h2 className={sectionTitleClass}>{t("tickets:links.title")}</h2>
            <TicketLinks ticketId={id} projectId={ticket.projectId} />
          </section>

          <section aria-label={t("tickets:attachments.title")}>
            <h2 className={sectionTitleClass}>{t("tickets:attachments.title")}</h2>
            <TicketAttachments ticketId={id} isAdmin={isAdmin} />
          </section>

          <section aria-label={t("tickets:activity.title")}>
            <h2 className={sectionTitleClass}>{t("tickets:activity.title")}</h2>
            <ActivityFeed
              ticketId={id}
              authors={authors}
              milestoneNames={milestoneNames}
              onSubmit={(body) => commentMutation.mutateAsync(body)}
              pending={commentMutation.isPending}
            />
          </section>
        </div>

        <aside className="space-y-5 lg:border-l lg:border-line lg:pl-6">
          <SelectField
            id="action-status"
            label={t("tickets:detail.status")}
            value={ticket.status}
            disabled={patchMutation.isPending}
            onChange={(event) =>
              patchMutation.mutate({ status: event.target.value as TicketStatus })
            }
            options={ticketStatusSchema.options.map((status) => ({
              value: status,
              label: t(STATUS_LABEL_KEYS[status]),
            }))}
          />

          <SelectField
            id="action-priority"
            label={t("tickets:detail.priority")}
            value={ticket.priority}
            disabled={patchMutation.isPending}
            onChange={(event) =>
              patchMutation.mutate({ priority: event.target.value as TicketPriority })
            }
            options={ticketPrioritySchema.options.map((priority) => ({
              value: priority,
              label: t(PRIORITY_LABEL_KEYS[priority]),
            }))}
          />

          <div className="flex flex-col gap-1.5">
            <SelectField
              id="action-assignee"
              label={t("tickets:detail.assignee")}
              value={ticket.assigneeId ?? ""}
              disabled={patchMutation.isPending}
              onChange={(event) =>
                patchMutation.mutate({ assigneeId: event.target.value || null })
              }
              options={[
                { value: "", label: t("tickets:detail.unassigned") },
                ...users.map((user) => ({ value: user.id, label: user.email })),
              ]}
            />
            {assignee && (
              <span className="flex items-center gap-2 font-mono text-[11px] text-fg-muted">
                <Avatar src={assignee.avatarUrl} label={assignee.email} size={18} />
                <span className="truncate">{assignee.email}</span>
              </span>
            )}
          </div>

          <SelectField
            id="action-milestone"
            label={t("tickets:detail.milestone")}
            value={ticket.milestoneId ?? ""}
            disabled={patchMutation.isPending}
            onChange={(event) =>
              patchMutation.mutate({ milestoneId: event.target.value || null })
            }
            options={[
              { value: "", label: t("tickets:detail.noMilestone") },
              ...milestones.map((milestone) => ({ value: milestone.id, label: milestone.name })),
            ]}
          />

          <div className="flex flex-col gap-1.5">
            <span className="font-mono text-[11px] font-medium tracking-[0.14em] text-fg-muted uppercase">
              {t("tickets:detail.labels")}
            </span>
            <LabelsEditor
              labels={ticket.labels}
              disabled={patchMutation.isPending}
              onChange={(labels) => patchMutation.mutate({ labels })}
            />
          </div>

          {patchMutation.isError && (
            <p role="alert" className="font-mono text-[12px] text-danger">
              {patchMutation.error.message}
            </p>
          )}

          <dl className="space-y-1.5 border-t border-line pt-4">
            <MetaRow label={t("tickets:detail.createdAt")} value={formatDateTime(ticket.createdAt)} />
            <MetaRow label={t("tickets:detail.updatedAt")} value={formatDateTime(ticket.updatedAt)} />
            <MetaRow label={t("tickets:detail.lastSeenAt")} value={formatDateTime(ticket.lastSeenAt)} />
            <MetaRow label={t("tickets:detail.occurrencesMeta")} value={String(ticket.occurrences)} />
          </dl>
        </aside>
      </div>
    </div>
  );
}

const sectionTitleBase =
  "font-mono text-[11px] font-medium tracking-[0.16em] text-fg-muted uppercase";
const sectionTitleClass = `mb-3 ${sectionTitleBase}`;

/**
 * Sezione allegati del ticket: lista (con anteprime) + caricamento. Per la v1
 * gli allegati si legano al TICKET (non al singolo commento): semplice e
 * sufficiente. L'upload compare per l'admin solo quando lo storage è
 * configurato (`attachmentsEnabled`), con hint + link alle Impostazioni se off;
 * il flag d'istanza è admin-only, quindi per i member l'upload si mostra
 * comunque e il server applica l'eventuale errore se lo storage è spento.
 *
 * `canDelete`: l'allegato non porta l'uploaderId nella proiezione pubblica, così
 * la UI non può distinguere "uploader vs altri". Si mostra remove all'admin
 * (che può sempre cancellare) e all'autore via il fallback del server: per
 * semplicità qui si abilita remove per l'admin e lo si lascia per i member,
 * dove il 403 del server degrada con un errore inline nella lista.
 */
function TicketAttachments({ ticketId, isAdmin }: { ticketId: string; isAdmin: boolean }) {
  const { t } = useTranslation();
  const { data: attachments } = useSuspenseQuery(ticketAttachmentsQueryOptions(ticketId));
  // Il flag è admin-only: i member non possono leggerlo, quindi la query parte
  // solo per gli admin. Per i member l'upload si mostra e il server arbitra.
  const { data: instance } = useQuery({ ...instanceSettingsQueryOptions, enabled: isAdmin });

  const attachmentsEnabled = isAdmin ? (instance?.attachmentsEnabled ?? false) : true;
  const showStorageHint = isAdmin && instance !== undefined && !instance.attachmentsEnabled;

  return (
    <div className="space-y-4">
      {/*
        canDelete: l'allegato non porta l'uploaderId, quindi la UI non distingue
        uploader vs altri; si mostra remove a tutti e il server applica il 403
        (uploader o admin), degradato a errore inline nella lista.
      */}
      <AttachmentList ticketId={ticketId} attachments={attachments} canDelete={() => true} />
      {showStorageHint ? (
        <p className="font-mono text-[12px] text-fg-faint">
          <Link to="/settings/storage" className="text-signal transition-colors hover:text-signal-bright">
            {t("tickets:attachments.configureStorage")}
          </Link>
        </p>
      ) : (
        <AttachmentUpload ticketId={ticketId} disabled={!attachmentsEnabled} />
      )}
    </div>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="font-mono text-[11px] tracking-[0.1em] text-fg-faint uppercase">{label}</dt>
      <dd className="font-mono text-[12px] text-fg-muted">{value}</dd>
    </div>
  );
}

/**
 * COSA è stato risposto, in parole: l'etichetta dell'opzione scelta o il testo
 * libero. `null` quando non è (più) leggibile — risposta di una versione
 * precedente, o indice che non cade più nelle opzioni salvate.
 *
 * Non si mostra mai l'indice nudo: un "2" non dice niente a chi legge, e se le
 * opzioni non tornano è più onesto dire che la risposta non si legge più.
 */
function answerLabel(question: TicketQuestion): string | null {
  const { answer } = question;
  if (answer === null) return null;
  if ("text" in answer) return answer.text;
  return question.options[answer.optionIndex]?.label ?? null;
}

/**
 * Una Q&A già chiusa nello storico: la domanda, la risposta e chi l'ha data.
 *
 * Ci si arriva perché `answeredAt` è valorizzato, MAI perché `answer` lo è: una
 * risposta illeggibile ha `answer: null` ed è comunque una decisione presa da
 * qualcuno — dirlo è il punto, e nasconderla farebbe sembrare che la domanda sia
 * rimasta senza risposta.
 */
function PastQuestion({ question }: { question: TicketQuestion }) {
  const { t } = useTranslation();
  const label = answerLabel(question);

  return (
    <li className="border-l-2 border-line pl-3">
      <p className="font-mono text-[10px] tracking-[0.16em] text-fg-faint uppercase">
        {t("tickets:detail.questionRound", { round: question.round })}
      </p>
      <p className="mt-1 text-sm text-fg">{question.question}</p>
      {label !== null ? (
        <p className="mt-1 text-sm text-signal">{label}</p>
      ) : (
        <p className="mt-1 font-mono text-[12px] text-fg-faint">
          {t("tickets:detail.questionAnswerUnreadable")}
        </p>
      )}
      <p className="mt-1 font-mono text-[11px] text-fg-muted">
        {question.answeredBy
          ? t("tickets:detail.questionAnsweredBy", { email: question.answeredBy.email })
          : t("tickets:detail.questionAnsweredByUnknown")}
        {question.answeredAt !== null && (
          <>
            {" · "}
            {formatDateTime(question.answeredAt)}
          </>
        )}
      </p>
    </li>
  );
}
