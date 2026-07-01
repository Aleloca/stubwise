import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { TicketLinkKind, TicketLinkView, TicketListItem, TicketRelation } from "../lib/api";
import { createTicketLink, deleteTicketLink, listTickets } from "../lib/api";
import { ticketKeys, ticketLinksQueryOptions } from "../lib/queries";
import { StatusBadge } from "./badges";
import { FormError, SelectField, TextField } from "./field";

interface TicketLinksProps {
  ticketId: string;
  /** Progetto del ticket corrente: filtra la ricerca dei target nel picker. */
  projectId: string;
}

/** Chiave i18n della label per ogni relazione mostrata (scala a 5 valori). */
const RELATION_LABEL_KEYS: Record<TicketRelation, string> = {
  blocks: "tickets:links.relations.blocks",
  blocked_by: "tickets:links.relations.blocked_by",
  relates_to: "tickets:links.relations.relates_to",
  parent: "tickets:links.relations.parent",
  child: "tickets:links.relations.child",
};

/** Le 3 kind canoniche creabili dall'utente (non le inverse). */
const CREATABLE_KINDS: TicketLinkKind[] = ["blocks", "relates_to", "parent"];

/**
 * Sezione "Ticket collegati" del dettaglio: elenca i link risolti (etichettati
 * per relazione, con stato del ticket "altro" e rimozione inline) e offre un
 * picker per crearne di nuovi cercando un target nello stesso progetto. Create
 * e delete invalidano sia i link sia il feed di attività (ogni link genera un
 * evento di audit).
 */
export function TicketLinks({ ticketId, projectId }: TicketLinksProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: links } = useSuspenseQuery(ticketLinksQueryOptions(ticketId));
  const [pickerOpen, setPickerOpen] = useState(false);
  // Conferma inline a due click: tiene l'id del link "in attesa di conferma".
  // Cliccare remove su un'altra riga sposta la conferma (resetta la precedente).
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ticketKeys.links(ticketId) });
    void queryClient.invalidateQueries({ queryKey: ticketKeys.activity(ticketId) });
  };

  const createMutation = useMutation({
    mutationFn: (link: { targetTicketId: string; kind: TicketLinkKind }) =>
      createTicketLink(ticketId, link),
    onSuccess: () => {
      invalidate();
      setPickerOpen(false);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (linkId: string) => deleteTicketLink(ticketId, linkId),
    onSuccess: () => {
      setConfirmingId(null);
      invalidate();
    },
  });

  // Primo click: arma la conferma sulla riga. Secondo click sulla stessa riga
  // (già in attesa): esegue la DELETE. Cliccare un'altra riga sposta la conferma.
  const handleRemove = (linkId: string) => {
    if (confirmingId === linkId) {
      deleteMutation.mutate(linkId);
    } else {
      setConfirmingId(linkId);
    }
  };

  return (
    <div className="space-y-3">
      {links.length === 0 ? (
        <p className="font-mono text-[12px] text-fg-faint">{t("tickets:links.empty")}</p>
      ) : (
        <ul className="space-y-2">
          {links.map((link) => (
            <LinkRow
              key={link.linkId}
              link={link}
              onRemove={() => handleRemove(link.linkId)}
              confirming={confirmingId === link.linkId}
              removing={deleteMutation.isPending && confirmingId === link.linkId}
            />
          ))}
        </ul>
      )}

      {deleteMutation.isError && (
        <FormError message={deleteMutation.error.message} />
      )}

      {pickerOpen ? (
        <LinkPicker
          ticketId={ticketId}
          projectId={projectId}
          existing={links}
          pending={createMutation.isPending}
          error={createMutation.isError ? createMutation.error.message : null}
          onCancel={() => setPickerOpen(false)}
          onConfirm={(targetTicketId, kind) =>
            createMutation.mutate({ targetTicketId, kind })
          }
        />
      ) : (
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          className="rounded-sm border border-line-strong px-3 py-1.5 font-mono text-[12px] font-semibold tracking-[0.08em] text-fg-muted uppercase transition-colors hover:border-signal-dim hover:text-signal"
        >
          {t("tickets:links.addLink")}
        </button>
      )}
    </div>
  );
}

/** Riga di un link: relazione + link al ticket, badge stato e rimozione. */
function LinkRow({
  link,
  onRemove,
  confirming,
  removing,
}: {
  link: TicketLinkView;
  onRemove: () => void;
  /** La riga è in attesa del secondo click di conferma. */
  confirming: boolean;
  removing: boolean;
}) {
  const { t } = useTranslation();
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-sm border border-line bg-ink-900 px-3 py-2">
      <span className="font-mono text-[10px] tracking-[0.12em] text-fg-faint uppercase">
        {t(RELATION_LABEL_KEYS[link.relation])}
      </span>
      <Link
        to="/tickets/$id"
        params={{ id: link.otherTicketId }}
        className="min-w-0 truncate text-sm text-fg transition-colors hover:text-signal"
      >
        <span className="font-mono text-signal">#{link.otherNumber}</span> {link.otherTitle}
      </Link>
      <StatusBadge status={link.otherStatus} />
      <button
        type="button"
        onClick={onRemove}
        disabled={removing}
        aria-label={t("tickets:links.removeLink", { number: link.otherNumber })}
        aria-pressed={confirming}
        className={`ml-auto rounded-sm px-1.5 py-0.5 font-mono text-[11px] tracking-[0.08em] uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
          confirming
            ? "text-danger underline decoration-dotted underline-offset-2"
            : "text-fg-faint hover:text-danger"
        }`}
      >
        {confirming ? t("tickets:links.confirmRemove") : t("tickets:links.remove")}
      </button>
    </li>
  );
}

/**
 * Picker di un nuovo link: ricerca per titolo nello stesso progetto (riusa la
 * lista ticket), esclude il ticket corrente e quelli già collegati, e fa
 * scegliere una delle 3 kind canoniche prima di confermare.
 */
function LinkPicker({
  ticketId,
  projectId,
  existing,
  pending,
  error,
  onCancel,
  onConfirm,
}: {
  ticketId: string;
  projectId: string;
  existing: TicketLinkView[];
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (targetTicketId: string, kind: TicketLinkKind) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<TicketLinkKind>("blocks");
  const [selected, setSelected] = useState<TicketListItem | null>(null);

  const trimmed = query.trim();
  const filters = { projectId, q: trimmed };
  const { data: page, isFetching } = useQuery({
    queryKey: ticketKeys.list(filters),
    queryFn: () => listTickets(filters, undefined, 10),
    enabled: trimmed.length > 0,
    staleTime: 5_000,
  });

  const linkedIds = new Set(existing.map((link) => link.otherTicketId));
  const results = (page?.items ?? []).filter(
    (ticket) => ticket.id !== ticketId && !linkedIds.has(ticket.id),
  );

  return (
    <div className="space-y-3 rounded-sm border border-line-strong bg-ink-900 p-3">
      <TextField
        id="link-search"
        label={t("tickets:links.picker.searchLabel")}
        value={query}
        placeholder={t("tickets:links.picker.searchPlaceholder")}
        onChange={(event) => {
          setQuery(event.target.value);
          setSelected(null);
        }}
      />

      {trimmed.length > 0 && (
        <div>
          {isFetching ? (
            <p className="font-mono text-[12px] text-fg-faint">
              {t("tickets:links.picker.searching")}
            </p>
          ) : results.length === 0 ? (
            <p className="font-mono text-[12px] text-fg-faint">
              {t("tickets:links.picker.noResults")}
            </p>
          ) : (
            <ul className="max-h-48 space-y-1 overflow-y-auto">
              {results.map((ticket) => (
                <li key={ticket.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(ticket)}
                    aria-pressed={selected?.id === ticket.id}
                    className={`flex w-full items-center gap-2 rounded-sm border px-2 py-1.5 text-left text-sm transition-colors ${
                      selected?.id === ticket.id
                        ? "border-signal-dim bg-signal/10 text-fg"
                        : "border-transparent text-fg-muted hover:bg-ink-850"
                    }`}
                  >
                    <span className="font-mono text-signal">#{ticket.number}</span>
                    <span className="min-w-0 truncate">{ticket.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <SelectField
        id="link-kind"
        label={t("tickets:links.picker.relationLabel")}
        value={kind}
        onChange={(event) => setKind(event.target.value as TicketLinkKind)}
        options={CREATABLE_KINDS.map((value) => ({
          value,
          label: t(`tickets:links.picker.kinds.${value}`),
        }))}
      />

      {selected && (
        <p className="font-mono text-[12px] text-fg-muted">
          {t("tickets:links.picker.selected", {
            number: selected.number,
            title: selected.title,
          })}
        </p>
      )}

      <FormError message={error} />

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={!selected || pending}
          onClick={() => selected && onConfirm(selected.id, kind)}
          className="rounded-sm bg-signal px-3 py-1.5 font-mono text-[12px] font-semibold tracking-[0.08em] text-ink-950 uppercase transition-colors hover:bg-signal-bright active:bg-signal-dim disabled:cursor-not-allowed disabled:bg-signal-dim disabled:opacity-60"
        >
          {pending ? t("tickets:links.picker.creating") : t("tickets:links.picker.confirm")}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-sm border border-line-strong px-3 py-1.5 font-mono text-[12px] font-semibold tracking-[0.08em] text-fg-muted uppercase transition-colors hover:border-fg-muted"
        >
          {t("tickets:links.picker.cancel")}
        </button>
      </div>
    </div>
  );
}
