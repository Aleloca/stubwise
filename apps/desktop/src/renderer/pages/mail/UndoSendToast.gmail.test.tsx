import { render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it } from "vitest";
import i18n from "../../i18n";
import type { MailDraftRestore } from "../../data/types";
import { clearToasts, ToastRegion } from "../../tasks-ui/Toast";
import { useDroppedNotice } from "./UndoSendToast";

// Registro, A6 r.448 (72, 735aa4d44), build app: «Annulla» unisce la bozza
// tornata a quella che c'era; se la bozza su Gmail non si riscrive
// (`gmailOutdated`), chi scrive lo sa: la riscrive il prossimo Salva.

afterEach(() => clearToasts());

function Notice({ restore }: { restore: MailDraftRestore }) {
  const notice = useDroppedNotice();
  useEffect(() => notice(restore), [notice, restore]);
  return <ToastRegion />;
}

const restore = (over: Partial<MailDraftRestore>): MailDraftRestore =>
  ({ draft: {} as MailDraftRestore["draft"], droppedAttachments: [], ...over }) as MailDraftRestore;

describe("la bozza tornata e Gmail", () => {
  it("unita ma Gmail non riscritto: lo dice", async () => {
    render(<Notice restore={restore({ gmailOutdated: true })} />);
    expect(
      await screen.findByText(
        "Merged with the draft that was already there. Gmail still has the old one: saving updates it.",
      ),
    ).toBeInTheDocument();
  });

  it("Gmail aggiornato: nessun avviso", () => {
    render(<Notice restore={restore({ gmailOutdated: false })} />);
    expect(screen.queryByText(/Gmail still has the old one/)).toBeNull();
  });
});

// Revisione del lotto 2, I5 (72, 5c8747ef2; scelta A di 46): se l'unione ha
// perso qualcosa, la versione annullata resta fra le bozze di Gmail come
// copia di sicurezza (`gmailCopyKept`), e il toast lo dice.
describe("la copia tenuta fra le bozze di Gmail", () => {
  afterEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("tenuta: lo dice, anche insieme agli allegati rimasti fuori", async () => {
    const dropped = [{ id: "d-0", name: "offerta.pdf", sizeBytes: 0, driveFileId: null, as: "copy" as const }];
    render(<Notice restore={restore({ gmailCopyKept: true, droppedAttachments: dropped })} />);
    expect(await screen.findByText("The undone version is still in your Gmail drafts.")).toBeInTheDocument();
    expect(screen.getByText(/didn't fit back in the draft: offerta.pdf/)).toBeInTheDocument();
  });

  it("in italiano", async () => {
    await i18n.changeLanguage("it");
    render(<Notice restore={restore({ gmailCopyKept: true })} />);
    expect(await screen.findByText("La versione annullata è ancora fra le bozze di Gmail.")).toBeInTheDocument();
  });

  it("non tenuta: nessuna riga", () => {
    render(<Notice restore={restore({ gmailCopyKept: false, gmailOutdated: true })} />);
    expect(screen.queryByText(/still in your Gmail drafts/)).toBeNull();
  });
});
