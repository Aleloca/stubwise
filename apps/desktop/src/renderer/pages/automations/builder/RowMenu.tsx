import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { Step } from "../../../data/types";
import { MenuGroup, itemClass } from "../../../tasks-ui/Menu";
import { MenuButton } from "../../tasks/controls";
import { MoreGlyph } from "../glyphs";
import { useBuilder } from "./context";
import { placeOf } from "./tree";

// «⋯» della riga di un passo: le stesse azioni della tastiera, con le
// scorciatoie scritte accanto ([A 14]).

const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);

export function RowMenu({ step, path }: { step: Step; path: string }) {
  const { t } = useTranslation();
  const b = useBuilder();
  const mod = isMac ? "⌘" : "Ctrl+";
  const opt = isMac ? "⌥" : "Alt+";
  const item = (label: string, keys: string, run: () => void, danger = false): ReactNode => (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      className={`${itemClass} ${danger ? "text-critical" : ""}`}
      onClick={run}
    >
      <span className="flex-1">{label}</span>
      {keys && <kbd className="num text-xs text-ink-faint">{keys}</kbd>}
    </button>
  );
  return (
    <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <MenuButton
        ariaLabel={t("automations.builder.rowMenu", { n: b.numbers.get(path) ?? "" })}
        menuLabel={t("automations.builder.rowMenu", { n: b.numbers.get(path) ?? "" })}
        align="right"
        label={<MoreGlyph />}
        className="grid size-7 shrink-0 place-items-center rounded-md text-ink-faint opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 hover:bg-ink/6 hover:text-ink aria-expanded:opacity-100"
      >
        {(close) => (
          <>
            <MenuGroup>
              {item(t("automations.builder.menu.addAfter"), "A", () => {
                close();
                const { lane, index } = placeOf(path);
                b.requestAdd(
                  lane,
                  index + 1,
                  document.querySelector(`[data-tree-row="${step.id}"]`),
                );
              })}
              {item(t("automations.builder.menu.duplicate"), `${mod}D`, () => {
                close();
                b.duplicate(step.id);
              })}
              {item(t("automations.builder.menu.moveTo"), "", () => {
                close();
                b.requestMoveTo(step.id);
              })}
              {item(t("automations.builder.menu.moveUp"), `${opt}↑`, () => {
                close();
                b.move(step.id, -1);
              })}
              {item(t("automations.builder.menu.moveDown"), `${opt}↓`, () => {
                close();
                b.move(step.id, 1);
              })}
            </MenuGroup>
            <MenuGroup>
              {item(
                t("automations.builder.menu.delete"),
                "⌫",
                () => {
                  close();
                  b.requestDelete(step.id);
                },
                true,
              )}
            </MenuGroup>
          </>
        )}
      </MenuButton>
    </span>
  );
}
