// Il riconoscimento di un segnaposto («hidden-N»), senza nessun import: lo
// usano le pagine in tutte e due le build. Sta qui e non in `hidden.ts`, che
// importa il seme delle persone e (per `whoCan`) lo stato del prototipo: una
// pagina che lo prendeva da lì portava tutto il seme nel bundle dell'app
// (25 nov 2026; `architecture.test.ts`, «l'app non tocca il prototipo»).

/** Il campo è un segnaposto: non si risolve, non si clicca, non torna al server. */
export const isHiddenId = (id: string | null | undefined): boolean =>
  typeof id === "string" && id.startsWith("hidden-");
