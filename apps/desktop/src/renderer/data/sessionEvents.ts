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
