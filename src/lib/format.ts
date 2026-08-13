export function nowIso(): string {
  return new Date().toISOString();
}

export function formatMoney(minor: number, currency = 'EUR', locale = 'en-GB'): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(minor / 100);
}

export function formatDate(value: string, locale = 'en-GB'): string {
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Europe/Rome',
  }).format(new Date(`${value}T12:00:00+02:00`));
}

export function parseMoneyToMinor(value: unknown): number {
  const normalized = String(value ?? '').trim().replace(',', '.');
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) throw new Error('Invalid monetary amount');
  const [whole, decimals = ''] = normalized.split('.');
  return Number(whole) * 100 + Number(decimals.padEnd(2, '0'));
}

export function toDateInput(value: string | null | undefined): string {
  return value?.slice(0, 10) ?? '';
}

export function addHoursEpoch(hours: number): number {
  return Math.floor(Date.now() / 1000) + hours * 60 * 60;
}
