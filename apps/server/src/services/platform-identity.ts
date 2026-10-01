import { getProvider } from "@stubwise/git";
import type { FetchPlatformIdentity } from "@stubwise/notifications";

/**
 * Il {@link FetchPlatformIdentity} del server: chi è il token sulla
 * piattaforma. Un modulo a sé perché lo usano il webhook "Request changes" e
 * la validazione dell'account revisore, e i test lo intercettano spiando
 * `getAuthenticatedUserId` sul prototype del provider.
 */
export const fetchPlatformIdentity: FetchPlatformIdentity = ({ provider, credentials }) =>
  getProvider(provider).getAuthenticatedUserId({ credentials });
