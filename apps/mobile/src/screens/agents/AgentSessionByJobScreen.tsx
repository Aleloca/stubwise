import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import type { TicketParamList } from "../../app/navigation";
import { useAuth } from "../../app/providers";
import { Skeleton } from "../../components/Skeleton";
import { agentSessionsLookupQueryOptions, firstSession } from "../../lib/agent-sessions-queries";
import { colors } from "../../theme/tokens";

type Props = NativeStackScreenProps<TicketParamList, "AgentSessionByJob">;

/**
 * Dal job alla sua sessione (piano C, Task 8; gemello di
 * `apps/web/src/routes/agents/by-job.tsx`): ci arriva «Apri» di una domanda
 * dell'agente. Cerca la sessione per `aiJobId` e, se c'è, la apre sulla
 * domanda (`focus: "question"`).
 *
 * Se non c'è — nessuna sessione registrata, server senza le rotte (404 senza
 * `code`), errore qualunque — va al ticket, su Stato; senza nemmeno il
 * ticket, torna indietro. Sempre `replace`: questa schermata non deve restare
 * nello stack, o l'indietro della destinazione ci tornerebbe e ripartirebbe.
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
      navigation.replace("AgentSession", { id: session.id, focus: "question" });
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
