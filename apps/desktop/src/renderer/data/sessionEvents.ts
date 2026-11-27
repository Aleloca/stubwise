// «La sessione è finita a metà» (integrazione area 2, fetta 1): lo dice il
// trasporto della build app quando un 401 arriva mentre si era dentro
// (`backend/real/client.ts`), e lo ascolta `AppViewerProvider`, che azzera la
// cache e rilegge chi è dentro. Puro e condiviso dalle due build: nel
// prototipo la sessione non finisce da sola, quindi non scatta mai.

const listeners = new Set<() => void>();

export function onSessionLost(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function emitSessionLost(): void {
  for (const fn of listeners) fn();
}

// «Esci» (cassaforte nel browser, design §8): chi tiene un segreto della
// sessione lo butta. Lo emette il logout della build app, dopo la rotta.
const loggedOut = new Set<() => void>();

export function onLoggedOut(fn: () => void): () => void {
  loggedOut.add(fn);
  return () => {
    loggedOut.delete(fn);
  };
}

export function emitLoggedOut(): void {
  for (const fn of loggedOut) fn();
}

// Una sessione NUOVA (cassaforte nel browser, revisione I-3): la build app la
// vede quando `/api/auth/me` dà un `sessionTag` diverso dall'ultimo.
const started = new Set<() => void>();

export function onSessionStarted(fn: () => void): () => void {
  started.add(fn);
  return () => {
    started.delete(fn);
  };
}

export function emitSessionStarted(): void {
  for (const fn of started) fn();
}
