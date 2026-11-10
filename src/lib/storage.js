import { normalizeConfig } from './rules.js';

export const STORAGE_KEY = 'config';

export async function loadConfig(api) {
  const stored = await api.storage.local.get(STORAGE_KEY);
  return normalizeConfig(stored[STORAGE_KEY]);
}

export async function saveConfig(api, config) {
  const normalized = normalizeConfig(config);
  await api.storage.local.set({ [STORAGE_KEY]: normalized });
  return normalized;
}
