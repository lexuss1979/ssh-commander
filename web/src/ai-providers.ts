// Пресеты AI-провайдеров (docs/settings-model-plan.md): пресет несёт base и
// модель — пресет без модели не работает. Общий модуль onboarding'а и
// страницы «Настройки» (эпик 23). «Свой URL» — пустой пресет: base и модель
// заполняет человек; срез хвостового '/' у base делает сервер.

export type AiProvider = 'deepseek' | 'openai' | 'opencode-go' | 'custom';

export const PROVIDERS: Record<AiProvider, { base: string; model: string }> = {
  deepseek: { base: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash' },
  openai: { base: 'https://api.openai.com/v1', model: 'gpt-4.1-mini' },
  'opencode-go': { base: 'https://opencode.ai/zen/go/v1', model: 'glm-5.3-flash' },
  custom: { base: '', model: '' },
};
