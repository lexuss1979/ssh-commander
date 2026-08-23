// Минимальный eslint для `web/`: цель — не «стиль», а класс ошибок, который
// не видят ни `tsc`, ни тесты сервера и который всплывает только в браузере.
// Повод: React #310 (эпик 20) — `useMemo` стоял ниже `if (authed === null)
// return`, из-за чего второй рендер вызывал на один хук больше.
//
// Правила стиля намеренно не включены: форматирование в проекте
// выдерживается вручную, а шумный линтер в pre-commit только мешал бы.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'eslint.config.js'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // Ради этих двух правил линтер и заведён.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',

      // Шум, не относящийся к цели: код осознанно использует `any` в местах
      // разбора внешнего JSON, а неиспользуемые аргументы — часть сигнатур.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none',
      }],
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },
);
