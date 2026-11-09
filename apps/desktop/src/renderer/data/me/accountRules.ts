// Le regole dei campi dell'account (password, email), senza stato: `account.ts` le ri-esporta.

export const MIN_PASSWORD_LENGTH = 8;

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
