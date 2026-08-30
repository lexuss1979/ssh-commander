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
  'common.retry': 'Retry',
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

  'aiCosts.period7': '7 days',
  'aiCosts.period30': '30 days',
  'aiCosts.period90': '90 days',
  'aiCosts.periodAll': 'All time',
  'aiCosts.tipCalls': 'Calls: {n}',
  'aiCosts.tipPrompt': 'Input: {n} tokens',
  'aiCosts.tipCached': 'Cached input: {n} tokens',
  'aiCosts.tipCompletion': 'Output: {n} tokens',
  'aiCosts.tipUnpriced': 'Incomplete total: {n} calls without price',
  'aiCosts.noConnection': 'No connection: {error}',
  'aiCosts.periodTitle': 'Report period',
  'aiCosts.loadFailed': 'Failed to load the cost report: {error}',
  'aiCosts.totalForPeriod': 'Total for period',
  'aiCosts.avgPerDay': 'Daily average',
  'aiCosts.calls': 'Calls',
  'aiCosts.unpricedHint': '{n} calls without model price — totals are incomplete. Add prices to',
  'aiCosts.date': 'Date',
  'aiCosts.total': 'Total',
  'aiCosts.emptyPeriod': 'No expenses for the selected period',
  'aiCosts.loading': 'Loading cost report…',

  'diskUsage.title': 'Disk usage · {name}',
  'diskUsage.modeDirs': 'Directories',
  'diskUsage.modeFiles': 'Files',
  'diskUsage.openInFilesTitle': 'Open this path in the "Files" tab',
  'diskUsage.openInFiles': 'Open in Files',
  'diskUsage.cancelled': 'Scan cancelled.',
  'diskUsage.incompleteDirs': 'Some directories are inaccessible (permission denied) — figures are incomplete',
  'diskUsage.truncatedDu': 'du output truncated — the total is incomplete',
  'diskUsage.total': 'Total',
  'diskUsage.openPath': 'Open {path}',
  'diskUsage.directFiles': 'files in this directory',
  'diskUsage.emptyDir': 'Directory is empty',
  'diskUsage.incompleteFiles': 'Some directories are inaccessible (permission denied) — the list is incomplete',
  'diskUsage.openParentTitle': 'Open parent directory in the "Files" tab',
  'diskUsage.toFiles': 'To files',
  'diskUsage.noFiles': 'No files found',
  'diskUsage.showingFirst': 'Showing the first {n}',
  'diskUsage.scanDirs': 'Scanning directories…',
  'diskUsage.scanFiles': 'Searching for the largest files…',
  'diskUsage.scanNote': '— the server scan may take tens of seconds; progress is not reported, the bar only shows the request is running.',
  'diskUsage.elapsedSec': '{n} s',
};
