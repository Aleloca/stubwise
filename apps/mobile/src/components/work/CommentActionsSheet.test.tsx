import { fireEvent, render, screen } from "@testing-library/react-native";
import "../../i18n";
import { CommentActionsSheet } from "./CommentActionsSheet";
import type { CommentAction } from "./CommentActionsSheet";

async function renderSheet(props: { open?: boolean; canEdit?: boolean; canDelete?: boolean } = {}) {
  const onRequestClose = jest.fn<void, []>();
  const onClosed = jest.fn<void, [CommentAction | null]>();
  const element = (open: boolean) => (
    <CommentActionsSheet
      open={open}
      canEdit={props.canEdit ?? true}
      canDelete={props.canDelete ?? true}
      onRequestClose={onRequestClose}
      onClosed={onClosed}
    />
  );
  const utils = await render(element(props.open ?? true));
  return { onRequestClose, onClosed, setOpen: (open: boolean) => utils.rerender(element(open)) };
}

describe("CommentActionsSheet", () => {
  test("mostra SOLO le voci permesse: con il solo canDelete, niente «Modifica»", async () => {
    await renderSheet({ canEdit: false, canDelete: true });
    expect(screen.getByTestId("work-comment-action-delete")).toBeTruthy();
    expect(screen.queryByTestId("work-comment-action-edit")).toBeNull();
  });

  test("con il solo canEdit, niente «Elimina»", async () => {
    await renderSheet({ canEdit: true, canDelete: false });
    expect(screen.getByTestId("work-comment-action-edit")).toBeTruthy();
    expect(screen.queryByTestId("work-comment-action-delete")).toBeNull();
  });

  /**
   * L'ORDINE dei fogli nativi (CLAUDE.md): la scelta NON agisce al tocco, ma
   * quando il foglio è sceso (`onDidDismiss`). Il mock di true-sheet chiude in
   * modo sincrono, quindi l'ordine si verifica tenendo il pannello APERTO
   * dopo il tocco: se l'azione partisse da `onPress`, `onClosed` sarebbe già
   * stato chiamato col foglio ancora a schermo.
   */
  test("ORDINE: il tocco chiede di chiudere e basta; la scelta arriva solo a foglio chiuso", async () => {
    const { onRequestClose, onClosed, setOpen } = await renderSheet();
    await fireEvent.press(screen.getByTestId("work-comment-action-edit"));
    expect(onRequestClose).toHaveBeenCalledTimes(1);
    expect(onClosed).not.toHaveBeenCalled();
    expect(screen.getByTestId("true-sheet")).toBeTruthy();

    await setOpen(false);
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(onClosed).toHaveBeenCalledWith("edit");
    expect(screen.queryByTestId("true-sheet")).toBeNull();
  });

  test("«Elimina» segue lo stesso ordine", async () => {
    const { onClosed, setOpen } = await renderSheet();
    await fireEvent.press(screen.getByTestId("work-comment-action-delete"));
    expect(onClosed).not.toHaveBeenCalled();
    await setOpen(false);
    expect(onClosed).toHaveBeenCalledWith("delete");
  });

  test("due tocchi prima che il foglio scenda: vale il PRIMO, il secondo non lo sovrascrive", async () => {
    const { onClosed, setOpen } = await renderSheet();
    await fireEvent.press(screen.getByTestId("work-comment-action-edit"));
    await fireEvent.press(screen.getByTestId("work-comment-action-delete"));
    await setOpen(false);
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(onClosed).toHaveBeenCalledWith("edit");
  });

  test("trascinato via senza scegliere: chiuso con nessuna scelta", async () => {
    const { onClosed } = await renderSheet();
    await fireEvent.press(screen.getByTestId("true-sheet-dismiss"));
    expect(onClosed).toHaveBeenCalledWith(null);
  });
});
