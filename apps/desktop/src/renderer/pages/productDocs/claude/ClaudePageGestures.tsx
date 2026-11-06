import { useId } from "react";
import { useTranslation } from "react-i18next";
import { useAiBlock, useBacklogProposal } from "../../../data/queries";
import type { ProductPageView } from "../../../data/types";
import { WhoCanLink } from "../../../components/WhoCanLink";
import { openClaudePanel } from "../../../layout/claudePanel/panelEvents";
import { itemClass, MenuGroup } from "../../../tasks-ui/Menu";
import { ClaudeRing } from "./FirstVersionProgress";

// I gesti di Claude sulla pagina (11b, Task 12; shape
// product-claude-backlog.md §3.1, §3.6, [PB 2]): nel «⋯» della pagina il
// gruppo CLAUDE con «Propose backlog items» e «Draw this screen»; nel menu ⋮⋮
// di un titolo «Propose backlog items from this section». Solo per chi
// scrive (lo dice la vista: `permissions.edit`). La scheda la prepara Claude
// nel riquadro (P21: la frase della persona come primo messaggio, `send`),
// e il fuoco va al titolo della scheda (Task 10). Le voci da proporre si
// leggono quando il menu si apre (il componente nasce con lui), non quando
// la pagina si monta.
//
// Spente con la loro frase sotto il nome (`aria-disabled`, restano
// raggiungibili con le frecce): il budget del mese finito, col «Who?» di chi
// gestisce le impostazioni; una pagina o una sezione senza elenchi né liste
// di controllo, senza «Who?» (è una regola).

const offItem = `${itemClass} cursor-default items-start hover:bg-transparent`;

function Ring() {
  return (
    <span className="flex h-5 shrink-0 items-center">
      <ClaudeRing size={14} pulse={false} />
    </span>
  );
}

/** Una voce di Claude: attiva, o spenta con la sua frase (e il «Who?» del budget). */
function ClaudeItem({
  label,
  off,
  budget,
  onChoose,
}: {
  label: string;
  /** La frase della voce spenta; `null` = attiva. */
  off: string | null;
  /** Spenta per il budget: c'è chi può alzarlo. */
  budget: boolean;
  onChoose: () => void;
}) {
  const whyId = useId();
  if (off === null) {
    return (
      <button type="button" role="menuitem" tabIndex={-1} className={itemClass} onClick={onChoose}>
        <Ring />
        {label}
      </button>
    );
  }
  return (
    <>
      <button
        type="button"
        role="menuitem"
        tabIndex={-1}
        aria-disabled="true"
        aria-label={label}
        aria-describedby={whyId}
        className={offItem}
      >
        <Ring />
        <span className="flex min-w-0 flex-col">
          <span className="text-ink-muted">{label}</span>
          <span id={whyId} className="text-xs text-pretty text-ink-muted">
            {off}
          </span>
        </span>
      </button>
      {budget && (
        <span className="pb-1 pl-[34px] text-xs">
          <WhoCanLink action="manageSettings" projectId={null} menuItem />
        </span>
      )}
    </>
  );
}

/** La frase che spegne la voce: il budget prima di tutto, poi «niente da proporre». */
function useProposeOff(page: ProductPageView, fromAnchorId: string | null, empty: string) {
  const { t } = useTranslation();
  const budgetOut = useAiBlock(page.projectId).data?.reason === "monthly_budget";
  // Si legge adesso, col menu aperto: una frase scritta un attimo fa conta.
  const proposal = useBacklogProposal(page.id, fromAnchorId).data;
  const nothing = proposal !== undefined && proposal.actions.length === 0 && proposal.notes.length === 0;
  return {
    budgetOut,
    off: budgetOut ? t("productDocs.backlog.budget") : nothing ? empty : null,
  };
}

/**
 * Il gruppo CLAUDE del «⋯» della pagina, dopo i gesti usciti dalla barra e
 * prima di Copy link. `close` chiude il menu col fuoco sul «⋯» (il riquadro
 * poi lo porta sulla scheda, il disegno sulla bozza nuova): mai sul body.
 */
export function PageClaudeGroup({
  page,
  close,
  onDraw,
}: {
  page: ProductPageView;
  close: () => void;
  onDraw: () => void;
}) {
  const { t } = useTranslation();
  const { budgetOut, off } = useProposeOff(page, null, t("productDocs.backlog.noItems"));
  return (
    <MenuGroup label={t("productDocs.backlog.group")}>
      <ClaudeItem
        label={t("productDocs.backlog.propose")}
        off={off}
        budget={budgetOut}
        onChoose={() => {
          close();
          openClaudePanel({
            draft: t("claude.answers.productDocs.ask.backlog", { code: page.code, title: page.title }),
            fresh: true,
            send: true,
          });
        }}
      />
      <ClaudeItem
        label={t("productDocs.backlog.draw")}
        off={budgetOut ? t("productDocs.backlog.budget") : null}
        budget={budgetOut}
        onChoose={() => {
          close();
          onDraw();
        }}
      />
    </MenuGroup>
  );
}

/** «Propose backlog items from this section», nel menu ⋮⋮ di un titolo (dopo «Comment»). */
export function SectionProposeItem({
  page,
  headingId,
  section,
  close,
  beforeOpen,
}: {
  page: ProductPageView;
  headingId: string;
  /** Il testo del titolo, com'è adesso: la frase della persona lo cita. */
  section: string;
  close: () => void;
  /** Le bozze dell'editor si salvano prima: Claude legge la pagina com'è. */
  beforeOpen: () => void;
}) {
  const { t } = useTranslation();
  const { budgetOut, off } = useProposeOff(page, headingId, t("productDocs.backlog.noItemsSection"));
  return (
    <ClaudeItem
      label={t("productDocs.backlog.proposeSection")}
      off={off}
      budget={budgetOut}
      onChoose={() => {
        close();
        beforeOpen();
        openClaudePanel({
          draft: t("claude.answers.productDocs.ask.backlogSection", { section, code: page.code }),
          fresh: true,
          send: true,
        });
      }}
    />
  );
}
