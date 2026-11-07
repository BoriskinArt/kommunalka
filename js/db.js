// Хранилище в IndexedDB. Схема только дополняется новыми версиями — данные никогда не удаляются при обновлении.
import { SERVICE_KEYS, totalOf } from './money.js';

const DB_NAME = 'kommunalka';
const DB_VERSION = 1;
export const DEFAULT_APARTMENTS = [
  { id: 'apt-76', number: '76', order: 1 },
  { id: 'apt-211', number: '211', order: 2 },
  { id: 'apt-231', number: '231', order: 3 },
  { id: 'apt-5', number: '5', order: 4 },
];

let dbp = null;
function open() {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      const tx = req.transaction;
      if (e.oldVersion < 1) {
        const apts = db.createObjectStore('apartments', { keyPath: 'id' });
        db.createObjectStore('records', { keyPath: 'key' }).createIndex('byApt', 'aptId');
        db.createObjectStore('meta', { keyPath: 'k' });
        for (const a of DEFAULT_APARTMENTS) apts.put(a);
      }
      // Будущие миграции: if (e.oldVersion < 2) { … } — только добавление, без удаления данных.
      void tx;
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('База занята другой вкладкой приложения. Закройте её и повторите.'));
  });
  return dbp;
}

function run(storeNames, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, mode);
    let result;
    Promise.resolve(fn(tx)).then((r) => { result = r; }, reject);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Операция отменена'));
  }));
}
const req2p = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const recordKey = (aptId, period) => `${aptId}|${period}`;

export async function requestPersistence() {
  try {
    if (navigator.storage?.persisted && (await navigator.storage.persisted())) return true;
    return (await navigator.storage?.persist?.()) ?? false;
  } catch { return false; }
}

export function listApartments() {
  return run(['apartments'], 'readonly', (tx) => req2p(tx.objectStore('apartments').getAll()))
    .then((list) => list.sort((a, b) => a.order - b.order));
}
export function addApartment(number) {
  const id = `apt-${number}-${Date.now().toString(36)}`;
  return listApartments().then((list) => {
    if (list.some((a) => a.number === number)) throw new Error(`Квартира № ${number} уже есть`);
    const order = Math.max(0, ...list.map((a) => a.order)) + 1;
    return run(['apartments'], 'readwrite', (tx) => req2p(tx.objectStore('apartments').put({ id, number, order })));
  });
}
export function deleteApartment(id) {
  return run(['apartments', 'records'], 'readwrite', async (tx) => {
    const keys = await req2p(tx.objectStore('records').index('byApt').getAllKeys(id));
    for (const k of keys) tx.objectStore('records').delete(k);
    tx.objectStore('apartments').delete(id);
  });
}

export function getRecord(aptId, period) {
  return run(['records'], 'readonly', (tx) => req2p(tx.objectStore('records').get(recordKey(aptId, period))));
}
export function listRecords() {
  return run(['records'], 'readonly', (tx) => req2p(tx.objectStore('records').getAll()));
}

function validateAmounts(amounts) {
  const clean = {};
  for (const k of SERVICE_KEYS) {
    const v = amounts[k];
    if (!Number.isInteger(v)) throw new Error('Не все суммы заполнены');
    clean[k] = v;
  }
  return clean;
}

/**
 * Сохраняет запись. Если запись уже есть и overwrite !== true — бросает ошибку с кодом EXISTS.
 */
export function saveRecord({ aptId, period, amounts, source = 'manual', fileName = null }, { overwrite = false } = {}) {
  const clean = validateAmounts(amounts);
  const total = totalOf(clean);
  return run(['records'], 'readwrite', async (tx) => {
    const store = tx.objectStore('records');
    const key = recordKey(aptId, period);
    const existing = await req2p(store.get(key));
    if (existing && !overwrite) {
      const err = new Error('EXISTS');
      err.code = 'EXISTS';
      err.existing = existing;
      tx.abort();
      throw err;
    }
    const now = new Date().toISOString();
    const rec = { key, aptId, period, amounts: clean, total, source, fileName, createdAt: existing?.createdAt || now, updatedAt: now };
    store.put(rec);
    return rec;
  });
}

export function deleteRecord(aptId, period) {
  return run(['records'], 'readwrite', (tx) => req2p(tx.objectStore('records').delete(recordKey(aptId, period))));
}

export function getMeta(k) {
  return run(['meta'], 'readonly', (tx) => req2p(tx.objectStore('meta').get(k))).then((r) => r?.v);
}
export function setMeta(k, v) {
  return run(['meta'], 'readwrite', (tx) => req2p(tx.objectStore('meta').put({ k, v })));
}

// ---------- резервная копия ----------

export async function exportAll() {
  const [apartments, records, accountMap] = await Promise.all([listApartments(), listRecords(), getMeta('accountMap')]);
  return { app: 'kommunalka', format: 1, exportedAt: new Date().toISOString(), apartments, records, accountMap: accountMap || {} };
}

export function validateBackup(data) {
  if (!data || data.app !== 'kommunalka' || data.format !== 1) throw new Error('Это не резервная копия приложения «Коммунальные платежи».');
  if (!Array.isArray(data.apartments) || !Array.isArray(data.records)) throw new Error('Файл повреждён: нет списка квартир или записей.');
  const aptIds = new Set();
  for (const a of data.apartments) {
    if (typeof a.id !== 'string' || typeof a.number !== 'string') throw new Error('Файл повреждён: неверная запись квартиры.');
    aptIds.add(a.id);
  }
  for (const r of data.records) {
    if (!aptIds.has(r.aptId) || !/^\d{4}-\d{2}$/.test(r.period)) throw new Error('Файл повреждён: неверная запись начислений.');
    validateAmounts(r.amounts || {});
    if (r.key !== recordKey(r.aptId, r.period)) throw new Error('Файл повреждён: неверный ключ записи.');
  }
  return { apartments: data.apartments.length, records: data.records.length };
}

/** Полная замена данных копией. Перед заменой текущие данные сохраняются в meta.beforeImport. */
export async function importReplace(data) {
  validateBackup(data);
  const before = await exportAll();
  await run(['apartments', 'records', 'meta'], 'readwrite', (tx) => {
    tx.objectStore('meta').put({ k: 'beforeImport', v: before });
    tx.objectStore('apartments').clear();
    tx.objectStore('records').clear();
    for (const a of data.apartments) tx.objectStore('apartments').put({ id: a.id, number: a.number, order: a.order ?? 99 });
    for (const r of data.records) {
      const amounts = validateAmounts(r.amounts);
      tx.objectStore('records').put({ ...r, amounts, total: totalOf(amounts) });
    }
    tx.objectStore('meta').put({ k: 'accountMap', v: data.accountMap || {} });
  });
}
