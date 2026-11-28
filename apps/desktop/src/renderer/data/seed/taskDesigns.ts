// Design e piano salvati su una task (27 nov 2026, shape
// `design-plan-remove.md`): AUD-5, la task nata da «Export the call history»,
// li ha da quando l'hanno collegati dal piano scritto in Claude Code (sul
// server: `set_design`, `set_plan`). Il prototipo tiene la descrizione
// originale nella task e il design a sé, com'è la lettura della build app.
export const TASK_DESIGNS: Record<string, { design: string | null; plan: string | null }> = {
  "t-aud-5": {
    design: [
      "## Call history export",
      "",
      "- One spreadsheet per request, with **date, contact, duration and outcome**; no recordings.",
      "- The download button prepares the file in the background and says when it's ready.",
    ].join("\n"),
    plan: [
      "1. Add the export columns to the call history query.",
      "2. Build the spreadsheet in a background job.",
      "3. Add the download button and the ready notice.",
    ].join("\n"),
  },
};
