import { writer, forbidden } from "../writer";
import { startManualAnalysis } from "./analysis";
import { analysisView, canOperateServer, serverFor, type ServerAnalysisView } from "./visibility";

// L'analisi a mano di un server (area 8, F4b, R0-A2), `POST
// /api/servers/:id/analyses` sul server: «Ask Claude to look into it» dal
// dettaglio. Un server invisibile (o inesistente) è `not_found`; visibile
// senza `servers.operate` in nessun progetto il cui ambiente lo usa,
// `forbidden`; il resto (una in corso, l'accesso, il budget) lo dice
// `startManualAnalysis`.

export async function startServerAnalysis(code: string): Promise<ServerAnalysisView> {
  const me = await writer("servers.startServerAnalysis");
  const server = serverFor(me, code);
  if (!canOperateServer(me, server.code)) throw forbidden();
  return analysisView(me, startManualAnalysis(server, me));
}
