// PRIMO import del main: Zod non prova `new Function` (la CSP dell'origine non
// ammette eval; vedi `zodWithoutEval` in @stubwise/shared/csp).
// Il sottopercorso, non l'indice: l'indice valuta tutti gli schemi prima di
// questa riga, e uno di loro farebbe partire la sonda di Zod.
import { zodWithoutEval } from "@stubwise/shared/csp";

zodWithoutEval();
