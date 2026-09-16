import { deleteToken, getMessaging } from "@react-native-firebase/messaging";
import type { StubwiseClient } from "@stubwise/api-client";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { getPushToken } from "../../lib/push-token";
import { clearSession, loadSession } from "../../lib/storage";

/**
 * Il logout, estratto dalla pagina Impostazioni il 16 set 2026 quando quella
 * si è divisa in indice e sotto-pagine: «Esci» è rimasto sull'INDICE (è
 * l'unica azione che non è un'impostazione, e si cerca con fretta), mentre il
 * client e la pulizia vivono dove li usa chi naviga.
 *
 * Ogni passo remoto è **best-effort ma mai silenzioso** (stesso principio di
 * `lib/push.ts`): un logout che sembra riuscito lasciando vivo un device push
 * o un PAT dall'altra parte è il guasto peggiore da diagnosticare più tardi.
 * La pulizia LOCALE invece non è best-effort — avviene comunque, in fondo.
 */
export function useLogout(client: StubwiseClient | null, onLoggedOut: () => void) {
  const queryClient = useQueryClient();
  const [loggingOut, setLoggingOut] = useState(false);

  async function logout(): Promise<void> {
    // `null` solo nell'istante fra il mount della rotta e la guardia del
    // chiamante: gli hook non possono essere condizionali, quindi l'hook gira
    // comunque. Meglio accettarlo qui che un `!` alla chiamata, che sarebbe
    // un'asserzione su qualcosa che il tipo sa di non poter garantire.
    if (client === null) return;
    setLoggingOut(true);
    const session = await loadSession().catch(() => null);
    const pushToken = await getPushToken().catch(() => null);

    try {
      if (pushToken) await client.me.deleteDevice(pushToken.token);
    } catch (error) {
      // Best-effort, mai silenzioso (stesso principio di `lib/push.ts`): un
      // logout che sembra riuscito ma ha lasciato un device o un PAT vivi
      // dall'altra parte è il guasto peggiore da diagnosticare più tardi.
      console.warn("stubwise: logout — cancellazione del device push fallita (best-effort)", error);
    }

    try {
      if (session?.patId) await client.pats.revoke(session.patId);
    } catch (error) {
      console.warn("stubwise: logout — revoca del PAT fallita (best-effort)", error);
    }

    try {
      await deleteToken(getMessaging());
    } catch (error) {
      console.warn("stubwise: logout — invalidazione del token FCM fallita (best-effort)", error);
    }

    await clearSession();
    queryClient.clear();
    setLoggingOut(false);
    onLoggedOut();
  }

  return { logout: () => void logout(), loggingOut };
}
