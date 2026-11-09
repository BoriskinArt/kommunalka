// Кирова, 40 — отдельный учёт: показания × тариф (или сумма вручную), итог с налогом 6 %, отметка об оплате.
// Данные лежат в своём хранилище и в итоги квартир не входят. В облако уходят в той же копии.
import * as db from './db.js';
import { formatAmount, formatRub, parseUserMoney } from './money.js';

const ROWS = db.KIROVA_ROWS;
// Отопление — только сумма вручную, без показаний. Электричество — расход с потерями 1 %.
const MANUAL = new Set(['heat']);
const LOSS = { el: 0.01 };
let ctx;
let period;
let records = new Map();
let saveTimer = null;

const $ = (s) => document.querySelector(s);
// Сумма с налогом: из неё платится 6 %, и остаётся исходная сумма. gross − 6 % = total → gross = total / 0,94.
const withTax = (cents) => Math.round((cents * 100) / 94);
const totalOf = (rec) => ROWS.reduce((t, r) => t + (rec?.rows[r.key]?.cents ?? 0), 0);
const toNum = (s) => {
  const t = String(s).replace(/[\s  ]/g, '').replace(',', '.');
  return /^\d+(\.\d+)?$/.test(t) ? Number(t) : null;
};
const fmtNum = (n) => String(Math.round(n * 1000) / 1000).replace('.', ',');

/** Расход и сумма по показаниям и тарифу. cents = null, если посчитать нельзя. */
function calcRow(prev, cur, tariff, loss = 0) {
  const a = toNum(prev);
  const b = toNum(cur);
  const t = toNum(tariff);
  if (a == null || b == null) return { use: null, cents: null };
  const use = b - a;
  const billed = use * (1 + loss); // расход с учётом коэффициента потерь
  if (use < 0 || t == null) return { use, billed, cents: null };
  return { use, billed, t, cents: Math.round(Number((billed * t * 100).toFixed(4))) };
}
const fmtDate = (iso) => new Date(iso).toLocaleDateString('ru-RU');

export async function initKirova(helpers) {
  ctx = helpers;
  period = helpers.initialPeriod;
  await reloadKirova();
  bind();
}

export async function reloadKirova() {
  records = new Map((await db.listKirova()).map((r) => [r.period, r]));
}

function bind() {
  document.querySelectorAll('[data-kstep]').forEach((b) => b.addEventListener('click', async () => {
    await flush();
    period = ctx.shiftPeriod(period, Number(b.dataset.kstep));
    renderKirova();
  }));
  $('#kMonthInput').addEventListener('change', async (e) => {
    if (!e.target.value) return;
    await flush();
    period = e.target.value;
    renderKirova();
  });
  $('#kFields').addEventListener('input', () => {
    updateTotals();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => save().catch(ctx.showError), 700);
  });
  $('#kFields').addEventListener('change', (e) => {
    if (e.target.id.endsWith('-cents') && e.target.value.trim() !== '') {
      const v = parseUserMoney(e.target.value);
      if (v != null) e.target.value = formatAmount(v);
    }
    flush();
  });
  $('#kPaid').addEventListener('change', () => save({ paidChanged: true }).catch(ctx.showError));
  $('#kHist').addEventListener('click', async (e) => {
    const p = e.target.closest('[data-kperiod]')?.dataset.kperiod;
    if (!p) return;
    await flush();
    period = p;
    renderKirova();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  window.addEventListener('pagehide', () => flush());
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
}

/** Сохранить отложенные правки сразу (смена месяца, вкладки, сворачивание). */
export async function flush() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  await save().catch(ctx.showError);
}

function readForm() {
  const rows = {};
  let ok = true;
  for (const { key } of ROWS) {
    const money = $(`#k-${key}-cents`);
    const val = (f) => $(`#k-${key}-${f}`)?.value.trim() ?? '';
    const prev = val('prev');
    const cur = val('cur');
    const tariff = val('tariff');
    const calc = MANUAL.has(key) ? { use: null, cents: null } : calcRow(prev, cur, tariff, LOSS[key]);
    // Есть показания и тариф — сумма считается сама, поле только для чтения.
    money.readOnly = calc.cents != null;
    money.classList.toggle('computed', calc.cents != null);
    if (calc.cents != null) money.value = formatAmount(calc.cents);
    const raw = money.value.trim();
    const cents = calc.cents ?? (raw === '' ? null : parseUserMoney(raw));
    const bad = raw !== '' && cents == null;
    money.classList.toggle('invalid', bad);
    if (bad) ok = false;
    rows[key] = { prev, cur, tariff, cents: bad ? null : cents, calc };
    if (key === 'extra') rows[key].title = $('#k-extra-title').value.trim();
  }
  return { rows, ok };
}

const isEmpty = (rows, paid) => !paid && ROWS.every(({ key }) => rows[key].cents == null && rows[key].cur === '' && !rows[key].title);

async function save({ paidChanged = false } = {}) {
  clearTimeout(saveTimer);
  saveTimer = null;
  const { rows, ok } = readForm();
  if (!ok && !paidChanged) return; // ждём, пока пользователь исправит сумму
  const old = records.get(period);
  const paid = $('#kPaid').checked;
  if (!ok) {
    // Отметку об оплате сохраняем и при недописанной сумме: берём прежние суммы для неверных полей.
    for (const { key } of ROWS) if ($(`#k-${key}-cents`).classList.contains('invalid')) rows[key].cents = old?.rows[key]?.cents ?? null;
  }
  if (isEmpty(rows, paid)) {
    if (old) { await db.deleteKirova(period); records.delete(period); ctx.dataChanged(); }
    renderMeta();
    return;
  }
  const rec = {
    period,
    rows,
    paid,
    paidAt: paid ? (old?.paid ? old.paidAt : new Date().toISOString()) : null,
    updatedAt: new Date().toISOString(),
  };
  await db.putKirova(rec);
  records.set(period, db.validateKirova(rec));
  ctx.dataChanged();
  renderMeta();
  if (paidChanged) ctx.toast(paid ? `${ctx.periodTitle(period)}: оплачено` : `${ctx.periodTitle(period)}: отметка об оплате снята`);
}

export function renderKirova() {
  $('#kMonthTitle').textContent = ctx.periodTitle(period);
  $('#kMonthInput').value = period;
  const rec = records.get(period);
  const prevRec = records.get(ctx.shiftPeriod(period, -1));
  $('#kFields').innerHTML = ROWS.map(({ key, title }) => {
    const r = rec?.rows[key];
    const prev = r?.prev || prevRec?.rows[key]?.cur || '';
    const tariff = r?.tariff || prevRec?.rows[key]?.tariff || '';
    const head = key === 'extra'
      ? `<input type="text" class="k-title" id="k-extra-title" placeholder="Своя строка" value="${ctx.esc(r?.title ?? prevRec?.rows.extra?.title ?? '')}" autocomplete="off">`
      : `<span class="svc-title">${title}</span>`;
    if (MANUAL.has(key)) {
      const last = prevRec?.rows[key]?.cents;
      return `<div class="svc k-row">
      <div class="svc-main">${head}
        <label class="k-cur">Сумма, ₽<input class="money" id="k-${key}-cents" inputmode="decimal" autocomplete="off" placeholder="0,00" value="${r?.cents == null ? '' : formatAmount(r.cents)}"></label>
      </div>
      <div class="prev-hint">${last == null ? 'В прошлом месяце: нет данных' : `В прошлом месяце: ${formatRub(last)}`}</div>
    </div>`;
    }
    // Главное поле — текущее показание: крупно, справа от названия. Сумма считается ниже.
    return `<div class="svc k-row">
      <div class="svc-main">${head}
        <label class="k-cur">Текущее показание<input class="money" id="k-${key}-cur" inputmode="decimal" autocomplete="off" value="${ctx.esc(r?.cur ?? '')}"></label>
      </div>
      <div class="k-meter">
        <label>Предыдущее<input class="meter" id="k-${key}-prev" inputmode="decimal" autocomplete="off" value="${ctx.esc(prev)}"></label>
        <label>Тариф, ₽<input class="meter" id="k-${key}-tariff" inputmode="decimal" autocomplete="off" value="${ctx.esc(tariff)}"></label>
        <label class="k-sum">Сумма, ₽<input class="meter" id="k-${key}-cents" inputmode="decimal" autocomplete="off" placeholder="0,00" value="${r?.cents == null ? '' : formatAmount(r.cents)}"></label>
      </div>
      <div class="prev-hint" id="k-${key}-use"></div>
    </div>`;
  }).join('');
  $('#kPaid').checked = Boolean(rec?.paid);
  updateTotals();
  renderMeta();
}

function updateTotals() {
  const { rows } = readForm();
  const total = ROWS.reduce((t, { key }) => t + (rows[key].cents ?? 0), 0);
  $('#kTotal').textContent = formatRub(total);
  const gross = withTax(total);
  $('#kTotal6').textContent = formatRub(gross);
  $('#kTax').textContent = total ? `Налог 6 %: ${formatRub(gross - total)}, после него останется ${formatRub(total)}` : '';
  for (const { key } of ROWS) {
    if (MANUAL.has(key)) continue;
    const { use, billed, t, cents } = rows[key].calc;
    const el = $(`#k-${key}-use`);
    const useText = LOSS[key] ? `${fmtNum(use)} + ${LOSS[key] * 100} % потерь = ${fmtNum(billed)}` : fmtNum(use);
    el.classList.toggle('bad-text', use != null && use < 0);
    el.textContent = use == null ? ''
      : use < 0 ? 'Текущее показание меньше предыдущего'
      : cents != null ? `Расход ${useText} × ${fmtNum(t)} = ${formatRub(cents)}`
      : `Расход ${useText}. Укажите тариф, и сумма посчитается сама`;
  }
}

function renderMeta() {
  const rec = records.get(period);
  const paid = Boolean(rec?.paid);
  $('#kPaidRow').classList.toggle('paid', paid);
  $('#kPaidAt').textContent = paid && rec.paidAt ? `отмечено ${fmtDate(rec.paidAt)}` : '';
  const list = [...records.values()].sort((a, b) => b.period.localeCompare(a.period));
  $('#kHist').innerHTML = list.length
    ? list.map((r) => `<button type="button" class="k-hist ${r.period === period ? 'current' : ''}" data-kperiod="${r.period}">
        <span>${ctx.periodTitle(r.period)}</span>
        <span class="k-hist-sum">${formatRub(withTax(totalOf(r)))}</span>
        <span class="badge ${r.paid ? '' : 'warn'}">${r.paid ? 'оплачено' : 'не оплачено'}</span>
      </button>`).join('')
    : '<p class="hint">Пока нет сохранённых месяцев. Введите суммы — они сохраняются сами.</p>';
}
