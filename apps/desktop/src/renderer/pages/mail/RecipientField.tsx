import {
  useId,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import { useRecipientSuggestions } from "../../data/queries";
import type { MailAddress, MailRecipientSuggestion, Person } from "../../data/types";
import { CrossGlyph } from "../claude/conversation/parts";
import { AlertGlyph } from "./glyphs";

// Un campo destinatari della casella di scrittura (shape mail-compose §5):
// gettoni da 24 px (persona del team: avatar + nome; esterno: nome noto o
// indirizzo; non valido: contorno e icona `critical`), e un campo
// `combobox` con il completamento — TEAM e FROM YOUR MAIL, 8 righe al
// massimo, dal livello dati (`suggestRecipients`: mai indirizzi visti solo
// nella posta altrui). Virgola, punto e virgola, Enter o Tab trasformano
// l'indirizzo scritto in gettone; incollare un elenco crea più gettoni;
// Backspace a campo vuoto seleziona l'ultimo, un secondo lo toglie. Oltre
// 6 gettoni, a campo non a fuoco, una riga sola «X, Y and N others» [A 6].

/** Un indirizzo valido (la stessa forma che controlla l'invio). */
export const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Oltre questi gettoni, a campo non a fuoco, il campo si comprime [A 6]. */
const COLLAPSE_OVER = 6;

const lower = (email: string) => email.trim().toLowerCase();
const nameOf = (a: MailAddress) => a.name || a.email;

/** Aggiunge senza doppioni (lo stesso indirizzo due volte è un gettone solo). */
export function mergeAddresses(
  list: readonly MailAddress[],
  more: readonly MailAddress[],
): MailAddress[] {
  const out = [...list];
  for (const a of more) {
    if (!out.some((x) => lower(x.email) === lower(a.email))) out.push(a);
  }
  return out;
}

/** Un elenco scritto o incollato («a@x.it, b@y.it; c@z.it»): un indirizzo per pezzo. */
export function parseAddresses(text: string): MailAddress[] {
  return text
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((email) => ({ name: "", email, personId: null }));
}

function Token({
  address,
  person,
  selected,
  onRemove,
}: {
  address: MailAddress;
  person: Person | undefined;
  selected: boolean;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const valid = ADDRESS.test(address.email.trim());
  const name = nameOf(address);
  return (
    <li
      title={valid ? address.email : t("mail.compose.invalid")}
      data-token={address.email}
      data-selected={selected || undefined}
      className={`flex h-6 max-w-full min-w-0 items-center gap-1 rounded-md border pr-0.5 text-sm ${person ? "pl-0.5" : "pl-1.5"} ${
        valid ? "border-rule-strong text-ink" : "border-critical text-critical"
      } ${selected ? "bg-ink/10" : ""}`}
    >
      {!valid && <AlertGlyph size={12} />}
      {person && valid && (
        <span
          aria-hidden="true"
          className="grid size-4 shrink-0 place-items-center rounded-full bg-ink/10 text-[9px] font-semibold text-ink"
        >
          {person.initials}
        </span>
      )}
      <span aria-hidden="true" className="min-w-0 truncate">
        {name}
      </span>
      <span className="sr-only">
        {t("mail.compose.tokenHint", { name, email: address.email })}
        {selected && `, ${t("mail.compose.selected")}`}
      </span>
      <button
        type="button"
        tabIndex={-1}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onRemove}
        aria-label={t("mail.compose.removeRecipient", { name })}
        className="grid size-5 shrink-0 place-items-center rounded-[4px] text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink"
      >
        <CrossGlyph size={10} />
      </button>
    </li>
  );
}

export function RecipientField({
  label,
  value,
  onChange,
  people,
  inputRef,
  trailing,
}: {
  label: string;
  value: MailAddress[];
  onChange: (next: MailAddress[]) => void;
  people: ReadonlyMap<string, Person>;
  inputRef?: RefObject<HTMLInputElement | null>;
  /** A destra della riga («Cc» sulla riga A). */
  trailing?: ReactNode;
}) {
  const { t } = useTranslation();
  const id = useId();
  const ownRef = useRef<HTMLInputElement>(null);
  const input = inputRef ?? ownRef;
  const [q, setQ] = useState("");
  const [menu, setMenu] = useState(false);
  const [active, setActive] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const suggestions = useRecipientSuggestions(q.trim(), menu);

  const taken = new Set(value.map((a) => lower(a.email)));
  const options = (suggestions.data ?? []).filter((s) => !taken.has(lower(s.email)));
  const typedIsAddress = ADDRESS.test(q.trim());
  // Un indirizzo scritto per intero vince sul suggerimento, salvo che sia lo stesso.
  const current =
    typedIsAddress && !options.some((o) => lower(o.email) === lower(q))
      ? -1
      : Math.min(active, options.length - 1);
  const open = menu && q.trim().length > 0 && options.length > 0;
  const listId = `${id}-list`;
  const optionId = (i: number) => `${id}-opt-${i}`;

  const add = (more: MailAddress[]) => {
    onChange(mergeAddresses(value, more));
    setQ("");
    setMenu(false);
    setActive(0);
    setSelected(null);
  };
  const pick = (s: MailRecipientSuggestion) =>
    add([{ name: s.name, email: s.email, personId: s.personId }]);
  const commitTyped = () => {
    if (!q.trim()) return false;
    add(parseAddresses(q));
    return true;
  };
  const remove = (i: number) => {
    onChange(value.filter((_, k) => k !== i));
    setSelected(null);
    input.current?.focus();
  };

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      const delta = e.key === "ArrowDown" ? 1 : -1;
      setActive((a) => (Math.max(0, a) + delta + options.length) % options.length);
      return;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      if (e.metaKey || e.ctrlKey) return;
      if (open && current >= 0) {
        e.preventDefault();
        pick(options[current]!);
        return;
      }
      if (commitTyped() && e.key === "Enter") e.preventDefault();
      return;
    }
    if (e.key === "," || e.key === ";") {
      if (q.trim()) {
        e.preventDefault();
        commitTyped();
      }
      return;
    }
    if (e.key === "Escape") {
      // Prima il menu dei suggerimenti, poi il gettone scelto; poi la casella.
      if (open) {
        e.preventDefault();
        e.stopPropagation();
        setMenu(false);
      } else if (selected !== null) {
        e.preventDefault();
        e.stopPropagation();
        setSelected(null);
      }
      return;
    }
    if (e.key === "Backspace" && q === "" && value.length > 0) {
      e.preventDefault();
      if (selected === null) setSelected(value.length - 1);
      else remove(selected);
      return;
    }
    if (selected !== null) setSelected(null);
  }

  function onPaste(e: ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData("text");
    if (!/[,;\n]/.test(text)) return;
    e.preventDefault();
    add(parseAddresses(`${q}${text}`));
  }

  const invalid = value.some((a) => !ADDRESS.test(a.email.trim()));
  const collapsed = !focused && value.length > COLLAPSE_OVER;
  const allNames = value.map(nameOf);

  return (
    <div className="flex min-w-0 flex-col">
      <div
        className="relative flex min-h-8 min-w-0 items-start gap-2 border-b border-rule px-3"
        onClick={(e) => {
          if (e.target === e.currentTarget) input.current?.focus();
        }}
      >
        <label htmlFor={`${id}-input`} className="w-14 shrink-0 py-1.5 text-sm text-ink-muted">
          {label}
        </label>
        {collapsed ? (
          <button
            type="button"
            onClick={() => input.current?.focus()}
            aria-label={`${label}: ${allNames.join(", ")}`}
            className="min-w-0 flex-1 truncate py-1.5 text-left text-sm text-ink"
          >
            {t("mail.compose.andOthers", {
              names: allNames.slice(0, 2).join(", "),
              count: value.length - 2,
            })}
          </button>
        ) : null}
        <div
          className={`flex min-w-0 flex-1 flex-wrap items-center gap-1 py-1 ${collapsed ? "sr-only" : ""} ${
            focused ? "max-h-[124px] overflow-y-auto" : ""
          }`}
        >
          {value.length > 0 && (
            <ul aria-label={label} className="contents">
              {value.map((a, i) => (
                <Token
                  key={`${lower(a.email)}-${i}`}
                  address={a}
                  person={a.personId ? people.get(a.personId) : undefined}
                  selected={selected === i}
                  onRemove={() => remove(i)}
                />
              ))}
            </ul>
          )}
          <input
            ref={input}
            id={`${id}-input`}
            role="combobox"
            aria-label={label}
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={open && current >= 0 ? optionId(current) : undefined}
            autoComplete="off"
            spellCheck={false}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setMenu(true);
              setActive(0);
              setSelected(null);
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onFocus={() => setFocused(true)}
            onBlur={() => {
              setFocused(false);
              setMenu(false);
              setSelected(null);
              commitTyped();
            }}
            className="h-6 min-w-[120px] flex-1 bg-transparent text-md text-ink outline-none placeholder:text-ink-faint"
          />
        </div>
        {trailing && <div className="flex shrink-0 items-center py-1">{trailing}</div>}
        {open && (
          <div
            id={listId}
            role="listbox"
            aria-label={t("mail.compose.suggestions")}
            className="menu-enter absolute top-full left-[68px] z-30 mt-1 flex w-80 max-w-[calc(100%-80px)] flex-col rounded-lg border border-rule-strong bg-surface p-1.5 shadow-[0_12px_32px_-8px_oklch(0_0_0/0.4)]"
          >
            {(["team", "mail"] as const).map((group) => {
              const rows = options.map((o, i) => ({ o, i })).filter(({ o }) => o.group === group);
              if (rows.length === 0) return null;
              return (
                <div
                  key={group}
                  role="group"
                  aria-label={t(group === "team" ? "mail.compose.team" : "mail.compose.fromMail")}
                >
                  <p aria-hidden="true" className="heading-group px-2 pt-1.5 pb-1">
                    {t(group === "team" ? "mail.compose.team" : "mail.compose.fromMail")}
                  </p>
                  {rows.map(({ o, i }) => {
                    const person = o.personId ? people.get(o.personId) : undefined;
                    return (
                      <div
                        key={o.email}
                        id={optionId(i)}
                        role="option"
                        aria-selected={i === current}
                        onMouseDown={(e) => e.preventDefault()}
                        onMouseEnter={() => setActive(i)}
                        onClick={() => pick(o)}
                        className="flex min-h-9 cursor-default items-center gap-2.5 rounded-md px-2 py-1 text-sm aria-selected:bg-ink/8"
                      >
                        <span
                          aria-hidden="true"
                          className={`grid size-6 shrink-0 place-items-center rounded-full text-xs font-semibold text-ink ${person ? "bg-ink/10" : "bg-ink/6"}`}
                        >
                          {person?.initials ?? (o.name || o.email).charAt(0).toUpperCase()}
                        </span>
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate text-ink">{o.name || o.email}</span>
                          <span className="truncate text-xs text-ink-muted">{o.email}</span>
                        </span>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
      </div>
      {invalid && (
        <p className="flex items-center gap-1 border-b border-rule px-3 py-1 pl-[76px] text-xs text-critical">
          <AlertGlyph size={12} />
          {t("mail.compose.invalid")}
        </p>
      )}
    </div>
  );
}
