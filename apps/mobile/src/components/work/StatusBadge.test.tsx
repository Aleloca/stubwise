import { UNKNOWN } from "@stubwise/shared";
import { render, screen } from "@testing-library/react-native";
import "../../i18n";
import { StatusBadge } from "./StatusBadge";

describe("StatusBadge", () => {
  test("proposed: 'In coda'", async () => {
    await render(<StatusBadge state="proposed" />);
    expect(screen.getByText("In coda")).toBeTruthy();
  });

  test("working: 'In esecuzione'", async () => {
    await render(<StatusBadge state="working" />);
    expect(screen.getByText("In esecuzione")).toBeTruthy();
  });

  test("waiting_answer: 'In attesa di risposta'", async () => {
    await render(<StatusBadge state="waiting_answer" />);
    expect(screen.getByText("In attesa di risposta")).toBeTruthy();
  });

  test("waiting_approval: 'Piano da approvare'", async () => {
    await render(<StatusBadge state="waiting_approval" />);
    expect(screen.getByText("Piano da approvare")).toBeTruthy();
  });

  test("done: 'Rilasciato'", async () => {
    await render(<StatusBadge state="done" />);
    expect(screen.getByText("Rilasciato")).toBeTruthy();
  });

  test("failed: 'Fallito'", async () => {
    await render(<StatusBadge state="failed" />);
    expect(screen.getByText("Fallito")).toBeTruthy();
  });

  test("null (nessun job ancora): stesso testo di 'proposed'", async () => {
    await render(<StatusBadge state={null} />);
    expect(screen.getByText("In coda")).toBeTruthy();
  });

  test("stato ignoto (server più nuovo): testo generico, mai il valore grezzo", async () => {
    await render(<StatusBadge state={UNKNOWN} />);
    expect(screen.getByText("Aggiornamento")).toBeTruthy();
    expect(screen.queryByText(UNKNOWN)).toBeNull();
  });
});
