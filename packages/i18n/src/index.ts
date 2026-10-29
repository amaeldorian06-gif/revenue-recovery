import fr from './messages.fr.json' with { type: 'json' };
import en from './messages.en.json' with { type: 'json' };

export const LOCALES = ['fr', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'fr';

const DICTIONARIES: Record<Locale, Record<string, string>> = { fr, en };

export function isLocale(value: string | undefined): value is Locale {
  return value === 'fr' || value === 'en';
}

export type MessageKey = keyof typeof fr;

/**
 * Minimal typed translator. Deliberately dependency-free in phase 01: the
 * surface is eight screens, and a typed dictionary makes a missing key a
 * compile error. Swapping to next-intl later is mechanical (DECISIONS.md #4).
 */
export function t(locale: Locale, key: MessageKey): string {
  return DICTIONARIES[locale][key] ?? DICTIONARIES[DEFAULT_LOCALE][key] ?? key;
}

export function translator(locale: Locale) {
  return (key: MessageKey) => t(locale, key);
}
