import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LabelsEditor } from "./labels-editor";

function renderEditor(labels: string[] = []) {
  const onChange = vi.fn();
  render(<LabelsEditor labels={labels} onChange={onChange} />);
  return onChange;
}

describe("LabelsEditor", () => {
  it("mostra le label esistenti come chip", () => {
    renderEditor(["pagamenti", "regressione"]);

    expect(screen.getByText("pagamenti")).toBeInTheDocument();
    expect(screen.getByText("regressione")).toBeInTheDocument();
  });

  it("aggiunge una label con Invio e svuota il campo", async () => {
    const onChange = renderEditor(["pagamenti"]);
    const input = screen.getByLabelText(/label/i);

    await userEvent.type(input, "checkout{Enter}");

    expect(onChange).toHaveBeenCalledExactlyOnceWith(["pagamenti", "checkout"]);
    expect(input).toHaveValue("");
  });

  it("aggiunge una label con il bottone, con trim degli spazi", async () => {
    const onChange = renderEditor();

    await userEvent.type(screen.getByLabelText(/label/i), "  urgente  ");
    await userEvent.click(screen.getByRole("button", { name: /aggiungi/i }));

    expect(onChange).toHaveBeenCalledExactlyOnceWith(["urgente"]);
  });

  it("ignora vuoti e duplicati", async () => {
    const onChange = renderEditor(["pagamenti"]);
    const input = screen.getByLabelText(/label/i);

    await userEvent.type(input, "{Enter}");
    await userEvent.type(input, "pagamenti{Enter}");

    expect(onChange).not.toHaveBeenCalled();
    // Il duplicato non viene aggiunto ma il campo si svuota comunque.
    expect(input).toHaveValue("");
  });

  it("rimuove una label dal chip", async () => {
    const onChange = renderEditor(["pagamenti", "checkout"]);

    await userEvent.click(screen.getByRole("button", { name: /rimuovi.*pagamenti/i }));

    expect(onChange).toHaveBeenCalledExactlyOnceWith(["checkout"]);
  });
});
