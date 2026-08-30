// Русский словарь UI. Это единственный файл вне комментариев, где живут
// русские строки: все user-visible тексты выносятся сюда по правилам
// docs/i18n-execution-plan.md (§3).
//
// Значение — строка с именованными {placeholders} или функция для форм
// со склонениями/числительными. Ключи: '<пространство>.<смысл>' в camelCase,
// пространства — по страницам/компонентам, повторяющееся — в common.*.

/** Русская плюрализация: plural(1, ...) → one, (2..4) → few, (0, 5..) → many. */
export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

export const ru = {
  'common.loading': 'Загрузка…',
  'common.save': 'Сохранить',
  'common.cancel': 'Отмена',
  'common.delete': 'Удалить',
  'common.close': 'Закрыть',
  'common.language': 'Язык',
  'common.errorRequest': 'Ошибка запроса',

  'login.hint': 'Введите пароль для доступа к веб-интерфейсу',
  'login.passwordPlaceholder': 'Пароль',
  'login.submit': 'Войти',
  'login.submitting': 'Вход…',

  'markdown.copyTitle': 'Копировать',
  'markdown.copyAria': 'Копировать код',
  'markdown.insertSqlTitle': 'Вставить SQL в редактор на вкладке «Базы данных»',
  'markdown.insertSqlAria': 'Вставить SQL в редактор',

  'time.justNow': 'только что',
  'time.minutesAgo': (n: number) => `${n} мин назад`,
  'time.hoursAgo': (n: number) => `${n} ${plural(n, 'час', 'часа', 'часов')} назад`,

  'sparkline.collecting': 'История собирается…',
  'sparkline.statMin': 'мин',
  'sparkline.statAvg': 'сред',
  'sparkline.statMax': 'макс',
  'sparkline.span': (min: number) => {
    if (min < 60) return `за ${min} мин`;
    const h = Math.floor(min / 60);
    const rest = min % 60;
    return rest > 0 ? `за ${h} ч ${rest} мин` : `за ${h} ч`;
  },
};
