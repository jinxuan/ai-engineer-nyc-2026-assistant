import fs from 'node:fs';
import path from 'node:path';

// UI strings and prompts are English in the repo. A gitignored local/ folder can override them
// (local/strings.json, local/prompts/<name>) and the settings (local/config.json).

const root = path.join(import.meta.dirname, '..');
const read = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
};

export const strings = { ...read(path.join(root, 'strings/en.json')), ...read(path.join(root, 'local/strings.json')) };
export const localConfig = read(path.join(root, 'local/config.json'));

export function t(key, vars = {}) {
  return (strings[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
}

export function promptPath(name) {
  const local = path.join(root, 'local/prompts', name);
  return fs.existsSync(local) ? local : path.join(root, 'prompts', name);
}

export const readPrompt = (name) => fs.promises.readFile(promptPath(name), 'utf8');
