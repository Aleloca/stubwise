import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { Step } from "../../../data/types";
import { StepGlyph } from "../glyphs";
import { isBlock, MAX_DEPTH } from "./tree";

// Il menu dei passi (shape builder §6): 320px, cercabile, frecce/Enter. Ogni
// voce ha il nome e una riga di cosa fa; nessuna tavolozza di nodi. In una
// corsia di quinto livello i tipi con rami non ci sono, e una riga lo dice
// ([A 7]).

const GROUPS: { key: string; kinds: Step["kind"][] }[] = [
  {
    key: "do",
    kinds: [
      "createTask",
      "createMilestone",
      "createRequest",
      "sendEmail",
      "notify",
      "startAutomation",
    ],
  },
  { key: "wait", kinds: ["wait"] },
  { key: "claude", kinds: ["claude"] },
  { key: "branch", kinds: ["condition", "forEach", "repeatUntil"] },
];

export function AddStepMenu({
  anchor,
  depth,
  onPick,
  onClose,
}: {
  anchor: HTMLElement | null;
  /** La profondità della corsia in cui nasce il passo. */
  depth: number;
  onPick: (kind: Step["kind"]) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const deep = depth >= MAX_DEPTH;
  const needle = q.trim().toLowerCase();
  const groups = GROUPS.map((g) => ({
    ...g,
    kinds: g.kinds.filter(
      (k) =>
        !(deep && isBlock(k)) &&
        (!needle ||
          `${t(`automations.builder.kind.${k}`)} ${t(`automations.builder.kindBody.${k}`)}`
            .toLowerCase()
            .includes(needle)),
    ),
  })).filter((g) => g.kinds.length > 0);
  const flat = groups.flatMap((g) => g.kinds);

  useLayoutEffect(() => {
    const r = anchor?.getBoundingClientRect();
    if (!r) return setPos({ top: 120, left: 120 });
    const height = 420;
    const below = r.bottom + 4 + height < window.innerHeight;
    setPos({
      top: below ? r.bottom + 4 : Math.max(8, r.top - height - 4),
      left: Math.min(r.left, window.innerWidth - 328),
    });
  }, [anchor]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [onClose]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (a + 1) % Math.max(flat.length, 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a - 1 + flat.length) % Math.max(flat.length, 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const k = flat[active];
      if (k) onPick(k);
    } else if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  let i = -1;
  return createPortal(
    <div
      ref={box}
      role="dialog"
      aria-label={t("automations.builder.add.menu")}
      style={pos ?? undefined}
      className="menu-enter fixed z-50 flex max-h-[420px] w-80 flex-col rounded-lg border border-rule-strong bg-surface shadow-[0_12px_32px_-8px_oklch(0_0_0/0.4)]"
    >
      <input
        autoFocus
        role="combobox"
        aria-expanded
        aria-controls={listId}
        aria-activedescendant={flat[active] ? `${listId}-${flat[active]}` : undefined}
        aria-label={t("automations.builder.add.search")}
        placeholder={t("automations.builder.add.search")}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
        className="h-9 shrink-0 border-b border-rule bg-transparent px-3 text-md text-ink outline-none placeholder:text-ink-faint"
      />
      <div
        id={listId}
        role="listbox"
        aria-label={t("automations.builder.add.menu")}
        className="flex min-h-0 flex-col overflow-y-auto p-1.5"
      >
        {groups.map((g) => (
          <div key={g.key} role="group" aria-label={t(`automations.builder.add.group.${g.key}`)}>
            <p aria-hidden="true" className="heading-group px-2 pt-2 pb-1">
              {t(`automations.builder.add.group.${g.key}`)}
            </p>
            {g.kinds.map((k) => {
              i += 1;
              const me = i;
              return (
                <div
                  key={k}
                  id={`${listId}-${k}`}
                  role="option"
                  aria-selected={me === active}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActive(me)}
                  onClick={() => onPick(k)}
                  className={`flex cursor-default items-start gap-2.5 rounded-md px-2 py-1.5 ${me === active ? "bg-ink/8" : ""}`}
                >
                  <span className="pt-0.5">
                    <StepGlyph kind={k} />
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="text-md text-ink">{t(`automations.builder.kind.${k}`)}</span>
                    <span className="text-sm text-ink-muted">
                      {t(`automations.builder.kindBody.${k}`)}
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
        ))}
        {flat.length === 0 && (
          <p className="px-2 py-2 text-sm text-ink-muted">{t("automations.builder.add.none")}</p>
        )}
        {deep && (
          <p className="border-t border-rule px-2 pt-2 pb-1 text-xs text-ink-muted">
            {t("automations.builder.add.tooDeep")}
          </p>
        )}
      </div>
    </div>,
    document.body,
  );
}
