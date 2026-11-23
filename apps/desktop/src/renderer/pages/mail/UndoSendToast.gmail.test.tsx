import { render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it } from "vitest";
import "../../i18n";
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
