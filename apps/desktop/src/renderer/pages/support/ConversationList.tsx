import { useEffect, useId, useRef, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { SupportConversationView, SupportState } from "../../data/queries";
import { fold } from "../../domain/textSearch";
import { Chevron, RadioItem } from "../../tasks-ui/Menu";
import { PageEmpty } from "../../tasks-ui/PageStates";
import { whenLabel } from "../mail/format";
import { MenuButton } from "../tasks/controls";
import {
  ChannelGlyph,
  customerName,
  sinceWords,
  STATE_ORDER,
  stateWord,
  WaitingSince,
} from "./format";

// L'elenco delle conversazioni (shape support.md §3, [A 2]): raggruppato per
// stato, non cronologico — la domanda è «chi aspetta noi?». Righe di 64 px a
// due linee; il punto «ti aspetta» solo su «aspetta noi» e solo per chi può
// rispondere. Un `listbox` raggruppato: J/K (e le frecce) scorrono, Invio apre.

export type ChannelFilter = "any" | SupportConversationView["channel"];

/** Ci si è mossi con J/K: la riga selezionata riprende il fuoco quando c'è. */
let keysMoved = false;

export function matches(c: SupportConversationView, q: string, channel: ChannelFilter): boolean {
  if (channel !== "any" && c.channel !== channel) return false;
  const needle = fold(q.trim());
  if (!needle) return true;
  return [c.code, c.customer.name, c.lastMessage?.body ?? "", c.request?.description ?? ""].some(
    (f) => fold(f).includes(needle),
  );
}

function lastLine(c: SupportConversationView, me: string, t: (k: string) => string): string {
  const last = c.lastMessage;
  if (!last) return "";
  if (last.from === "customer") return last.body;
  const who =
    last.from === "triage"
      ? t("support.list.assistant")
      : last.authorId === me
        ? t("support.list.you")
        : null;
  return who ? `${who}: ${last.body}` : last.body;
}

function Row({
  c,
  me,
  selected,
  personName,
  onOpen,
}: {
  c: SupportConversationView;
  me: string;
  selected: boolean;
  personName: (id: string | null) => string | null;
  onOpen: (code: string, how: "click" | "keys") => void;
}) {
  const { t, i18n } = useTranslation();
  const waiting = c.state === "waiting_us";
  const dot = waiting && c.canReply;
  const name = customerName(c, t);
  const last = c.lastMessage;
  const teamName = last?.from === "team" && last.authorId !== me ? personName(last.authorId) : null;
  const line = teamName ? `${teamName}: ${last!.body}` : lastLine(c, me, t);
  const label = [
    dot ? t("support.list.waitingYou") : null,
    c.code,
    name,
    t(`support.channel.${c.channel}`),
    stateWord(c.state, t),
    waiting && c.waitingSince
      ? t("support.waiting", { time: sinceWords(c.waitingSince, t) })
      : null,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <div
      role="option"
      aria-selected={selected}
      aria-label={label}
      tabIndex={selected ? 0 : -1}
      data-support-row={c.code}
      onClick={() => onOpen(c.code, "click")}
      className="flex h-16 shrink-0 cursor-default flex-col justify-center gap-0.5 border-b border-rule px-4 outline-none transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus aria-selected:bg-ink/10"
    >
      <div className="flex min-w-0 items-center gap-2 text-md">
        <span
          aria-hidden="true"
          className={`size-2 shrink-0 rounded-full ${dot ? "bg-ink" : "bg-transparent"}`}
        />
        <span className="num shrink-0 text-xs font-semibold tracking-[0.02em] text-ink">
          {c.code}
        </span>
        <span
          title={name}
          className={`min-w-0 flex-1 truncate ${waiting ? "font-semibold" : ""} text-ink`}
        >
          {name}
        </span>
        <ChannelGlyph channel={c.channel} />
        {waiting && c.waitingSince ? (
          <WaitingSince since={c.waitingSince} />
        ) : (
          last && (
            <span className="num shrink-0 text-xs text-ink-muted">
              {whenLabel(last.at, i18n.language)}
            </span>
          )
        )}
      </div>
      <div className="flex min-w-0 items-center gap-1.5 pl-4 text-xs">
        <span className="shrink-0 font-medium text-ink">{stateWord(c.state, t)}</span>
        {line && (
          <span aria-hidden="true" className="text-ink-faint">
            ·
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-ink-muted">{line}</span>
      </div>
    </div>
  );
}

export function ConversationList({
  conversations,
  me,
  selectedCode,
  query,
  setQuery,
  channel,
  setChannel,
  onOpen,
  personName,
  empty,
}: {
  conversations: SupportConversationView[];
  me: string;
  selectedCode: string | null;
  query: string;
  setQuery: (q: string) => void;
  channel: ChannelFilter;
  setChannel: (c: ChannelFilter) => void;
  onOpen: (code: string, how: "click" | "keys") => void;
  personName: (id: string | null) => string | null;
  /** Il vuoto della pagina (nessuna conversazione): lo sceglie chi sa i permessi. */
  empty: React.ReactNode;
}) {
  const { t } = useTranslation();
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const shown = conversations.filter((c) => matches(c, query, channel));
  const groups = STATE_ORDER.map((state) => ({
    state,
    rows: shown.filter((c) => c.state === state),
  })).filter((g) => g.rows.length > 0);
  const flat = groups.flatMap((g) => g.rows);
  const filtered = query.trim() !== "" || channel !== "any";
  useEffect(() => {
    if (!keysMoved || !selectedCode) return;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-support-row="${selectedCode}"]`);
    if (row) {
      keysMoved = false;
      row.focus();
    }
  }, [selectedCode, flat.length]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const down = e.key === "ArrowDown" || e.key.toLowerCase() === "j";
    const up = e.key === "ArrowUp" || e.key.toLowerCase() === "k";
    if (!down && !up && e.key !== "Enter") return;
    e.preventDefault();
    const at = flat.findIndex((c) => c.code === selectedCode);
    if (e.key === "Enter") {
      if (at >= 0) onOpen(flat[at]!.code, "click");
      return;
    }
    const next = flat[Math.min(flat.length - 1, Math.max(0, at + (down ? 1 : -1)))];
    if (!next) return;
    // Si apre l'altra conversazione (l'indirizzo cambia, la pagina si
    // rimonta): il fuoco torna sulla sua riga appena c'è.
    keysMoved = true;
    onOpen(next.code, "keys");
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-rule px-3">
        <input
          type="search"
          aria-label={t("support.list.search")}
          placeholder={t("support.list.search")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="h-7 min-w-0 flex-1 rounded-md bg-transparent px-1 text-sm text-ink outline-none placeholder:text-ink-faint focus-visible:outline-2 focus-visible:outline-focus"
        />
        <MenuButton
          menuLabel={t("support.list.channel")}
          align="right"
          className={`inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-medium transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 aria-expanded:bg-ink/10 ${channel === "any" ? "text-ink-muted" : "bg-ink/10 text-ink"}`}
          label={
            <>
              {channel === "any"
                ? t("support.list.channel")
                : `${t("support.list.channel")}: ${t(`support.channel.${channel}`)}`}
              <Chevron />
            </>
          }
        >
          {(close) =>
            (["any", "widget", "mcp"] as const).map((c) => (
              <RadioItem key={c} checked={channel === c} onSelect={() => (setChannel(c), close())}>
                {c === "any" ? t("support.list.any") : t(`support.channel.${c}`)}
              </RadioItem>
            ))
          }
        </MenuButton>
      </div>
      {conversations.length === 0 ? (
        empty
      ) : shown.length === 0 && filtered ? (
        <PageEmpty
          title={t("support.list.nothing")}
          action={
            <button
              type="button"
              onClick={() => {
                setQuery("");
                setChannel("any");
              }}
              className="inline-flex h-8 items-center rounded-md border border-rule-strong px-3 text-sm font-medium text-ink hover:bg-ink/6"
            >
              {t("support.list.clear")}
            </button>
          }
        />
      ) : (
        <div
          ref={listRef}
          role="listbox"
          id={listId}
          aria-label={t("support.list.label")}
          onKeyDown={onKeyDown}
          tabIndex={selectedCode ? -1 : 0}
          className="min-h-0 flex-1 overflow-y-auto outline-none"
        >
          {groups.map((g) => (
            <div key={g.state} role="group" aria-labelledby={`${listId}-${g.state}`}>
              <div
                id={`${listId}-${g.state}`}
                className="heading-group flex h-8 items-center gap-2 border-b border-rule bg-ground px-4"
              >
                {stateWord(g.state as SupportState, t)}
                <span className="num font-normal tracking-normal text-ink-faint">
                  {g.rows.length}
                </span>
              </div>
              {g.rows.map((c) => (
                <Row
                  key={c.code}
                  c={c}
                  me={me}
                  selected={c.code === selectedCode}
                  personName={personName}
                  onOpen={onOpen}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
