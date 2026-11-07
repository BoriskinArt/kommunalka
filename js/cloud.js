// Облачная копия в приватный репозиторий GitHub через REST API (Contents).
// Токен хранится только на телефоне (IndexedDB, meta.cloud) и в резервную копию не попадает.
import * as db from './db.js';

const API = 'https://api.github.com';
export const CLOUD_FILE = 'kommunalka-backup.json';

export const getCloud = async () => (await db.getMeta('cloud')) || null;
async function patchCloud(patch) {
  const cur = await getCloud();
  if (cur) await db.setMeta('cloud', { ...cur, ...patch });
}
export const markPending = () => patchCloud({ pending: true });
export const disconnect = () => db.setMeta('cloud', null);

class CloudError extends Error {}

async function gh(cfg, path, { method = 'GET', body, raw = false } = {}) {
  let res;
  try {
    res = await fetch(`${API}/repos/${cfg.repo}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
  } catch {
    throw new CloudError('Нет связи с GitHub. Проверьте интернет.');
  }
  return res;
}

function explain(res, what) {
  if (res.status === 401) return new CloudError('Токен не подходит или истёк. Создайте новый и подключите заново.');
  if (res.status === 403) return new CloudError('У токена нет права на запись. Нужно разрешение Contents: Read and write.');
  if (res.status === 404) return new CloudError('Репозиторий не найден, или токен к нему не допущен.');
  return new CloudError(`GitHub ответил ошибкой ${res.status} (${what}).`);
}

function toBase64Utf8(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Проверяет доступ к репозиторию. Возвращает { private }. */
export async function check(repo, token) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new CloudError('Репозиторий укажите так: логин/имя, например BoriskinArt/kommunalka-data.');
  if (!token) throw new CloudError('Вставьте токен.');
  const res = await gh({ repo, token }, '');
  if (!res.ok) throw explain(res, 'проверка репозитория');
  const info = await res.json();
  return { private: Boolean(info.private) };
}

export async function saveConfig(repo, token) {
  await db.setMeta('cloud', { repo, token, lastPush: null, lastError: null, pending: false });
}

/** Читает копию из облака. null — копии ещё нет. */
export async function pull(cfg) {
  cfg ??= await getCloud();
  const res = await gh(cfg, `/contents/${CLOUD_FILE}`, { raw: true });
  if (res.status === 404) {
    // 404 бывает и у самого репозитория — различаем.
    const repoRes = await gh(cfg, '');
    if (!repoRes.ok) throw explain(repoRes, 'чтение репозитория');
    return null;
  }
  if (!res.ok) throw explain(res, 'чтение копии');
  try {
    return JSON.parse(await res.text());
  } catch {
    throw new CloudError('Копия в облаке повреждена (не JSON).');
  }
}

/** Отправляет все данные в облако, заменяя прежнюю копию (история версий остаётся в GitHub). */
export async function push() {
  const cfg = await getCloud();
  if (!cfg) return null;
  try {
    const data = await db.exportAll();
    const meta = await gh(cfg, `/contents/${CLOUD_FILE}`);
    let sha;
    if (meta.ok) sha = (await meta.json()).sha;
    else if (meta.status !== 404) throw explain(meta, 'чтение копии');
    const res = await gh(cfg, `/contents/${CLOUD_FILE}`, {
      method: 'PUT',
      body: {
        message: `Копия: ${data.records.length} зап., ${new Date().toLocaleString('ru-RU')}`,
        content: toBase64Utf8(JSON.stringify(data, null, 1)),
        ...(sha ? { sha } : {}),
      },
    });
    if (!res.ok) throw explain(res, 'запись копии');
    await patchCloud({ lastPush: new Date().toISOString(), lastError: null, pending: false });
    return data.records.length;
  } catch (err) {
    await patchCloud({ lastError: err.message, pending: true });
    throw err;
  }
}
