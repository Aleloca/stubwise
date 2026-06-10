import {
  ticketPrioritySchema,
  ticketStatusSchema,
  type TicketPriority,
  type TicketStatus,
} from "@stubwise/shared";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { AIJobTimeline } from "../../components/ai-job-timeline";
import {
  PriorityBadge,
  SOURCE_LABELS,
  PRIORITY_LABELS,
  STATUS_LABELS,
  SourceBadge,
  StatusBadge,
  TypeBadge,
} from "../../components/badges";
import { CollapsibleSection } from "../../components/collapsible-section";
import { CommentThread } from "../../components/comment-thread";
import { SelectField } from "../../components/field";
import { LabelsEditor } from "../../components/labels-editor";
import { Markdown } from "../../components/markdown";
import { TechnicalPayload } from "../../components/technical-payload";
import { patchTicket, postComment, type TicketPatch } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import {
  commentsQueryOptions,
  projectsQueryOptions,
  ticketJobsQueryOptions,
  ticketKeys,
  ticketQueryOptions,
  usersQueryOptions,
} from "../../lib/queries";

// L'id della route include il layout autenticato (id "authed").
const route = getRouteApi("/authed/tickets/$id");

/**
 * Dettaglio di un ticket: descrizione markdown, payload tecnico
 * collassabile, timeline dei job AI, thread commenti e pannello azioni
 * (stato, priorità, assegnatario, label). Il loader della route ha già
 * precaricato tutte le query: le useSuspenseQuery non attendono.
 */
export function TicketDetailPage() {
  const { id } = route.useParams();
  const queryClient = useQueryClient();

  const { data: ticket } = useSuspenseQuery(ticketQueryOptions(id));
  const { data: comments } = useSuspenseQuery(commentsQueryOptions(id));
  const { data: jobs } = useSuspenseQuery(ticketJobsQueryOptions(id));
  const { data: users } = useSuspenseQuery(usersQueryOptions);
  const { data: projects } = useSuspenseQuery(projectsQueryOptions);

  const projectName = projects.find((project) => project.id === ticket.projectId)?.name ?? "—";
  const authorEmails = new Map(users.map((user) => [user.id, user.email]));

  const patchMutation = useMutation({
    mutationFn: (patch: TicketPatch) => patchTicket(id, patch),
    onSuccess: async (updated) => {
      // Un refetch del dettaglio già in volo risolverebbe DOPO il
      // setQueryData, sovrascrivendolo con dati stantii: prima si cancella.
      await queryClient.cancelQueries({ queryKey: ticketKeys.detail(id) });
      queryClient.setQueryData(ticketQueryOptions(id).queryKey, updated);
      // Il dettaglio resta fresco per i prossimi mount; la lista mostra
      // status/priorità/label e le sue cache sono da rifare.
      void queryClient.invalidateQueries({ queryKey: ticketKeys.detail(id) });
      void queryClient.invalidateQueries({ queryKey: ticketKeys.lists() });
    },
  });

  const commentMutation = useMutation({
    mutationFn: (body: string) => postComment(id, body),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: commentsQueryOptions(id).queryKey }),
  });

  return (
    <div className="p-8">
      <Link
        to="/tickets"
        className="font-mono text-[11px] tracking-[0.14em] text-fg-faint uppercase transition-colors hover:text-fg-muted"
      >
        ← Tutti i ticket
      </Link>

      <header className="mt-3 border-b border-line pb-5">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="font-mono text-lg text-signal">#{ticket.number}</span>
          <h1 className="text-xl font-semibold">{ticket.title}</h1>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <StatusBadge status={ticket.status} />
          <PriorityBadge priority={ticket.priority} />
          <TypeBadge type={ticket.type} />
          <SourceBadge source={ticket.source} />
          <span className="font-mono text-[11px] text-fg-muted">{projectName}</span>
          {ticket.occurrences > 1 && (
            <span className="font-mono text-[11px] text-signal" title="Occorrenze deduplicate">
              ×{ticket.occurrences}
            </span>
          )}
        </div>
      </header>

      <div className="mt-6 grid gap-8 lg:grid-cols-[minmax(0,1fr)_17rem]">
        <div className="min-w-0 space-y-6">
          <section>
            <h2 className={sectionTitleClass}>Descrizione</h2>
            {ticket.body.trim() === "" ? (
              <p className="font-mono text-[12px] text-fg-faint">// nessuna descrizione</p>
            ) : (
              <Markdown source={ticket.body} />
            )}
          </section>

          {ticket.technicalPayload !== null && (
            <CollapsibleSection title="Payload tecnico" meta={SOURCE_LABELS[ticket.source]}>
              <TechnicalPayload payload={ticket.technicalPayload} />
            </CollapsibleSection>
          )}

          <section>
            <h2 className={sectionTitleClass}>Attività AI</h2>
            <AIJobTimeline jobs={jobs} />
          </section>

          <section>
            <h2 className={sectionTitleClass}>Commenti ({comments.length})</h2>
            <CommentThread
              comments={comments}
              authorEmails={authorEmails}
              onSubmit={(body) => commentMutation.mutateAsync(body)}
              pending={commentMutation.isPending}
            />
          </section>
        </div>

        <aside className="space-y-5 lg:border-l lg:border-line lg:pl-6">
          <SelectField
            id="action-status"
            label="Stato"
            value={ticket.status}
            disabled={patchMutation.isPending}
            onChange={(event) =>
              patchMutation.mutate({ status: event.target.value as TicketStatus })
            }
            options={ticketStatusSchema.options.map((status) => ({
              value: status,
              label: STATUS_LABELS[status],
            }))}
          />

          <SelectField
            id="action-priority"
            label="Priorità"
            value={ticket.priority}
            disabled={patchMutation.isPending}
            onChange={(event) =>
              patchMutation.mutate({ priority: event.target.value as TicketPriority })
            }
            options={ticketPrioritySchema.options.map((priority) => ({
              value: priority,
              label: PRIORITY_LABELS[priority],
            }))}
          />

          <SelectField
            id="action-assignee"
            label="Assegnatario"
            value={ticket.assigneeId ?? ""}
            disabled={patchMutation.isPending}
            onChange={(event) =>
              patchMutation.mutate({ assigneeId: event.target.value || null })
            }
            options={[
              { value: "", label: "Non assegnato" },
              ...users.map((user) => ({ value: user.id, label: user.email })),
            ]}
          />

          <div className="flex flex-col gap-1.5">
            <span className="font-mono text-[11px] font-medium tracking-[0.14em] text-fg-muted uppercase">
              Label
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
            <MetaRow label="Creato" value={formatDateTime(ticket.createdAt)} />
            <MetaRow label="Aggiornato" value={formatDateTime(ticket.updatedAt)} />
            <MetaRow label="Ultimo visto" value={formatDateTime(ticket.lastSeenAt)} />
            <MetaRow label="Occorrenze" value={String(ticket.occurrences)} />
          </dl>
        </aside>
      </div>
    </div>
  );
}

const sectionTitleClass =
  "mb-3 font-mono text-[11px] font-medium tracking-[0.16em] text-fg-muted uppercase";

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="font-mono text-[11px] tracking-[0.1em] text-fg-faint uppercase">{label}</dt>
      <dd className="font-mono text-[12px] text-fg-muted">{value}</dd>
    </div>
  );
}
