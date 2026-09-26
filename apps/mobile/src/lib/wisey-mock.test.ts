import { mockReply } from "./wisey-mock";
import en from "../i18n/en.json";
import it from "../i18n/it.json";

/**
 * Le risposte FINTE di Wisey («Wisey, anteprima nell'app» §6): dalla domanda
 * a un gruppo, per parole chiave in inglese e italiano. Dicono cosa Wisey
 * FARÀ e dove si fa oggi, mai un dato vero.
 */
describe("mockReply", () => {
  test.each([
    ["Start a backlog item", "backlog"],
    ["Aggiungi un'idea al backlog", "backlog"],
    ["Fix the login bug", "ticket"],
    ["Lancia il ticket 42", "ticket"],
    ["Which PRs can I merge?", "pr"],
    ["C'è una pull request da mergiare?", "pr"],
    ["Anything new in my mail?", "mail"],
    ["Cosa è arrivato in posta?", "mail"],
    ["What's waiting for me?", "inbox"],
    ["Cosa mi aspetta oggi?", "inbox"],
    ["How is my project doing?", "status"],
    ["Come va il progetto?", "status"],
    ["Hi!", "greeting"],
    ["Ciao Wisey", "greeting"],
  ])("«%s» → %s", (question, group) => {
    expect(mockReply(question).group).toBe(group);
  });

  test("quello che non riconosce ha una risposta generica, non un silenzio", () => {
    expect(mockReply("Quanto fa due più due?").group).toBe("generic");
    expect(mockReply("   ").group).toBe("generic");
  });

  test("le parole si cercano INTERE: «pr» dentro «project» o «approva» non è una pull request", () => {
    expect(mockReply("approva il piano").group).not.toBe("pr");
    expect(mockReply("How is the project going?").group).toBe("status");
  });

  test("un saluto non copre una richiesta: «ciao, crea una voce di backlog» è backlog", () => {
    expect(mockReply("Ciao, crea una voce di backlog").group).toBe("backlog");
  });

  test("FARE qualcosa è un'azione (backlog, ticket); il resto è una risposta", () => {
    expect(mockReply("Start a backlog item").kind).toBe("action");
    expect(mockReply("Fix the login bug").kind).toBe("action");
    for (const q of ["Which PRs can I merge?", "Any mail?", "What's waiting for me?", "How is my project doing?", "Hi", "boh"]) {
      expect(mockReply(q).kind).toBe("answer");
    }
  });

  test("ogni gruppo ha il suo testo in inglese E in italiano", () => {
    for (const q of ["backlog", "fix", "merge", "mail", "waiting", "status", "hi", "boh"]) {
      const { textKey } = mockReply(q);
      const path = textKey.split(".");
      const lookup = (dict: unknown) => path.reduce<unknown>((node, key) => (node as Record<string, unknown>)?.[key], dict);
      expect(typeof lookup(en)).toBe("string");
      expect(typeof lookup(it)).toBe("string");
    }
  });
});
