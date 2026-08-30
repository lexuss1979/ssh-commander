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
  'common.refresh': 'Refresh',
  'common.updated': 'Updated {time}',
  'common.of': 'of',

  'login.hint': 'Enter the password to access the web interface',
  'login.passwordPlaceholder': 'Password',
  'login.submit': 'Sign in',
  'login.submitting': 'Signing in…',

  'markdown.copyTitle': 'Copy',
  'markdown.copyAria': 'Copy code',
  'markdown.insertSqlTitle': 'Insert SQL into the editor on the "Databases" tab',
  'markdown.insertSqlAria': 'Insert SQL into the editor',

  'time.justNow': 'just now',
  'time.minutesAgo': (n: number) => `${n} min ago`,
  'time.hoursAgo': (n: number) => `${n} hour${n === 1 ? '' : 's'} ago`,

  'sparkline.collecting': 'Collecting history…',
  'sparkline.statMin': 'min',
  'sparkline.statAvg': 'avg',
  'sparkline.statMax': 'max',
  'sparkline.span': (min: number) => {
    if (min < 60) return `last ${min} min`;
    const h = Math.floor(min / 60);
    const rest = min % 60;
    return rest > 0 ? `last ${h} h ${rest} min` : `last ${h} h`;
  },

  'servers.openOverview': 'Open {name} overview',
  'servers.externalIp': 'External IP',
  'servers.memory': 'Memory',
  'servers.disk': 'Disk',
  'servers.uptime': 'Uptime',
  'servers.containers': 'Containers',
  'servers.dockerNoData': 'Docker: no data',
  'servers.unavailable': 'Unavailable',
  'servers.noData': 'no data',
  'servers.empty': 'No servers added. Add a server via "Server management" in the left panel.',
};
