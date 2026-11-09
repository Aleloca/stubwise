// Un rifiuto della pianificazione (Planning e La mia settimana): il server
// (o il finto) ha detto no per una regola, e riprovare non serve. Ha la sua
// frase e niente «Try again»; ogni altro errore (rete, 500) resta da riprovare.
// Il server manda `code` (`forbidden`, `invalid_assignee`, `past_week`,
// `not_in_week`), il finto lo scrive nel messaggio.

export type PlanRefusal = "forbidden" | "invalid_assignee" | "past_week" | "not_in_week";

const REFUSALS: readonly PlanRefusal[] = ["forbidden", "invalid_assignee", "past_week", "not_in_week"];

/** Le frasi del finto (`data/api-mutations.ts`: `forbidden()`, `invalid("assignee")`). */
const FAKE_MESSAGES: Record<string, PlanRefusal> = {
  forbidden: "forbidden",
  "invalid: assignee": "invalid_assignee",
};

export function planRefusalOf(error: unknown): PlanRefusal | null {
  if (!(error instanceof Error)) return null;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") return (REFUSALS as readonly string[]).includes(code) ? (code as PlanRefusal) : null;
  return FAKE_MESSAGES[error.message] ?? null;
}
