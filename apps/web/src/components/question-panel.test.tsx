import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { InboxQuestion } from "../lib/api";
import { QuestionPanel } from "./question-panel";

/**
 * Pannello di risposta a una domanda dell'agente: reso qui isolato dalle due
 * superfici che lo consumano (card d'inbox e pagina ticket), perché è il
 * COMPORTAMENTO del pannello a essere condiviso — conferma a due passi,
 * consigliata mai preselezionata, testo libero, degrado.
 *
 * Asserzioni sulle stringhe inglesi (i18n inizializzato in `en` dal setup).
 */

const QUESTION_ID = "99999999-9999-4999-8999-999999999999";

function question(overrides: Partial<InboxQuestion> = {}): InboxQuestion {
  return {
    questionId: QUESTION_ID,
    round: 1,
    question: "Where should the setting live?",
    options: [
      { label: "On the project", consequence: "Every repository inherits it" },
      { label: "On the repository", consequence: "Set it repository by repository" },
      { label: "On both" },
    ],
    recommendedIndex: 1,
    allowFreeText: true,
    ...overrides,
  };
}

describe("QuestionPanel", () => {
  it("rende ogni opzione con la sua conseguenza e marca la consigliata SENZA preselezionarla", () => {
    render(<QuestionPanel question={question()} onSubmit={vi.fn()} />);

    expect(screen.getByRole("radio", { name: "On the project" })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: /On the repository/ })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "On both" })).not.toBeChecked();

    // La conseguenza sta sotto l'opzione: è metà del significato di una scelta.
    expect(screen.getByText("Every repository inherits it")).toBeInTheDocument();
    expect(screen.getByText("Set it repository by repository")).toBeInTheDocument();

    // Marcata, non scelta: la consigliata porta la marcatura nel suo nome
    // accessibile (chi non vede il bordo ambra la sente lo stesso)…
    expect(
      screen.getByRole("radio", { name: "On the repository recommended" }),
    ).toBeInTheDocument();
    // …e nessun'altra la porta (i nomi sono confronti ESATTI).
    expect(screen.getByRole("radio", { name: "On the project" })).toBeInTheDocument();
    // Nessuna opzione è selezionata all'apertura: la decisione resta alla persona.
    for (const radio of screen.getAllByRole("radio")) expect(radio).not.toBeChecked();
  });

  it("la selezione NON invia: serve il bottone di conferma", async () => {
    const onSubmit = vi.fn();
    render(<QuestionPanel question={question()} onSubmit={onSubmit} />);

    await userEvent.click(screen.getByRole("radio", { name: "On the project" }));

    // Un tap non decide.
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("radio", { name: "On the project" })).toBeChecked();

    await userEvent.click(screen.getByRole("button", { name: "Send answer" }));
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ optionIndex: 0 });
  });

  it("invia l'INDICE dell'opzione scelta, non la sua posizione nell'elenco visibile", async () => {
    const onSubmit = vi.fn();
    render(<QuestionPanel question={question()} onSubmit={onSubmit} />);

    await userEvent.click(screen.getByRole("radio", { name: "On both" }));
    await userEvent.click(screen.getByRole("button", { name: "Send answer" }));

    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ optionIndex: 2 });
  });

  it("finché non si sceglie nulla non c'è niente da inviare", () => {
    render(<QuestionPanel question={question()} onSubmit={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Send answer" })).toBeDisabled();
  });

  it("'Other…' apre la textarea e invia il testo libero ripulito", async () => {
    const onSubmit = vi.fn();
    render(<QuestionPanel question={question()} onSubmit={onSubmit} />);

    // La textarea non esiste finché non si sceglie il testo libero.
    expect(screen.queryByLabelText("Your answer")).toBeNull();

    await userEvent.click(screen.getByRole("radio", { name: "Other…" }));

    const textarea = screen.getByLabelText("Your answer");
    // Testo vuoto = niente da inviare.
    expect(screen.getByRole("button", { name: "Send answer" })).toBeDisabled();

    await userEvent.type(textarea, "  Keep it on the project, but override per repo  ");
    await userEvent.click(screen.getByRole("button", { name: "Send answer" }));

    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
      text: "Keep it on the project, but override per repo",
    });
  });

  it("senza testo libero ammesso non offre 'Other…'", () => {
    render(<QuestionPanel question={question({ allowFreeText: false })} onSubmit={vi.fn()} />);
    expect(screen.queryByRole("radio", { name: "Other…" })).toBeNull();
    expect(screen.getAllByRole("radio")).toHaveLength(3);
  });

  it("un'opzione inutilizzabile azzera l'ELENCO: nessun indice viene compattato", () => {
    render(
      <QuestionPanel
        question={question({
          options: [{ label: "On the project" }, { label: "   " }, { label: "On both" }],
        })}
        onSubmit={vi.fn()}
      />,
    );

    // Nessuna opzione mostrata: un elenco compattato farebbe registrare
    // l'indice 1 a chi clicca "On both" (che è l'opzione 2 persistita).
    expect(screen.queryByRole("radio", { name: "On the project" })).toBeNull();
    expect(screen.queryByRole("radio", { name: "On both" })).toBeNull();
    // Resta il testo libero, che non ha indici da sbagliare.
    expect(screen.getByLabelText("Your answer")).toBeInTheDocument();
  });

  it("senza opzioni utilizzabili né testo libero non rende nulla (degrado)", () => {
    const { container } = render(
      <QuestionPanel
        question={question({ options: [{ label: "" }], allowFreeText: false })}
        onSubmit={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("una consigliata fuori range non marca nessuna opzione", () => {
    render(<QuestionPanel question={question({ recommendedIndex: 7 })} onSubmit={vi.fn()} />);
    expect(screen.queryByText(/recommended/)).toBeNull();
  });

  it("mostra l'errore ricevuto e blocca i controlli mentre la risposta è in volo", async () => {
    const onSubmit = vi.fn();
    const { rerender } = render(
      <QuestionPanel question={question()} onSubmit={onSubmit} pending error={null} />,
    );

    expect(screen.getByRole("radio", { name: "On the project" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send answer" })).toBeDisabled();

    rerender(
      <QuestionPanel
        question={question()}
        onSubmit={onSubmit}
        error="Already answered by bea@example.com"
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Already answered by bea@example.com");
  });

  it("mostra il testo della domanda, e lo tace su richiesta di chi lo rende già", () => {
    const { rerender } = render(<QuestionPanel question={question()} onSubmit={vi.fn()} />);
    expect(screen.getByText("Where should the setting live?")).toBeInTheDocument();

    rerender(<QuestionPanel question={question()} onSubmit={vi.fn()} showQuestionText={false} />);
    expect(screen.queryByText("Where should the setting live?")).toBeNull();
  });
});
