import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import type { TicketScreenProps } from "../../app/navigation";
import { useAuth } from "../../app/providers";
import { Skeleton } from "../../components/Skeleton";
import { agentSessionsLookupQueryOptions, firstSession } from "../../lib/agent-sessions-queries";
import { replaceWithAgentSession } from "../../lib/open-agent-session";
import { colors } from "../../theme/tokens";

type Props = TicketScreenProps<"AgentSessionByJob">;

/**
 * Dal job alla sua sessione (piano C, Task 8; gemello di
 * `apps/web/src/routes/agents/by-job.tsx`): ci arriva «Apri» di una domanda
 * dell'agente. Cerca la sessione per `aiJobId` e, se c'è, la apre sulla
 * domanda (`focus: "question"`).
 *
 * Se non c'è — nessuna sessione registrata, server senza le rotte (404 senza
 * `code`), errore qualunque — va al ticket, su Stato; senza nemmeno il
 * ticket, torna indietro. Mai resta nello stack, o l'indietro della
 * destinazione ci tornerebbe e ripartirebbe: il ticket la sostituisce
 * (`replace`, stesso stack); la sessione sta sul ROOT stack (9 ott 2026), e
 * `replaceWithAgentSession` la apre lassù togliendo questa di qui.
 *
 * Resta negli stack delle schede (Inbox e Progetti, dove ci sono le card), e
 * non sale al root con la sessione: il ripiego sul ticket deve aprirlo nello
 * stack da cui si è venuti, e dal root non si saprebbe quale.
 *
 * Nessun polling né retry (`agentSessionsLookupQueryOptions` senza `poll`):
 * un errore è già una risposta, e non va riprovato prima di cambiare pagina.
 */
export function AgentSessionByJobScreen({ navigation, route }: Props) {
  const { client } = useAuth();
  const { jobId, ticketId } = route.params;
  const { data, isPending } = useQuery({
    ...agentSessionsLookupQueryOptions(client!, { aiJobId: jobId }),
    enabled: client !== null,
  });

  useEffect(() => {
    // Senza client la query non parte e resterebbe `pending` per sempre: si
    // ripiega subito, invece di uno skeleton infinito.
    if (client !== null && isPending) return;
    const session = firstSession(data);
    if (session !== undefined) {
      replaceWithAgentSession(navigation, { id: session.id, focus: "question" });
    } else if (ticketId !== undefined) {
      navigation.replace("Ticket", { id: ticketId, tab: "status" });
    } else {
      navigation.goBack();
    }
  }, [client, isPending, data, ticketId, navigation]);

  return (
    <View style={styles.container} testID="agent-session-by-job-skeleton">
      <Skeleton height={60} />
      <Skeleton height={60} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.ink950,
    flex: 1,
    gap: 12,
    padding: 16,
    paddingTop: 72,
  },
});
