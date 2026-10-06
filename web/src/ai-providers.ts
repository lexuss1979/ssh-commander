// AI provider presets (docs/settings-model-plan.md): a preset carries a base
// and a model — a preset without a model does not work. Shared by onboarding
// and the "Settings" page (epic 23). "Custom URL" is an empty preset: the
// human fills in the base and the model; trimming the trailing '/' of the
// base is done by the server.

export type AiProvider = 'deepseek' | 'openai' | 'opencode-go' | 'custom';

export const PROVIDERS: Record<AiProvider, { base: string; model: string }> = {
  deepseek: { base: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash' },
  openai: { base: 'https://api.openai.com/v1', model: 'gpt-4.1-mini' },
  'opencode-go': { base: 'https://opencode.ai/zen/go/v1', model: 'glm-5.3-flash' },
  custom: { base: '', model: '' },
};
