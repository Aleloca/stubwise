// La conferma del login del desktop dal browser (integrazione area 2, Task
// 21): la pagina `/app/#/desktop-login` chiede il codice monouso con un clic.
// Nel prototipo non c'è un desktop che lo aspetti: la pagina esiste (si può
// aprire a mano), e «Allow» risponde che qui non si può.

export type DesktopHandoffResult =
  | { ok: true; code: string }
  | { ok: false; error: "reauth_required" | "not_available" | "failed" };

export async function desktopHandoff(input: {
  codeChallenge: string;
  deviceName: string;
}): Promise<DesktopHandoffResult> {
  void input;
  return { ok: false, error: "not_available" };
}
