// Кирова, 40 — отдельный учёт: ручной ввод показаний и сумм, итог и итог + 6 %, отметка об оплате.
// Данные лежат в своём хранилище и в итоги квартир не входят. В облако уходят в той же копии.
import * as db from './db.js';
import { formatAmount, formatRub, parseUserMoney } from './money.js';

const ROWS = db.KIROVA_ROWS;
let ctx;
let period;
let records = new Map();
let saveTimer = null;

const $ = (s) => document.querySelector(s);
const plus6 = (cents) => Math.round((cents * 106) / 100);
const totalOf = (rec) => ROWS.reduce((t, r) => t + (rec?.rows[r.key]?.cents ?? 0), 0);
const toNum = (s) => {
  const t = String(s).replace(/[\s  ]/g, '').replace(',', '.');
  return /^\d+(\.\d+)?$/.test(t) ? Number(t) : null;
};
const fmtNum = (n) => String(Math.round(n * 1000) / 1000).replace('.', ',');
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
    if (e.target.classList.contains('money') && e.target.value.trim() !== '') {
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
    const raw = money.value.trim();
    const cents = raw === '' ? null : parseUserMoney(raw);
    const bad = raw !== '' && cents == null;
    money.classList.toggle('invalid', bad);
    if (bad) ok = false;
    rows[key] = { prev: $(`#k-${key}-prev`).value.trim(), cur: $(`#k-${key}-cur`).value.trim(), cents: bad ? null : cents };
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
    const head = key === 'extra'
      ? `<input type="text" class="k-title" id="k-extra-title" placeholder="Своя строка, например «Домофон»" value="${ctx.esc(r?.title ?? prevRec?.rows.extra?.title ?? '')}" autocomplete="off">`
      : `<label class="svc-title" for="k-${key}-cents">${title}</label>`;
    return `<div class="svc k-row">
      <div class="svc-main">${head}
        <input class="money" id="k-${key}-cents" inputmode="decimal" autocomplete="off" placeholder="0,00" value="${r?.cents == null ? '' : formatAmount(r.cents)}" aria-label="Сумма">
      </div>
      <div class="k-meter">
        <label>Пред. показание<input class="meter" id="k-${key}-prev" inputmode="decimal" autocomplete="off" value="${ctx.esc(prev)}"></label>
        <label>Текущее<input class="meter" id="k-${key}-cur" inputmode="decimal" autocomplete="off" value="${ctx.esc(r?.cur ?? '')}"></label>
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
  $('#kTotal6').textContent = formatRub(plus6(total));
  for (const { key } of ROWS) {
    const a = toNum(rows[key].prev);
    const b = toNum(rows[key].cur);
    $(`#k-${key}-use`).textContent = a != null && b != null ? `Расход: ${fmtNum(b - a)}` : '';
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
        <span class="k-hist-sum">${formatRub(plus6(totalOf(r)))}</span>
        <span class="badge ${r.paid ? '' : 'warn'}">${r.paid ? 'оплачено' : 'не оплачено'}</span>
      </button>`).join('')
    : '<p class="hint">Пока нет сохранённых месяцев. Введите суммы — они сохраняются сами.</p>';
}
