import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { usePeople } from "../../data/queries";
import type { ChatMessage } from "../../data/types";
import { EMOJI, searchEmoji } from "./emoji";

// Le reazioni sotto un messaggio: gettoni alti 24px (emoji + conteggio
// tabellare), la mia con la tinta d'inchiostro e il bordo forte; un clic
// mette o toglie, il passaggio dice chi. Vanno a capo: 40 reazioni diverse
// non allargano mai la pagina. Il «+» apre il selettore.

/** «Giulia Ferri, Marco Bellini and 3 others reacted with 👍» (chi guarda è «You»). */
export function useReactionWho(): (
  emoji: string,
  personIds: readonly string[],
  me: string,
) => string {
  const { t } = useTranslation();
  const people = usePeople().data;
  return (emoji, personIds, me) => {
    const names = personIds.map((id) =>
      id === me ? t("chat.reactions.you") : (people?.find((p) => p.id === id)?.name ?? ""),
    );
    const shown = names.slice(0, 2).join(", ");
    return names.length > 2
      ? t("chat.reactions.whoMany", { names: shown, count: names.length - 2, emoji })
      : t("chat.reactions.who", { names: shown, emoji });
  };
}

export function Reactions({
  reactions,
  viewerId,
  canReact,
  onToggle,
  onAdd,
}: {
  reactions: ChatMessage["reactions"];
  viewerId: string;
  /** Membro di un canale scrivibile: altrimenti i gettoni si leggono soltanto. */
  canReact: boolean;
  onToggle: (emoji: string) => void;
  /** Il «+»: apre il selettore. */
  onAdd: () => void;
}) {
  const { t } = useTranslation();
  const who = useReactionWho();
  if (reactions.length === 0) return null;
  return (
    <ul aria-label={t("chat.reactions.list")} className="flex min-w-0 flex-wrap gap-1 pt-1">
      {reactions.map((r) => {
        const mine = r.personIds.includes(viewerId);
        const label = who(r.emoji, r.personIds, viewerId);
        return (
          <li key={r.emoji}>
            <button
              type="button"
              aria-pressed={mine}
              aria-label={label}
              title={label}
              disabled={!canReact}
              data-reaction={r.emoji}
              onClick={() => onToggle(r.emoji)}
              className={`inline-flex h-6 items-center gap-1 rounded-md border px-1.5 text-sm transition-colors duration-[var(--duration-fast)] ease-out disabled:cursor-default ${
                mine
                  ? "border-rule-strong bg-ink/10 text-ink"
                  : "border-rule text-ink-muted enabled:hover:border-rule-strong enabled:hover:bg-ink/5"
              }`}
            >
              <span aria-hidden="true" className="text-sm leading-none">
                {r.emoji}
              </span>
              <span aria-hidden="true" className="num text-xs font-semibold">
                {r.personIds.length}
              </span>
            </button>
          </li>
        );
      })}
      {canReact && (
        <li className="opacity-0 transition-opacity duration-[var(--duration-fast)] group-has-[:focus-visible]/message:opacity-100 group-hover/message:opacity-100">
          <button
            type="button"
            aria-label={t("chat.reactions.add")}
            title={t("chat.reactions.add")}
            onClick={onAdd}
            className="inline-flex h-6 items-center rounded-md border border-rule px-1.5 text-ink-muted hover:border-rule-strong hover:text-ink focus-visible:opacity-100"
          >
            <PlusFaceGlyph />
          </button>
        </li>
      )}
    </ul>
  );
}

function PlusFaceGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      width={14}
      height={14}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M13.5 7.2A5.6 5.6 0 1 1 8.8 2.5" />
      <path d="M5.8 9.6c.6.7 1.3 1 2.2 1s1.6-.3 2.2-1M6 6.5h.01M10 6.5h.01M12.5 1.5v4M10.5 3.5h4" />
    </svg>
  );
}

/**
 * Il selettore delle reazioni: in testa le 6 più usate da chi guarda, poi
 * la griglia per categoria; la ricerca filtra per parola. Esc lo chiude e
 * rende il fuoco a chi l'ha aperto (lo fa il chiamante con `onClose`).
 */
export function ReactionPicker({
  frequent,
  placement = "below",
  onPick,
  onClose,
}: {
  frequent: readonly string[];
  /** Sopra il messaggio quando sotto non c'è posto (la metà bassa della finestra). */
  placement?: "below" | "above";
  onPick: (emoji: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const titleId = useId();
  useEffect(() => {
    field.current?.focus();
    const onPointer = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [onClose]);
  const found = searchEmoji(q);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };
  const grid = (list: readonly string[], label: string) => (
    <div key={label} role="group" aria-label={label} className="flex flex-col gap-1">
      <span aria-hidden="true" className="heading-group px-1 pt-1">
        {label}
      </span>
      <div className="grid grid-cols-8 gap-0.5">
        {list.map((emoji) => (
          <button
            key={emoji}
            type="button"
            aria-label={emoji}
            onClick={() => onPick(emoji)}
            className="grid size-8 place-items-center rounded-md text-lg leading-none hover:bg-ink/8 focus-visible:bg-ink/8"
          >
            {emoji}
          </button>
        ))}
      </div>
    </div>
  );
  return (
    <div
      ref={root}
      role="dialog"
      aria-labelledby={titleId}
      onKeyDown={onKeyDown}
      data-reaction-picker
      className={`menu-enter absolute right-0 z-40 ${placement === "above" ? "bottom-full mb-1" : "top-full mt-1"} flex max-h-80 w-[300px] max-w-[calc(100vw-32px)] flex-col gap-2 overflow-y-auto rounded-lg border border-rule-strong bg-surface p-2 shadow-[0_12px_32px_-8px_oklch(0_0_0/0.4)]`}
    >
      <span id={titleId} className="sr-only">
        {t("chat.reactions.picker")}
      </span>
      <input
        ref={field}
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        aria-label={t("chat.reactions.search")}
        placeholder={t("chat.reactions.search")}
        className="block h-8 w-full shrink-0 appearance-none rounded-md border border-rule-strong bg-transparent px-2 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-ink/45"
      />
      {q.trim() ? (
        found.length > 0 ? (
          grid(found, t("chat.reactions.results"))
        ) : (
          <p className="px-1 py-2 text-sm text-ink-muted">{t("chat.reactions.noResults")}</p>
        )
      ) : (
        <>
          {grid(frequent, t("chat.reactions.frequent"))}
          {EMOJI.map((c) =>
            grid(
              c.items.map(([e]) => e),
              t(`chat.reactions.categories.${c.id}`),
            ),
          )}
        </>
      )}
    </div>
  );
}
