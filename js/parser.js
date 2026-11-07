// Разбор квитанции. Чистый модуль без DOM: работает и в браузере, и в Node (тесты).
//
// Вход: pages = [{ items: [{ str, x, y, w, h, conf? }], source: 'pdf' | 'ocr' }]
//   x, y — левый верхний угол фрагмента в координатах «сверху вниз», w/h — размеры.
// Выход: { apartment, account, period, services, warnings, mode }.

import { parseMoneyStrict, SERVICE_KEYS } from './money.js';

const MONTHS = [
  ['январ', 1], ['феврал', 2], ['март', 3], ['апрел', 4], ['ма[йя]', 5], ['июн', 6],
  ['июл', 7], ['август', 8], ['сентябр', 9], ['октябр', 10], ['ноябр', 11], ['декабр', 12],
];

// Латинские буквы, похожие на кириллические (частая ошибка OCR и некоторых PDF).
const LAT2CYR = { a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', k: 'к', m: 'м', o: 'о', p: 'р', t: 'т', x: 'х', y: 'у', u: 'и', r: 'г', n: 'п' };

export function normalizeText(s) {
  return String(s)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[a-z]/g, (ch) => LAT2CYR[ch] ?? ch)
    .replace(/[«»"'`]/g, '')
    .replace(/[‐‑‒–—―]/g, '-')
    .replace(/\s*\/\s*/g, '/')
    .replace(/\s+/g, ' ')
    .trim();
}

// Словарь для исправления опечаток OCR (расстояние Левенштейна ≤ 1–2).
const VOCAB = [
  'электроснабжение', 'электроэнергия', 'электричество', 'электрическая', 'водоотведение',
  'водоснабжение', 'холодное', 'холодная', 'горячее', 'горячая', 'носитель', 'подогрев',
  'энергия', 'канализация', 'отопление', 'двухтарифный', 'начислено', 'тарифу',
];
function lev(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}
function fixTypos(norm) {
  return norm.replace(/[а-я]{7,}/g, (w) => {
    if (VOCAB.includes(w)) return w;
    for (const v of VOCAB) {
      const max = v.length >= 12 ? 2 : 1;
      if (lev(w, v, max) <= max) return v;
    }
    return w;
  });
}

const L = '[а-я0-9/]'; // «буква» в сжатой строке

/** Признак общедомовых начислений: ОДН, СОИ, общее имущество. */
export function isCommonHouse(norm) {
  const tokens = norm.split(/[^а-я0-9]+/).filter(Boolean);
  for (const t of tokens) {
    if (t === 'одн' || t === 'сои' || t === 'мкд' || t === 'моп') return true;
    if (/(одн|сои)$/.test(t) && !/^холод/.test(t) && t.length <= 12) return true; // «гвсодн»
  }
  return /общедом|общ[а-я]*\s*имущ|содерж[а-я]*\s*общ/.test(norm);
}

/**
 * Определяет категорию услуги по названию строки.
 * @returns {{key:string|null, reason?:string, ambiguous?:boolean, excluded?:boolean}}
 */
export function classifyService(name, { electricityContext = true } = {}) {
  const norm = fixTypos(normalizeText(name));
  if (!/[а-я]/.test(norm)) return { key: null };
  if (isCommonHouse(norm)) return { key: null, excluded: true, reason: 'ОДН/СОИ' };
  const c = norm.replace(/[\s.,:;()\-–_]+/g, '');

  if (/водоотвед|канализ|канал|стоки|сточн|отведен/.test(c)) return { key: 'drain' };

  if (new RegExp(`носител|(хвс|холодн${L}*?)(для|на)(гвс|горяч|подогр|приготов|нагрев)|водадляприготов|компонент(хвс|холодн)`).test(c)) {
    return { key: 'hotCarrier' };
  }
  const isElectric = /электр|элетр|элктр|элво|элэн|эл\/эн|электроэн/.test(c);
  if (!isElectric && new RegExp(`подогр|нагрев|(гвс|горяч${L}*?)энерг|энерги${L}{0,4}гвс|тепл${L}*?(гвс|подогр|горяч)`).test(c)) {
    return { key: 'hotEnergy' };
  }

  const day = /день|дневн|(^|[^0-9])т1(?![0-9])/.test(c);
  const night = /ночь|ночн|(^|[^0-9])т2(?![0-9])/.test(c);
  if (isElectric) {
    if (day && night) return { key: null, ambiguous: true, reason: 'электроэнергия: в названии и день, и ночь' };
    if (day) return { key: 'elDay' };
    if (night) return { key: 'elNight' };
    if (/отопл/.test(c)) return { key: null };
    return { key: null, ambiguous: true, reason: 'не указано, день это или ночь' };
  }
  // Т1/Т2 и «зоны» без слова «электро» — только при контексте электроэнергии в документе.
  if (/^(тариф)?т[12]$|дневнаязона|ночнаязона|дневноепотреб|ночноепотреб/.test(c)) {
    if (!electricityContext) return { key: null, ambiguous: true, reason: 'Т1/Т2, но в квитанции нет электроэнергии' };
    return { key: day ? 'elDay' : 'elNight' };
  }

  if (/хвс|холодн/.test(c)) return { key: 'cold' };
  if (/гвс|горяч/.test(c) && !/отопл/.test(c)) {
    return { key: null, ambiguous: true, reason: 'горячая вода без разделения на носитель и энергию' };
  }
  return { key: null };
}

// ---------- геометрия ----------

const NUM_RE = /^[-−]?\d[\d\s ]*([.,]\d+)?$/;
const isNumeric = (s) => NUM_RE.test(s.trim());
const right = (it) => it.x + it.w;

function median(arr) {
  if (!arr.length) return 0;
  const a = [...arr].sort((p, q) => p - q);
  return a[Math.floor(a.length / 2)];
}

/** Группирует фрагменты в строки по вертикали. */
export function groupLines(items) {
  const clean = items
    .map((it) => ({ ...it, str: String(it.str).replace(/\s+/g, ' ').trim() }))
    .filter((it) => it.str);
  const hMed = median(clean.map((it) => it.h).filter((h) => h > 0)) || 7;
  const tol = hMed * 0.45;
  clean.sort((a, b) => (a.y + a.h / 2) - (b.y + b.h / 2));
  const lines = [];
  for (const it of clean) {
    const cy = it.y + it.h / 2;
    const last = lines[lines.length - 1];
    if (last && Math.abs(cy - last.cy) <= tol) {
      last.items.push(it);
      last.cy = (last.cy * (last.items.length - 1) + cy) / last.items.length;
    } else {
      lines.push({ cy, items: [it] });
    }
  }
  for (const ln of lines) {
    ln.items.sort((a, b) => a.x - b.x);
    ln.items = mergeNumberParts(ln.items, hMed);
    ln.text = ln.items.map((i) => i.str).join(' ');
    ln.norm = normalizeText(ln.text);
  }
  return { lines, hMed };
}

// OCR часто разбивает «1 836,36» на «1» и «836,36». Склеиваем близкие числовые части.
function mergeNumberParts(items, hMed) {
  const out = [];
  for (const it of items) {
    const prev = out[out.length - 1];
    if (prev && /^[-−]?\d{1,3}$/.test(prev.str) && /^\d{3}([.,]\d{2})$/.test(it.str) && it.x - right(prev) < hMed * 0.9) {
      out[out.length - 1] = {
        ...prev, str: `${prev.str} ${it.str}`, w: right(it) - prev.x,
        conf: Math.min(prev.conf ?? 100, it.conf ?? 100), merged: true,
      };
    } else out.push({ ...it });
  }
  return out;
}

// ---------- шапка документа ----------

export function detectPeriod(fullNorm) {
  const found = [];
  for (const [stem, month] of MONTHS) {
    // «за октябрь 2026», «ЗА ОКТЯБРЬ 2026г.», «за ОКТЯБРЬ - 2026»
    const re = new RegExp(`(^|[^а-я0-9])(за\\s+)?${stem}[а-я]*\\.?\\s*-?\\s*(20\\d\\d)`, 'g');
    let m;
    while ((m = re.exec(fullNorm))) {
      const before = fullNorm.slice(Math.max(0, m.index - 4), m.index + m[1].length);
      if (/\d\s*$/.test(before)) continue; // «19 марта 2026» — дата, а не период
      found.push({ month, year: Number(m[3]), withZa: Boolean(m[2]) });
    }
  }
  const pool = found.some((f) => f.withZa) ? found.filter((f) => f.withZa) : found;
  const counts = new Map();
  for (const f of pool) {
    const key = `${f.year}-${String(f.month).padStart(2, '0')}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (!sorted.length) return { period: null };
  if (sorted.length > 1 && sorted[0][1] === sorted[1][1]) {
    return { period: null, conflict: sorted.map((s) => s[0]) };
  }
  return { period: sorted[0][0], alternatives: sorted.slice(1).map((s) => s[0]) };
}

export function detectApartment(fullNorm) {
  // Явно подписанный адрес помещения плательщика важнее остальных (в шапке бывает и адрес ТСН/УК).
  const own = /адрес\s+(?:жилого\s+)?помещения[^\n]*?(?:кв\.?|квартира)\s*(?:№\s*)?(\d{1,4})(?![\d.,]*\d)/.exec(fullNorm);
  if (own) return { number: String(Number(own[1])) };
  const nums = new Set();
  const re = /(?:^|[^а-я])(?:кв\.?|квартира|кв-ра)\s*(?:№\s*)?(\d{1,4})(?![\d.,]*\d)(?!\s*м)/g;
  let m;
  while ((m = re.exec(fullNorm))) nums.add(String(Number(m[1])));
  if (nums.size === 1) return { number: [...nums][0] };
  if (nums.size > 1) return { number: null, conflict: [...nums] };
  return { number: null };
}

export function detectAccount(fullNorm) {
  const re = /(?:лицев[а-я]*\s+сч[а-я]*(?:\/код)?|л\/с)\s*:?\s*(\d[\d\s-]{4,24}\d)/g;
  const found = new Set();
  let m;
  while ((m = re.exec(fullNorm))) {
    const d = m[1].replace(/\D/g, '');
    if (d.length >= 6 && d.length <= 20) found.add(d);
  }
  return found.size === 1 ? [...found][0] : null;
}

// ---------- таблица начислений ----------

// «Начислено» (но не «Начисления за …» — это заголовки разделов).
const isAccruedHeader = (norm) => /начислено(?![а-я])/.test(fixTypos(norm));

function findHeader(lines, idx) {
  // Ищем фрагмент «Начислено» в строке idx и собираем «полосу» шапки вокруг.
  const ln = lines[idx];
  const acc = ln.items.find((it) => isAccruedHeader(fixTypos(normalizeText(it.str))));
  if (!acc) return null;
  const h = acc.h || 7;
  const band = lines.filter((l) => Math.abs(l.cy - ln.cy) <= h * 2.6 && !/начислени[яй]\s/.test(l.norm));
  const bandItems = band.flatMap((l) => l.items);
  // Это должна быть шапка столбца «Начислено по тарифу», а не, например, «Начислено пени».
  if (!/тариф/.test(band.map((l) => l.norm).join(' '))) return null;
  const accX = acc.x;
  const accW = Math.max(acc.w, ...bandItems.filter((i) => Math.abs(i.x - accX) < h * 1.5).map((i) => i.w));
  const nextCandidates = bandItems.filter((i) => i.x >= accX + accW * 0.9);
  const nextX = nextCandidates.length ? Math.min(...nextCandidates.map((i) => i.x)) : Infinity;
  const volItem = bandItems.find((i) => /^объ[еэ]м/.test(normalizeText(i.str)));
  const nameItem = bandItems.find((i) => /вид[ыа]?\s*услуг|наименован|услуг[аи]$/.test(normalizeText(i.str)));
  let nameBoundary = volItem ? volItem.x - h * 0.3 : null;
  if (nameBoundary == null && nameItem) nameBoundary = right(nameItem) + h * 3;
  return {
    accX: accX - h * 0.3,
    nextX: nextX - h * 0.1,
    nameBoundary,
    lineIdxs: new Set(band.map((l) => lines.indexOf(l))),
    bottom: Math.max(...band.map((l) => l.cy)),
  };
}

const END_RE = /^(всего\s+за|всего\s+начислено|итого\s+к\s+оплате|итого\s+за|итого:?$|итого\s|сведения\s+о\s+перерасч|справочная\s+информац)/;

function moneyInfo(it) {
  // Возвращает {cents, fixed, lowConf} или null, если похоже на число, но не читается.
  let s = it.str;
  let fixed = false;
  if (/[оoОOзЗlI|бsS]/.test(s) && /\d/.test(s)) {
    const t = s.replace(/[оoОO]/g, '0').replace(/[lI|]/g, '1').replace(/[зЗ]/g, '3').replace(/б/g, '6').replace(/[sS]/g, '5');
    if (t !== s) { s = t; fixed = true; }
  }
  const cents = parseMoneyStrict(s);
  if (cents == null) return { cents: null, raw: it.str };
  return { cents, fixed, lowConf: it.conf != null && it.conf < 75, raw: it.str };
}

function decimals(str) {
  const m = /[.,](\d+)$/.exec(str.replace(/\s/g, ''));
  return m ? m[1].length : 0;
}
const toNum = (str) => Number(str.replace(/[\s ]/g, '').replace(',', '.'));

// Объём со сноской «0.5841 (1)» — сноска указывает способ расчёта, на число не влияет.
const stripNote = (s) => s.replace(/\s*\(\d\)\s*$/, '');

/** Проверка: объём × тариф ≈ начислено. */
function crossCheck(numsLeft, cents) {
  if (numsLeft.length < 2 || cents == null) return null;
  const volStr = stripNote(numsLeft[0].str);
  const tarStr = stripNote(numsLeft[numsLeft.length - 1].str);
  if (!isNumeric(volStr) || !isNumeric(tarStr)) return null;
  const v = toNum(volStr);
  const t = toNum(tarStr);
  if (!Number.isFinite(v) || !Number.isFinite(t) || v <= 0 || t <= 0) return null;
  const expected = v * t;
  const tol = 0.5 * 10 ** -decimals(volStr) * t + 0.5 * 10 ** -decimals(tarStr) * v + 0.011;
  return { ok: Math.abs(expected - cents / 100) <= tol, expected, vol: volStr, tariff: tarStr };
}

// Заголовки разделов внутри таблицы. Раздел общего имущества: строки в нём — это ОДН,
// даже если в названии нет пометки («Холодная вода», «Сточные воды»).
const SECTION_COMMON = /общего\s+имущества|общедомов[а-я]*\s+нужд|на\s+одн(?![а-я])/;
const SECTION_OTHER = /^(коммунальные\s+услуги|дополнительные\s+услуги|прочие\s+услуги|иные\s+услуги|жилищные\s+услуги|начисления\s+за\s)/;

function parseTable(pages) {
  const rows = [];
  let headersFound = 0;
  for (const page of pages) {
    const { lines, hMed } = groupLines(page.items);
    let cols = null;
    let ended = false;
    let common = false;
    const dataLines = [];
    const nameOnly = [];
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      if (isAccruedHeader(ln.norm)) {
        const h = findHeader(lines, i);
        if (h) { cols = h; headersFound++; ended = false; common = false; continue; }
      }
      if (!cols || ended) continue;
      if (cols.lineIdxs.has(i)) continue;
      if (END_RE.test(ln.norm) || END_RE.test(normalizeText(ln.items.find((it) => /[а-я]/i.test(it.str))?.str || ''))) {
        if (!/начислен/.test(ln.norm)) { ended = true; continue; }
      }
      const accItems = ln.items.filter((it) => {
        const r = right(it);
        return r > cols.accX && r <= cols.nextX + hMed * 0.3 && /\d/.test(it.str);
      });
      if (!accItems.length && !ln.items.some((it) => isNumeric(stripNote(it.str)))) {
        if (SECTION_COMMON.test(ln.norm)) { common = true; continue; }
        if (SECTION_OTHER.test(ln.norm)) { common = false; continue; }
      }
      const firstNumX = Math.min(...ln.items.filter((it) => isNumeric(stripNote(it.str))).map((it) => it.x), Infinity);
      const boundary = cols.nameBoundary ?? firstNumX;
      const nameParts = ln.items.filter((it) => it.x < boundary && /[a-zа-яё]/i.test(it.str) && right(it) <= Math.min(boundary, firstNumX) + hMed);
      if (accItems.length) {
        const left = ln.items.filter((it) => right(it) <= cols.accX && it.x >= boundary - hMed && isNumeric(stripNote(it.str)));
        dataLines.push({ cy: ln.cy, nameParts: nameParts.map((p) => p.str), accItems, left, text: ln.text, page: pages.indexOf(page) + 1, common });
      } else if (nameParts.length && !ln.items.some((it) => isNumeric(it.str) && it.x >= boundary)) {
        nameOnly.push({ cy: ln.cy, str: nameParts.map((p) => p.str).join(' '), text: ln.text });
      }
    }
    // Привязываем строки-продолжения названий к ближайшей строке с числами.
    const gaps = dataLines.slice(1).map((d, i) => d.cy - dataLines[i].cy).filter((g) => g > 0);
    const maxDist = Math.max(hMed * 1.4, median(gaps) * 0.95 || 0);
    for (const n of nameOnly) {
      const near = dataLines.filter((d) => Math.abs(d.cy - n.cy) <= maxDist);
      if (!near.length) continue;
      const noName = near.filter((d) => !d.nameParts.length || d.attached);
      const pool = noName.length ? noName : near;
      pool.sort((a, b) => Math.abs(a.cy - n.cy) - Math.abs(b.cy - n.cy));
      const target = pool[0];
      (target.attached ??= []).push(n);
    }
    for (const d of dataLines) {
      const parts = [...(d.attached || []).map((a) => ({ cy: a.cy, s: a.str })), { cy: d.cy, s: d.nameParts.join(' ') }]
        .filter((p) => p.s)
        .sort((a, b) => a.cy - b.cy);
      const name = parts.map((p) => p.s).join(' ').trim();
      const sourceLines = [...(d.attached || []).map((a) => ({ cy: a.cy, t: a.text })), { cy: d.cy, t: d.text }]
        .sort((a, b) => a.cy - b.cy).map((x) => x.t);
      rows.push({ name, accItems: d.accItems, left: d.left, source: sourceLines.join(' ⏎ '), page: d.page, common: d.common });
    }
  }
  return { rows, headersFound };
}

/** Режим «список»: строки «Название … 177,43 ₽» без столбцов (скриншоты приложений оплаты). */
function parseList(pages) {
  const rows = [];
  for (const page of pages) {
    const { lines } = groupLines(page.items);
    for (const ln of lines) {
      if (/^(итого|всего|изменить сумму|к оплате|оплатить)/.test(ln.norm)) continue;
      const moneyTokens = ln.text.match(/\d[\d\s ]*[.,]\d{2}(?!\d)/g) || [];
      const nameText = ln.items.filter((it) => /[а-яa-z]/i.test(it.str) && !/^(₽|руб\.?|р\.?)$/i.test(it.str)).map((it) => it.str).join(' ');
      if (!nameText || !/[а-я]{3,}/i.test(normalizeText(nameText))) continue;
      const lowConf = ln.items.some((it) => /\d/.test(it.str) && it.conf != null && it.conf < 75);
      rows.push({ name: nameText, moneyTokens: moneyTokens.map((t) => t.trim()), lowConf, source: ln.text });
    }
  }
  return rows;
}

/**
 * Основная функция разбора.
 */
export function parseReceipt(pages, { knownApartments = [], accountMap = {} } = {}) {
  const warnings = [];
  const allLines = pages.flatMap((p) => groupLines(p.items).lines);
  const fullNorm = allLines.map((l) => l.norm).join('\n');
  const electricityContext = /электр|элетр|эл-во|квт/.test(fullNorm);

  // 1. Квартира
  const aptDet = detectApartment(fullNorm);
  const account = detectAccount(fullNorm);
  let apartment = null;
  let apartmentHow = null;
  if (aptDet.number) {
    const known = knownApartments.find((a) => String(a.number) === aptDet.number);
    if (known) { apartment = known.id; apartmentHow = `найдена в квитанции («кв. ${aptDet.number}»)`; }
    else warnings.push(`В квитанции кв. ${aptDet.number}, а такой нет в списке. Выберите квартиру.`);
  } else if (aptDet.conflict) {
    warnings.push(`В квитанции несколько номеров квартир (${aptDet.conflict.join(', ')}). Выберите нужную.`);
  }
  if (!apartment && account && accountMap[account] && knownApartments.some((a) => a.id === accountMap[account])) {
    apartment = accountMap[account];
    apartmentHow = `определена по лицевому счёту ${account}`;
  }
  if (!apartment && !aptDet.number && !aptDet.conflict) warnings.push('Номер квартиры не найден — выберите квартиру.');

  // 2. Период
  const per = detectPeriod(fullNorm);
  if (!per.period) {
    warnings.push(per.conflict
      ? `В квитанции разные месяцы (${per.conflict.join(', ')}). Укажите нужный.`
      : 'Месяц не найден — укажите его.');
  }

  // 3–7. Услуги
  const services = Object.fromEntries(SERVICE_KEYS.map((k) => [k, { cents: null, status: 'absent', candidates: [], notes: [] }]));
  const { rows, headersFound } = parseTable(pages);
  let mode = 'table';
  const ambiguousRows = [];
  const commonRows = []; // строки раздела общего имущества (не учитываются)

  if (headersFound) {
    for (const row of rows) {
      const cls = classifyService(row.name, { electricityContext });
      if (row.common) { if (cls.key) commonRows.push({ ...row, key: cls.key }); continue; }
      if (cls.ambiguous) { ambiguousRows.push({ ...row, reason: cls.reason }); continue; }
      if (!cls.key) continue;
      const svc = services[cls.key];
      const nums = row.accItems.map(moneyInfo);
      const cand = { name: row.name, source: row.source, page: row.page };
      if (nums.length !== 1) {
        cand.cents = null;
        cand.problem = nums.length ? 'в столбце «Начислено по тарифу» несколько значений' : 'в столбце нет суммы';
      } else if (nums[0].cents == null) {
        cand.cents = null;
        cand.problem = `сумма не читается («${nums[0].raw}»)`;
      } else {
        cand.cents = nums[0].cents;
        if (nums[0].fixed) cand.problem = `в «${nums[0].raw}» буквы похожи на цифры — проверьте`;
        else if (nums[0].lowConf) cand.problem = 'сумма распознана неуверенно — проверьте';
        const cc = crossCheck(row.left, cand.cents);
        if (cc) {
          cand.check = cc;
          if (!cc.ok) cand.problem = `не сходится: объём × тариф = ${cc.vol} × ${cc.tariff} ≈ ${cc.expected.toFixed(2)} — проверьте`;
        }
      }
      svc.candidates.push(cand);
    }
  } else {
    mode = 'list';
    const listRows = parseList(pages);
    for (const row of listRows) {
      const cls = classifyService(row.name, { electricityContext });
      if (cls.ambiguous) { ambiguousRows.push({ ...row, reason: cls.reason }); continue; }
      if (!cls.key) continue;
      const cand = { name: row.name, source: row.source };
      if (row.moneyTokens.length === 1) {
        cand.cents = parseMoneyStrict(row.moneyTokens[0]);
        if (cand.cents == null) cand.problem = 'сумма не читается';
        else if (row.lowConf) cand.problem = 'сумма распознана неуверенно — проверьте';
      } else if (row.moneyTokens.length === 0) {
        cand.cents = null;
        const raw = row.source.match(/\d[\d\s.,]*\d/g);
        cand.problem = raw
          ? `не видно запятой: прочитано «${raw.join(' ')}»`
          : 'сумма в строке не найдена';
      } else {
        cand.cents = null;
        cand.problem = 'в строке несколько сумм, а столбец «Начислено по тарифу» не найден';
      }
      services[cls.key].candidates.push(cand);
    }
  }

  // Итог по каждой услуге
  let anyFound = false;
  for (const key of SERVICE_KEYS) {
    const svc = services[key];
    const c = svc.candidates;
    if (!c.length) continue;
    anyFound = true;
    const values = [...new Set(c.map((x) => x.cents))];
    svc.source = c.map((x) => x.source).join('\n');
    if (c.length > 1 && !(values.length === 1 && values[0] != null)) {
      svc.status = 'unreadable';
      svc.cents = null;
      svc.notes.push(`Услуга встречается несколько раз (${c.map((x) => (x.cents == null ? '?' : (x.cents / 100).toFixed(2))).join('; ')}). Введите нужную сумму.`);
      continue;
    }
    const first = c[0];
    if (c.length > 1) svc.notes.push('Строка повторяется с той же суммой — учтена один раз.');
    if (first.cents == null) {
      svc.status = 'unreadable';
      svc.notes.push(first.problem || 'Сумма не распознана.');
    } else {
      svc.cents = first.cents;
      svc.status = first.problem ? 'check' : 'ok';
      if (first.problem) svc.notes.push(first.problem);
      if (first.check?.ok) svc.verified = `${first.check.vol} × ${first.check.tariff}`;
    }
  }

  if (!anyFound) {
    // Ничего не распознано — нельзя ставить нули.
    for (const key of SERVICE_KEYS) {
      services[key].status = 'unreadable';
      services[key].notes.push('Не найдено.');
    }
    warnings.push(headersFound
      ? 'Таблица найдена, но нужных услуг в ней нет.'
      : 'Таблица начислений не найдена. Впишите суммы сами или поправьте фото и распознайте заново.');
  } else {
    for (const key of SERVICE_KEYS) {
      const svc = services[key];
      if (svc.status !== 'absent') continue;
      const amb = ambiguousRows.find((r) => relatedToKey(r.reason, key));
      const com = commonRows.find((r) => r.key === key);
      if (amb) {
        svc.status = 'unreadable';
        svc.notes.push(`Возможно, это строка «${amb.name}» (${amb.reason}). Впишите сумму сами.`);
        svc.source = amb.source;
      } else if (com) {
        // Нашлась только строка из раздела общего имущества — 0 сами не ставим.
        svc.status = 'unreadable';
        svc.notes.push(`Есть только строка «${com.name}» из раздела общего имущества, она не учитывается. Если услуги нет, впишите 0.`);
        svc.source = com.source;
      } else {
        svc.cents = 0;
        svc.notes.push('Поставлен 0.');
      }
    }
  }
  // Результаты OCR и режима «список» без перекрёстной проверки — только «проверьте».
  const isOcr = pages.some((p) => p.source === 'ocr');
  for (const key of SERVICE_KEYS) {
    const svc = services[key];
    if (svc.status === 'ok' && (mode === 'list' || isOcr) && !svc.verified) {
      svc.status = 'check';
    }
    if (svc.status === 'absent' && isOcr) {
      // На фото отсутствие строки не доказывает, что услуги нет.
      svc.status = 'unreadable';
      svc.cents = null;
      svc.notes = ['Не найдено на фото. Если услуги нет, впишите 0.'];
    }
  }
  for (const r of ambiguousRows) {
    warnings.push(`Непонятная строка «${r.name}»: ${r.reason}.`);
  }
  if (mode === 'list') warnings.push('Столбец «Начислено по тарифу» не найден, суммы взяты из списка. Сверьте их с квитанцией.');

  return { apartment, apartmentHow, apartmentNumberFound: aptDet.number, account, period: per.period, services, warnings, mode };
}

function relatedToKey(reason = '', key) {
  if (/электро/.test(reason) || /Т1\/Т2/.test(reason)) return key === 'elDay' || key === 'elNight';
  if (/горячая/.test(reason)) return key === 'hotCarrier' || key === 'hotEnergy';
  return false;
}
