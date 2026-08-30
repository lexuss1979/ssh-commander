import type { ru } from './ru';

// Английский словарь. Тип `typeof ru` делает пропуск ключа, лишний ключ
// и расхождение сигнатуры функции ошибкой компиляции; тест
// server/test/i18n.test.ts — второй эшелон (паритет плейсхолдеров).
export const en: typeof ru = {
  'common.loading': 'Loading…',
  'common.save': 'Save',
  'common.cancel': 'Cancel',
  'common.delete': 'Delete',
  'common.close': 'Close',
  'common.language': 'Language',
  'common.errorRequest': 'Request failed',

  'login.hint': 'Enter the password to access the web interface',
  'login.passwordPlaceholder': 'Password',
  'login.submit': 'Sign in',
  'login.submitting': 'Signing in…',

  'time.justNow': 'just now',
  'time.minutesAgo': (n: number) => `${n} min ago`,
  'time.hoursAgo': (n: number) => `${n} hour${n === 1 ? '' : 's'} ago`,
};
