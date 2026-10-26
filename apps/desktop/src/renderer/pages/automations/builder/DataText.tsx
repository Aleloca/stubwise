import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";
import {
  ancestorsAt,
  availableFields,
  childLists,
  scopeAt,
  triggerFields,
} from "../../../domain/automations/fields";
import { WAIT_REPLY_FIELDS } from "../../../domain/automations/triggerFields";
import type { AutomationFlow, DataField } from "../../../data/types";
import { CriticalGlyph } from "../glyphs";
import { useBuilder } from "./context";
import { producerOf } from "./issues";

// Il «campo con dati» (shape builder §6): un testo in cui i dati sono
// gettoni atomici (tinta ink 6%, raggio 4px; Backspace li toglie interi). Si
// scrive normalmente; «{» o «+ Insert data» apre il DataPicker con i soli
// dati che `availableFields` dà in quel punto. Il valore resta il modello
// del flusso, con `{{chiave}}`: le chiavi non si vedono mai (tooltip a
// parte). Un gettone non più disponibile è barrato, `critical`, col perché.

const REF = /\{\{\s*([^{}]+?)\s*\}\}/g;

/** Il nome di un dato come si legge: «task › Titolo» per i campi dell'elemento di un ciclo. */
export function tokenLabel(
  flow: AutomationFlow,
  key: string,
  labels: Map<string, DataField>,
): string {
  const label = labels.get(key)?.label ?? key.split(".").at(-1) ?? key;
  const as = asPrefixes(flow).find((a) => key.startsWith(`${a}.`));
  return as ? `${as} › ${label}` : label;
}

function asPrefixes(flow: AutomationFlow): string[] {
  const out: string[] = [];
  const walk = (steps: AutomationFlow["steps"]) => {
    for (const s of steps) {
      if (s.kind === "forEach" && s.as) out.push(s.as);
      for (const child of childLists(s)) walk(child.steps);
    }
  };
  walk(flow.steps);
  return out;
}

/** Il testo del campo dal DOM: testo e gettoni (`data-ref`) → modello `{{chiave}}`. */
function serialize(el: HTMLElement): string {
  let out = "";
  el.childNodes.forEach((n) => {
    if (n.nodeType === Node.TEXT_NODE) out += n.textContent ?? "";
    else if (n instanceof HTMLElement && n.dataset.ref) out += `{{${n.dataset.ref}}}`;
    else if (n instanceof HTMLBRElement) out += "\n";
    else if (n instanceof HTMLElement)
      out += (n.tagName === "DIV" && out ? "\n" : "") + serialize(n);
  });
  return out;
}

const TOKEN_BASE =
  "mx-px inline-flex items-center gap-1 rounded-[4px] px-1 align-baseline text-md leading-5";
const TOKEN = `${TOKEN_BASE} bg-ink/6 text-ink`;
const BAD_TOKEN = `${TOKEN_BASE} bg-critical/10 text-critical line-through decoration-critical`;

export function DataText({
  value,
  onChange,
  path,
  label,
  multiline = false,
  rows = 1,
  describedBy,
  invalid = false,
  types,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Il percorso del passo (o "trigger"): i dati inseribili sono quelli di quel punto. */
  path: string;
  label: string;
  multiline?: boolean;
  rows?: number;
  describedBy?: string;
  invalid?: boolean;
  /** Solo dati di questi tipi (il destinatario di un'email: indirizzi e persone). */
  types?: DataField["type"][];
}) {
  const { t } = useTranslation();
  const b = useBuilder();
  const ref = useRef<HTMLDivElement>(null);
  const range = useRef<Range | null>(null);
  const [picking, setPicking] = useState(false);
  const available = useMemo(
    () =>
      new Set(availableFields(b.flow, path === "trigger" ? "" : path, b.sources).map((f) => f.key)),
    [b.flow, b.sources, path],
  );

  // Il DOM si riscrive solo quando il valore arriva da fuori: mentre si
  // scrive, il cursore resta dov'è; i gettoni si aggiornano sul posto (un
  // dato che non è più disponibile dopo uno spostamento).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (serialize(el) === value) {
      el.querySelectorAll<HTMLElement>("[data-ref]").forEach((n) => {
        const fresh = tokenNode(n.dataset.ref!);
        if (fresh.outerHTML !== n.outerHTML) n.replaceWith(fresh);
      });
      return;
    }
    el.replaceChildren();
    let last = 0;
    for (const m of value.matchAll(REF)) {
      if (m.index! > last) el.append(document.createTextNode(value.slice(last, m.index)));
      el.append(tokenNode(m[1]!));
      last = m.index! + m[0].length;
    }
    if (last < value.length) el.append(document.createTextNode(value.slice(last)));
  });

  function tokenNode(key: string): HTMLElement {
    const span = document.createElement("span");
    span.contentEditable = "false";
    span.dataset.ref = key;
    const ok = available.has(key);
    span.className = ok ? TOKEN : BAD_TOKEN;
    if (!ok) span.setAttribute("data-unavailable", "");
    const f = b.labels.get(key);
    const from = producerOf(b.flow, key);
    const n = from ? b.numbers.get(from.path) : undefined;
    span.title = ok
      ? t("automations.builder.data.tokenTitle", {
          type: f ? t(`automations.builder.types.${f.type}`) : "",
        })
      : n !== undefined
        ? t("automations.builder.data.laterOrElsewhere", { n })
        : t("automations.builder.data.gone");
    span.textContent = tokenLabel(b.flow, key, b.labels);
    return span;
  }

  const commit = () => {
    const el = ref.current;
    if (!el) return;
    const next = serialize(el);
    if (next !== value) onChange(next);
  };

  const saveRange = () => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && ref.current?.contains(sel.anchorNode))
      range.current = sel.getRangeAt(0).cloneRange();
  };

  const insert = (key: string) => {
    const el = ref.current;
    setPicking(false);
    if (!el) return;
    const node = tokenNode(key);
    const r = range.current;
    if (r && el.contains(r.startContainer)) {
      r.deleteContents();
      r.insertNode(node);
      r.setStartAfter(node);
      r.collapse(true);
    } else el.append(node);
    const after = document.createTextNode("");
    node.after(after);
    commit();
    el.focus();
    const sel = window.getSelection();
    if (sel) {
      const caret = document.createRange();
      caret.setStart(after, 0);
      caret.collapse(true);
      sel.removeAllRanges();
      sel.addRange(caret);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "{") {
      e.preventDefault();
      saveRange();
      setPicking(true);
    } else if (e.key === "Enter" && !multiline) e.preventDefault();
  };

  const minHeight = multiline ? `${Math.max(rows, 2) * 20 + 12}px` : undefined;
  return (
    <div className="relative">
      <div className="flex items-start gap-1">
        <div
          ref={ref}
          role="textbox"
          aria-label={label}
          aria-multiline={multiline}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          aria-readonly={b.readOnly || undefined}
          contentEditable={!b.readOnly}
          suppressContentEditableWarning
          tabIndex={0}
          data-data-text
          onInput={commit}
          onBlur={() => {
            saveRange();
            commit();
          }}
          onKeyUp={saveRange}
          onMouseUp={saveRange}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            e.preventDefault();
            const text = e.clipboardData.getData("text/plain");
            document.execCommand?.(
              "insertText",
              false,
              multiline ? text : text.replace(/\n/g, " "),
            );
            commit();
          }}
          style={{ minHeight }}
          className={`min-w-0 flex-1 rounded-md border bg-ground px-2 py-1.5 text-md break-words whitespace-pre-wrap text-ink transition-colors duration-[var(--duration-fast)] ease-out focus-visible:border-transparent ${multiline ? "max-h-[252px] overflow-y-auto" : ""} ${invalid ? "border-critical" : "border-rule-strong hover:border-ink/40"} ${b.readOnly ? "text-ink-muted" : ""}`}
        />
        {!b.readOnly && (
          <button
            type="button"
            aria-haspopup="dialog"
            aria-expanded={picking}
            aria-label={t("automations.builder.data.insertInto", { field: label })}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              saveRange();
              setPicking((p) => !p);
            }}
            className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs font-medium text-ink-muted hover:bg-ink/6 hover:text-ink"
          >
            {t("automations.builder.data.insert")}
          </button>
        )}
      </div>
      {picking && (
        <DataPicker
          path={path}
          types={types}
          onPick={insert}
          onClose={() => {
            setPicking(false);
            ref.current?.focus();
          }}
        />
      )}
    </div>
  );
}

/** Da dove viene un dato (il gruppo del DataPicker). */
interface Group {
  key: string;
  title: string;
  fields: DataField[];
}

/** I dati di un punto, raggruppati per provenienza: l'inizio, un passo di Claude, un ciclo, un'attesa. */
export function useFieldGroups(path: string): Group[] {
  const { t } = useTranslation();
  const b = useBuilder();
  return useMemo(() => {
    const p = path === "trigger" ? "" : path;
    const fields = availableFields(b.flow, p, b.sources);
    const start = new Set(triggerFields(b.flow, b.sources).map((f) => f.key));
    const scope = scopeAt(b.flow, p, b.sources);
    const around = [...ancestorsAt(b.flow.steps, p), ...scope.preceding];
    const groups = new Map<string, Group>();
    const add = (key: string, title: string, f: DataField) => {
      if (!groups.has(key)) groups.set(key, { key, title, fields: [] });
      groups.get(key)!.fields.push(f);
    };
    const reply = new Set(WAIT_REPLY_FIELDS.map((f) => f.key));
    for (const f of fields) {
      if (start.has(f.key)) {
        add("start", t("automations.builder.data.fromStart"), f);
        continue;
      }
      const loop = around.find(
        (s) => s.kind === "forEach" && (f.key === s.as || f.key.startsWith(`${s.as}.`)),
      );
      const owner =
        loop ??
        [...around]
          .reverse()
          .find(
            (s) =>
              (s.kind === "claude" && s.fields.some((x) => x.key === f.key)) ||
              (s.kind === "wait" && "replyTo" in s.for && reply.has(f.key)),
          );
      if (!owner) {
        add("other", t("automations.builder.data.other"), f);
        continue;
      }
      const n = b.numbers.get(b.paths.get(owner.id) ?? "") ?? 0;
      const title =
        owner.kind === "forEach"
          ? t("automations.builder.data.fromLoop", { as: owner.as })
          : t(`automations.builder.data.fromStep.${owner.kind}`, { n });
      add(owner.id, title, f);
    }
    return [...groups.values()];
  }, [b.flow, b.sources, b.numbers, b.paths, path, t]);
}

/** Un valore d'esempio dall'ultimo evento della sorgente («Rossi Srl»). */
export function sampleOf(event: Record<string, unknown> | undefined, key: string): string | null {
  let v: unknown = event;
  for (const part of key.split(".")) {
    if (v && typeof v === "object" && part in (v as object))
      v = (v as Record<string, unknown>)[part];
    else return null;
  }
  if (v === null || v === undefined || typeof v === "object") return null;
  return String(v);
}

function DataPicker({
  path,
  types,
  onPick,
  onClose,
}: {
  path: string;
  types?: DataField["type"][];
  onPick: (key: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const b = useBuilder();
  const groups = useFieldGroups(path);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const box = useRef<HTMLDivElement>(null);
  const sample = useMemo(() => {
    const tr = b.flow.trigger;
    return tr.kind === "source"
      ? (b.sources.find((s) => s.id === tr.sourceId)?.sampleEvents.at(-1) ?? undefined)
      : undefined;
  }, [b.flow.trigger, b.sources]);
  const needle = q.trim().toLowerCase();
  const shown = groups
    .map((g) => ({
      ...g,
      fields: g.fields.filter(
        (f) =>
          (!types || types.includes(f.type)) &&
          (!needle || tokenLabel(b.flow, f.key, b.labels).toLowerCase().includes(needle)),
      ),
    }))
    .filter((g) => g.fields.length > 0);
  const flat = shown.flatMap((g) => g.fields);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (box.current && !box.current.parentElement?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [onClose]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, flat.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const f = flat[active];
      if (f) onPick(f.key);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  let i = -1;
  return (
    <div
      ref={box}
      role="dialog"
      aria-label={t("automations.builder.data.pickerTitle")}
      className="menu-enter absolute right-0 z-30 mt-1 flex max-h-96 w-80 flex-col rounded-lg border border-rule-strong bg-surface shadow-[0_12px_32px_-8px_oklch(0_0_0/0.4)]"
    >
      <input
        autoFocus
        role="combobox"
        aria-expanded
        aria-controls={listId}
        aria-activedescendant={flat[active] ? `${listId}-${active}` : undefined}
        aria-label={t("automations.builder.data.search")}
        placeholder={t("automations.builder.data.search")}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
        className="h-9 shrink-0 border-b border-rule bg-transparent px-3 text-md text-ink outline-none placeholder:text-ink-faint"
      />
      <div id={listId} role="listbox" className="flex min-h-0 flex-col overflow-y-auto p-1.5">
        {shown.length === 0 && (
          <p className="px-2 py-2 text-sm text-ink-muted">{t("automations.builder.data.none")}</p>
        )}
        {shown.map((g) => (
          <div key={g.key} role="group" aria-label={g.title} className="flex flex-col">
            <p aria-hidden="true" className="heading-group px-2 pt-2 pb-1">
              {g.title}
            </p>
            {g.fields.map((f) => {
              i += 1;
              const me = i;
              const example = start(g.key) ? sampleOf(sample, f.key) : null;
              return (
                <div
                  key={f.key}
                  id={`${listId}-${me}`}
                  role="option"
                  aria-selected={me === active}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onPick(f.key)}
                  onMouseEnter={() => setActive(me)}
                  className={`flex min-h-8 cursor-default items-baseline gap-2 rounded-md px-2 py-1 text-sm ${me === active ? "bg-ink/8" : ""}`}
                >
                  <span className="min-w-0 flex-1 truncate text-ink">
                    {tokenLabel(b.flow, f.key, b.labels)}
                  </span>
                  <span className="shrink-0 text-xs text-ink-muted">
                    {t(`automations.builder.types.${f.type}`)}
                  </span>
                  {example && (
                    <span className="max-w-24 shrink-0 truncate text-xs text-ink-faint">
                      {example}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

const start = (key: string) => key === "start";

/** Un problema sotto un campo (`aria-describedby`): parola + icona, mai solo colore. */
export function FieldError({ id, children }: { id: string; children: string }) {
  return (
    <p id={id} className="flex items-start gap-1.5 pt-1 text-sm text-critical">
      <CriticalGlyph />
      <span>{children}</span>
    </p>
  );
}
