import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { MarkdownEditor } from "./markdown-editor";

/**
 * Editor controllato: la toolbar avvolge la selezione nella sintassi markdown
 * e chiama onChange col nuovo valore; i tab Write/Preview commutano tra
 * textarea e resa Markdown. Per testare la toolbar serve una selezione reale,
 * quindi si usa un wrapper stateful che mantiene `value` aggiornato.
 */

/** Wrapper stateful: tiene `value` allineato e inoltra onChange a uno spy. */
function Harness({
  initial = "",
  onChange,
}: {
  initial?: string;
  onChange?: (v: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <MarkdownEditor
      id="md"
      value={value}
      onChange={(v) => {
        setValue(v);
        onChange?.(v);
      }}
      aria-label="Body"
    />
  );
}

/** Trova la textarea per id (è anche etichettata da aria-label). */
function getTextarea(): HTMLTextAreaElement {
  return screen.getByLabelText("Body") as HTMLTextAreaElement;
}

describe("MarkdownEditor", () => {
  it("Bold avvolge la selezione in **…**", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial="hello" onChange={onChange} />);

    const textarea = getTextarea();
    textarea.focus();
    textarea.setSelectionRange(0, 5);

    await user.click(screen.getByRole("button", { name: "Bold" }));

    expect(onChange).toHaveBeenLastCalledWith("**hello**");
  });

  it("Italic avvolge la selezione in *…*", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial="hello" onChange={onChange} />);

    const textarea = getTextarea();
    textarea.focus();
    textarea.setSelectionRange(0, 5);

    await user.click(screen.getByRole("button", { name: "Italic" }));

    expect(onChange).toHaveBeenLastCalledWith("*hello*");
  });

  it("Code avvolge la selezione in `…`", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial="hello" onChange={onChange} />);

    const textarea = getTextarea();
    textarea.focus();
    textarea.setSelectionRange(0, 5);

    await user.click(screen.getByRole("button", { name: "Inline code" }));

    expect(onChange).toHaveBeenLastCalledWith("`hello`");
  });

  it("Link produce [selezione](url)", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial="hello" onChange={onChange} />);

    const textarea = getTextarea();
    textarea.focus();
    textarea.setSelectionRange(0, 5);

    await user.click(screen.getByRole("button", { name: "Link" }));

    expect(onChange).toHaveBeenLastCalledWith("[hello](url)");
  });

  it("Bold su selezione vuota inserisce **** col cursore in mezzo", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial="" onChange={onChange} />);

    const textarea = getTextarea();
    textarea.focus();
    textarea.setSelectionRange(0, 0);

    await user.click(screen.getByRole("button", { name: "Bold" }));

    expect(onChange).toHaveBeenLastCalledWith("****");
    // Cursore tra i due marcatori (dopo i primi due asterischi).
    expect(textarea.selectionStart).toBe(2);
    expect(textarea.selectionEnd).toBe(2);
  });

  it("Bulleted list prefissa le righe selezionate con '- '", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={"uno\ndue"} onChange={onChange} />);

    const textarea = getTextarea();
    textarea.focus();
    textarea.setSelectionRange(0, 7);

    await user.click(screen.getByRole("button", { name: "Bulleted list" }));

    expect(onChange).toHaveBeenLastCalledWith("- uno\n- due");
  });

  it("il tab Preview rende il markdown, Write torna alla textarea", async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness initial="**x**" />);

    await user.click(screen.getByRole("tab", { name: "Preview" }));
    const strong = container.querySelector("strong");
    expect(strong).not.toBeNull();
    expect(strong).toHaveTextContent("x");

    await user.click(screen.getByRole("tab", { name: "Write" }));
    expect(getTextarea()).toBeInTheDocument();
  });

  it("Preview vuota mostra il placeholder", async () => {
    const user = userEvent.setup();
    render(<Harness initial="   " />);

    await user.click(screen.getByRole("tab", { name: "Preview" }));

    expect(screen.getByText("Nothing to preview")).toBeInTheDocument();
  });

  it("i bottoni della toolbar non scatenano il submit del form", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <Harness initial="hello" />
      </form>,
    );

    const textarea = getTextarea();
    textarea.focus();
    textarea.setSelectionRange(0, 5);

    await user.click(screen.getByRole("button", { name: "Bold" }));
    await user.click(screen.getByRole("tab", { name: "Preview" }));

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("passa id, placeholder e aria-label alla textarea", () => {
    render(
      <MarkdownEditor
        id="my-field"
        value=""
        onChange={vi.fn()}
        placeholder="Scrivi qui…"
        aria-label="Campo"
      />,
    );

    const textarea = screen.getByLabelText("Campo") as HTMLTextAreaElement;
    expect(textarea.id).toBe("my-field");
    expect(textarea.placeholder).toBe("Scrivi qui…");
  });
});
