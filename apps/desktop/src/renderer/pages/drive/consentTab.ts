import { isAppBuild } from "../../data/build";

/**
 * Web (build app nel browser): la scheda del consenso Google si apre NEL
 * clic, vuota, e riceve l'URL quando il server l'ha dato — aperta dopo le
 * richieste, Safari la bloccherebbe senza dirlo. Sul desktop (c'è il ponte
 * del preload) il link va al browser di sistema: nessuna scheda da qui. Nel
 * prototipo nemmeno.
 */
export function openConsentTab(): Window | null {
  const bridge = (window as { stubwise?: { api?: unknown } }).stubwise;
  if (!isAppBuild() || bridge?.api) return null;
  const tab = window.open("", "_blank");
  // Senza `noopener` (servirebbe la scheda per darle l'URL dopo): l'opener si
  // taglia SUBITO, prima che carichi la pagina di Google (M4 della revisione
  // di sicurezza della cassaforte nel browser).
  if (tab) tab.opener = null;
  return tab;
}
