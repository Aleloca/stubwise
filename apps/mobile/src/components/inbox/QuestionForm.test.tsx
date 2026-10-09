import type { InboxQuestion, Reader } from "@stubwise/shared";
import { render, screen } from "@testing-library/react-native";
import "../../i18n";
import { fontFamily } from "../../theme/typography";
import { QuestionForm } from "./QuestionForm";

const question = {
  questionId: "q1",
  round: 1,
  question: "Quale?",
  options: [
    { label: "Italiano: `format(3.14)`", consequence: "Chi legge con `Number()` si rompe" },
    { label: "Semplice" },
  ],
  allowFreeText: false,
} as unknown as Reader<InboxQuestion>;

const props = { onSubmit: jest.fn(), pending: false, disabled: false, online: true, errorMessage: null };

describe("QuestionForm — opzioni", () => {
  test("senza markdownQuestion (inbox) etichetta e conseguenza restano testo semplice", async () => {
    await render(<QuestionForm question={question} {...props} />);
    expect(screen.getByText("Italiano: `format(3.14)`")).toBeTruthy();
    expect(screen.getByText("Chi legge con `Number()` si rompe")).toBeTruthy();
  });

  test("con markdownQuestion il codice inline è in stile codice, senza backtick, nella STESSA opzione premibile", async () => {
    await render(<QuestionForm question={question} markdownQuestion {...props} />);
    const code = screen.getByText("format(3.14)");
    expect(JSON.stringify(code.props.style)).toContain(fontFamily.mono);
    expect(screen.getByText("Number()")).toBeTruthy();
    expect(screen.queryByText(/`/)).toBeNull();
    expect(screen.getByRole("radio", { name: /Italiano: format\(3\.14\)/ })).toBeTruthy();
  });

  test("con markdownQuestion un link nell'etichetta resta testo, non premibile", async () => {
    const q = { ...question, options: [{ label: "Vedi [doc](https://x.test)" }] } as unknown as Reader<InboxQuestion>;
    await render(<QuestionForm question={q} markdownQuestion {...props} />);
    expect(screen.getByRole("radio", { name: /Vedi doc/ })).toBeTruthy();
    expect(screen.queryByText("doc")?.props.onPress).toBeUndefined();
  });
});
