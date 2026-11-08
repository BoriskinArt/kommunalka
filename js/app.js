import { SERVICES, SERVICE_KEYS, formatRub, formatAmount, parseUserMoney, totalOf } from './money.js';
import * as db from './db.js';
import { parseReceipt } from './parser.js';
import { readPdf, ocrCanvas } from './extract.js';
import { loadImage, PhotoEditor } from './photo.js';
import * as cloud from './cloud.js';
import { initKirova, renderKirova, reloadKirova, flush as flushKirova } from './kirova.js';

export const APP_VERSION = '1.2.0';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MONTH_NAMES = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const periodTitle = (p) => (p ? `${MONTH_NAMES[Number(p.slice(5)) - 1]} ${p.slice(0, 4)}` : '—');
const periodText = (p) => periodTitle(p).toLowerCase(); // внутри фразы: «за октябрь 2026»
function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  const w = m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
  return `${n} ${w}`;
}
const nRecords = (n) => plural(n, 'запись', 'записи', 'записей');
function shiftPeriod(p, n) {
  const [y, m] = p.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
const aptLabel = (a) => `Кв. № ${a.number}`;

const state = {
  apartments: [],
  records: new Map(),
  period: shiftPeriod(new Date().toISOString().slice(0, 7), -1),
  tab: 'month',
  sub: null,
  histApt: null,
  edit: null,
  rev: null,
  photo: null,
};

// ---------- общие элементы ----------

function toast(text, ms = 2600) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}
function busy(text) {
  $('#busy').hidden = !text;
  if (text) $('#busyText').textContent = text;
}
function ask(title, html, buttons) {
  const dlg = $('#dlg');
  $('#dlgTitle').textContent = title;
  $('#dlgText').innerHTML = html;
  $('#dlgActions').innerHTML = buttons
    .map((b) => `<button class="btn ${b.cls || ''}" value="${esc(b.value)}">${esc(b.label)}</button>`)
    .join('');
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((resolve) => dlg.addEventListener('close', () => resolve(dlg.returnValue), { once: true }));
}
const confirmDlg = (title, html, okLabel, cls = 'primary') =>
  ask(title, html, [{ label: okLabel, value: 'ok', cls }, { label: 'Отмена', value: '' }]).then((v) => v === 'ok');

async function reload() {
  await reloadKirova();
  state.apartments = await db.listApartments();
  const recs = await db.listRecords();
  state.records = new Map(recs.map((r) => [r.key, r]));
  if (!state.histApt || !state.apartments.some((a) => a.id === state.histApt)) state.histApt = state.apartments[0]?.id;
}
const getRec = (aptId, period) => state.records.get(db.recordKey(aptId, period));

// ---------- навигация ----------

const TITLES = { month: 'Коммунальные платежи', history: 'История', kirova: 'Кирова, 40', more: 'Ещё', edit: 'Начисления', review: 'Проверка квитанции', photo: 'Подготовка фото' };

function render() {
  const view = state.sub || state.tab;
  for (const v of ['month', 'history', 'kirova', 'more', 'edit', 'review', 'photo']) $(`#view-${v}`).hidden = v !== view;
  $('#title').textContent = TITLES[view];
  $('#btnBack').hidden = !state.sub;
  $('#tabbar').hidden = Boolean(state.sub);
  $('#fabBar').hidden = Boolean(state.sub) || state.tab === 'more' || state.tab === 'kirova';
  document.body.classList.toggle('sub', Boolean(state.sub));
  document.querySelectorAll('#tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
  if (view === 'month') renderMonth();
  if (view === 'history') renderHistory();
  if (view === 'kirova') renderKirova();
  if (view === 'more') renderMore();
}

function openSub(name) {
  if (!state.sub) history.pushState({ sub: true }, '');
  state.sub = name;
  render();
  window.scrollTo(0, 0);
}
function closeSub() {
  state.sub = null;
  state.edit = null;
  state.rev = null;
  render();
}
/** Закрыть подэкран кнопкой «Назад»/«Отменить» с подтверждением, если есть несохранённые данные. */
async function leaveSub() {
  if (state.sub === 'review' || state.sub === 'photo') {
    const ok = await confirmDlg('Отменить распознавание?', 'Распознанные данные не будут сохранены.', 'Да, отменить', 'danger');
    if (!ok) return false;
  } else if (state.sub === 'edit' && state.edit?.dirty) {
    const ok = await confirmDlg('Выйти без сохранения?', 'Введённые суммы не сохранены.', 'Выйти', 'danger');
    if (!ok) return false;
  }
  state.photo = null;
  if (history.state?.sub) { state.leaving = true; history.back(); } else closeSub();
  return true;
}
window.addEventListener('popstate', async () => {
  if (state.leaving) { state.leaving = false; closeSub(); return; }
  if (!state.sub) return;
  // Системная кнопка «Назад» Android.
  history.pushState({ sub: true }, '');
  await leaveSub();
});

// ---------- экран месяца ----------

function serviceTable(amounts) {
  return `<table>${SERVICES.map((s) => `<tr><td>${s.title}</td><td>${formatRub(amounts[s.key])}</td></tr>`).join('')}</table>`;
}

function arithmeticBadge(rec) {
  const t = totalOf(rec.amounts);
  return t === rec.total ? '' : ' <span class="badge bad" title="Итог в базе отличался и пересчитан">итог пересчитан</span>';
}

function renderMonth() {
  $('#monthTitle').textContent = periodTitle(state.period);
  $('#monthInput').value = state.period;
  let grand = 0;
  let filled = 0;
  const cards = state.apartments.map((a) => {
    const rec = getRec(a.id, state.period);
    if (rec) { grand += totalOf(rec.amounts); filled++; }
    return `<div class="card apt-card">
      <div class="apt-head"><span class="apt-name">${esc(aptLabel(a))}</span>
        ${rec ? `<span class="apt-sum">${formatRub(totalOf(rec.amounts))}</span>` : '<span class="empty">Нет данных</span>'}</div>
      ${rec ? serviceTable(rec.amounts) + arithmeticBadge(rec) : ''}
      <div class="apt-actions"><button class="btn small" data-edit="${a.id}">${rec ? 'Изменить' : 'Ввести вручную'}</button></div>
    </div>`;
  });
  $('#aptCards').innerHTML = cards.join('');
  $('#grandTotal').textContent = formatRub(grand);
  $('#grandNote').textContent = ` (заполнено ${filled} из ${state.apartments.length})`;
}

// ---------- ручной ввод / редактирование ----------

function chipsHtml(selectedId, detectedId) {
  return state.apartments
    .map((a) => `<button type="button" class="chip ${a.id === selectedId ? 'active' : ''} ${a.id === detectedId ? 'detected' : ''}" data-apt="${a.id}">${esc(aptLabel(a))}</button>`)
    .join('');
}

function openEdit(aptId, period) {
  state.edit = { aptId, period, dirty: false, loadedKey: null };
  openSub('edit');
  $('#editMonth').value = period;
  buildEditFields();
  loadEditRecord(true);
}

function buildEditFields() {
  $('#editFields').innerHTML = SERVICES.map((s) => `
    <div class="svc">
      <div class="svc-main">
        <label class="svc-title" for="e-${s.key}">${s.title}<small>${s.hint}</small></label>
        <input class="money" id="e-${s.key}" data-key="${s.key}" inputmode="decimal" autocomplete="off" placeholder="0,00">
      </div>
      <div class="prev-hint" id="ep-${s.key}"></div>
    </div>`).join('');
}

function loadEditRecord(force) {
  const e = state.edit;
  $('#editApts').innerHTML = chipsHtml(e.aptId);
  const rec = e.aptId ? getRec(e.aptId, e.period) : null;
  const prev = e.aptId ? getRec(e.aptId, shiftPeriod(e.period, -1)) : null;
  if (rec && (force || !e.dirty)) {
    for (const k of SERVICE_KEYS) $(`#e-${k}`).value = formatAmount(rec.amounts[k]);
    e.loadedKey = rec.key;
    e.dirty = false;
  } else if (!rec && !e.dirty) {
    for (const k of SERVICE_KEYS) $(`#e-${k}`).value = '';
    e.loadedKey = null;
  }
  const note = $('#editExisting');
  if (rec && e.loadedKey === rec.key) {
    note.hidden = false;
    note.textContent = `Вы редактируете сохранённую запись (итог ${formatRub(totalOf(rec.amounts))}).`;
  } else if (rec) {
    note.hidden = false;
    note.textContent = `За этот месяц уже есть запись на ${formatRub(totalOf(rec.amounts))}. При сохранении спросим, заменить ли её.`;
  } else note.hidden = true;
  $('#editDelete').hidden = !(rec && e.loadedKey === rec.key);
  for (const k of SERVICE_KEYS) {
    $(`#ep-${k}`).textContent = prev ? `Пред. месяц: ${formatRub(prev.amounts[k])}` : '';
  }
  updateEditTotal();
}

function readFields(prefix) {
  const amounts = {};
  let ok = true;
  for (const k of SERVICE_KEYS) {
    const input = $(`#${prefix}-${k}`);
    const v = parseUserMoney(input.value);
    input.classList.toggle('invalid', v == null);
    if (v == null) ok = false;
    amounts[k] = v;
  }
  return { amounts, ok };
}

function updateEditTotal() {
  const { amounts, ok } = readFields('e');
  $('#editTotal').textContent = ok ? formatRub(totalOf(amounts)) : '—';
}

async function saveWithDuplicateCheck({ aptId, period, amounts, source, fileName }, editingKey) {
  const overwrite = editingKey === db.recordKey(aptId, period);
  try {
    return await db.saveRecord({ aptId, period, amounts, source, fileName }, { overwrite });
  } catch (err) {
    if (err.code !== 'EXISTS') throw err;
    const apt = state.apartments.find((a) => a.id === aptId);
    const replace = await confirmDlg(
      'Запись уже существует',
      `${esc(aptLabel(apt))}, ${periodText(period)}: уже сохранено <b>${formatRub(totalOf(err.existing.amounts))}</b>.<br>Новая сумма: <b>${formatRub(totalOf(amounts))}</b>.<br><br>Заменить?`,
      'Заменить', 'danger',
    );
    if (!replace) return null;
    return db.saveRecord({ aptId, period, amounts, source, fileName }, { overwrite: true });
  }
}

async function onEditSave() {
  const e = state.edit;
  const period = $('#editMonth').value;
  if (!e.aptId) return toast('Выберите квартиру');
  if (!period) return toast('Выберите месяц');
  const { amounts, ok } = readFields('e');
  if (!ok) return toast('Исправьте суммы, выделенные красным');
  const rec = await saveWithDuplicateCheck({ aptId: e.aptId, period, amounts, source: 'manual' }, e.loadedKey);
  if (!rec) return;
  await afterSave(rec);
}

async function afterSave(rec) {
  await db.requestPersistence();
  await reload();
  dataChanged();
  state.period = rec.period;
  state.photo = null;
  if (history.state?.sub) { state.leaving = true; history.back(); } else closeSub();
  const apt = state.apartments.find((a) => a.id === rec.aptId);
  toast(`Сохранено: ${aptLabel(apt)}, ${periodText(rec.period)} — ${formatRub(rec.total)}`);
}

async function onEditDelete() {
  const e = state.edit;
  const rec = getRec(e.aptId, e.period);
  if (!rec) return;
  const apt = state.apartments.find((a) => a.id === e.aptId);
  if (!(await confirmDlg('Удалить запись?', `${esc(aptLabel(apt))}, ${periodText(e.period)} — ${formatRub(rec.total)}. Вернуть запись можно будет только из резервной копии.`, 'Удалить', 'danger'))) return;
  await db.deleteRecord(e.aptId, e.period);
  await reload();
  dataChanged();
  e.dirty = false;
  if (history.state?.sub) { state.leaving = true; history.back(); } else closeSub();
  toast('Запись удалена');
}

// ---------- загрузка квитанции ----------

async function onFiles(files) {
  files = [...files];
  if (!files.length) return;
  const pdfs = files.filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  const images = files.filter((f) => !pdfs.includes(f));
  if (pdfs.length > 1 || (pdfs.length && images.length)) {
    return ask('Выберите одну квитанцию', 'Загрузите один PDF или несколько фотографий страниц одной квитанции.', [{ label: 'Понятно', value: '' }]);
  }
  const fileNames = files.map((f) => f.name).join(', ');
  try {
    if (pdfs.length) {
      await processPdf(pdfs[0], { fileNames });
    } else {
      busy('Открываю изображения…');
      const pages = [];
      for (const f of images) pages.push({ img: await loadImage(f) });
      busy(null);
      openPhoto(pages.map((p) => p.img), { fileNames, source: 'photo' });
    }
  } catch (err) {
    busy(null);
    console.error(err);
    ask('Не удалось обработать файл', `${esc(err.message || err)}<br><br>Суммы можно ввести вручную.`, [{ label: 'Понятно', value: '' }]);
  }
}

async function processPdf(file, { fileNames, forceOcr = false }) {
  busy('Читаю PDF…');
  const { pages, scannedCanvases } = await readPdf(file, { forceOcr, onProgress: busy });
  busy(null);
  if (scannedCanvases.length) {
    // Скан: показываем страницы в редакторе, чтобы можно было обрезать/повернуть, затем OCR.
    openPhoto(scannedCanvases, { fileNames, source: 'pdf-scan', textPages: pages, pdfFile: file });
    if (!pages.length) toast('Это скан, а не текстовый PDF. Поправьте страницы, если нужно, и нажмите «Распознать».', 4500);
    return;
  }
  await showReview(pages, { fileNames, source: 'pdf', pdfFile: file });
}

function openPhoto(images, ctx) {
  state.photo = { images: images.map((img) => ({ img, src: null, corners: null })), idx: 0, ctx };
  openSub('photo');
  state.editor ??= new PhotoEditor($('#photoCanvas'));
  showPhotoPage(0);
}
function storePhotoPage() {
  const p = state.photo;
  const page = p.images[p.idx];
  page.src = state.editor.src;
  page.corners = state.editor.corners.map((c) => [...c]);
}
function showPhotoPage(i) {
  const p = state.photo;
  p.idx = i;
  const page = p.images[i];
  if (page.src) {
    state.editor.src = page.src;
    state.editor.corners = page.corners;
    state.editor.draw();
  } else {
    requestAnimationFrame(() => state.editor.setImage(page.img));
  }
  $('#photoPager').hidden = p.images.length < 2;
  $('#photoPage').textContent = `Страница ${i + 1} из ${p.images.length}`;
}

async function onPhotoRecognize() {
  const p = state.photo;
  storePhotoPage();
  state.editor.contrast = $('#contrast').checked;
  try {
    const pages = [...(p.ctx.textPages || [])];
    for (let i = 0; i < p.images.length; i++) {
      const page = p.images[i];
      state.editor.src = page.src || state.editor.src;
      if (!page.src) { state.editor.setImage(page.img); page.src = state.editor.src; page.corners = state.editor.corners; }
      state.editor.corners = page.corners;
      busy(`Подготовка страницы ${i + 1} из ${p.images.length}…`);
      await new Promise((r) => setTimeout(r, 30));
      const canvas = state.editor.render();
      const items = await ocrCanvas(canvas, {
        onProgress: (t) => busy(p.images.length > 1 ? `Стр. ${i + 1}/${p.images.length}. ${t}` : t),
      });
      pages.push({ items, source: 'ocr' });
    }
    showPhotoPage(p.idx);
    busy(null);
    await showReview(pages, { ...p.ctx, fromPhoto: true });
  } catch (err) {
    busy(null);
    console.error(err);
    ask('Ошибка распознавания', `${esc(err.message || err)}<br><br>В первый раз для распознавания фото нужен интернет. Суммы можно ввести вручную.`, [{ label: 'Понятно', value: '' }]);
  }
}

// ---------- экран проверки ----------

async function showReview(pages, ctx) {
  const accountMap = (await db.getMeta('accountMap')) || {};
  const result = parseReceipt(pages, { knownApartments: state.apartments, accountMap });
  state.rev = {
    result,
    ctx,
    aptId: result.apartment,
  };
  if (state.sub !== 'review') {
    if (state.sub) { state.sub = 'review'; render(); window.scrollTo(0, 0); } else openSub('review');
  }
  $('#revFile').textContent = `Файл: ${ctx.fileNames}`;
  $('#revMonth').value = result.period || '';
  $('#revAptHow').textContent = result.apartmentHow ? `— ${result.apartmentHow}` : '';
  $('#revApts').innerHTML = chipsHtml(state.rev.aptId, result.apartment);
  const w = result.warnings;
  $('#revWarnings').innerHTML = w.length ? `<div class="warn-box"><b>Обратите внимание</b><ul>${w.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : '';
  $('#revFields').innerHTML = SERVICES.map((s) => {
    const r = result.services[s.key];
    const badge = {
      ok: '<span class="badge">распознано</span>',
      absent: '<span class="badge">нет в квитанции</span>',
      check: '<span class="badge warn">проверьте</span>',
      unreadable: '<span class="badge bad">введите вручную</span>',
    }[r.status];
    const noteCls = r.status === 'unreadable' ? 'bad' : r.status === 'check' ? 'warn' : '';
    const notes = [...r.notes];
    if (r.verified) notes.unshift(`✓ Сверено: объём × тариф = ${r.verified}`);
    return `<div class="svc ${r.status === 'check' ? 'need' : ''} ${r.status === 'unreadable' ? 'bad' : ''}" id="rs-${s.key}">
      <div class="svc-main">
        <label class="svc-title" for="r-${s.key}">${s.title} ${badge}</label>
        <input class="money" id="r-${s.key}" data-key="${s.key}" inputmode="decimal" autocomplete="off"
          value="${r.cents == null ? '' : formatAmount(r.cents)}" placeholder="${r.cents == null ? 'сумма?' : '0,00'}">
      </div>
      ${notes.length ? `<div class="svc-note ${noteCls}">${notes.map(esc).join('<br>')}</div>` : ''}
      ${r.source ? `<div class="svc-src">${esc(r.source)}</div>` : ''}
    </div>`;
  }).join('');
  updateReviewTotal();
}

function reviewProblems() {
  const rev = state.rev;
  const problems = [];
  if (!rev.aptId) problems.push('выберите квартиру');
  if (!$('#revMonth').value) problems.push('укажите месяц');
  for (const s of SERVICES) {
    const r = rev.result.services[s.key];
    const raw = $(`#r-${s.key}`).value.trim();
    if (r.status === 'unreadable' && raw === '') problems.push(`введите сумму «${s.title}» (если услуги нет — 0)`);
    else if (parseUserMoney(raw) == null) problems.push(`исправьте сумму «${s.title}»`);
  }
  return problems;
}

function updateReviewTotal() {
  const { amounts, ok } = readFields('r');
  const empties = SERVICES.some((s) => state.rev.result.services[s.key].status === 'unreadable' && $(`#r-${s.key}`).value.trim() === '');
  $('#revTotal').textContent = ok && !empties ? formatRub(totalOf(amounts)) : '—';
}

async function onReviewSave() {
  const problems = reviewProblems();
  if (problems.length) {
    return ask('Перед сохранением', `<ul>${problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>`, [{ label: 'Понятно', value: '' }]);
  }
  const rev = state.rev;
  const { amounts } = readFields('r');
  const period = $('#revMonth').value;
  if (rev.result.period && period !== rev.result.period) {
    const ok = await confirmDlg('Месяц отличается', `В квитанции ${periodText(rev.result.period)}, а выбран ${periodText(period)}. Сохранить за ${periodText(period)}?`, 'Сохранить');
    if (!ok) return;
  }
  const apt = state.apartments.find((a) => a.id === rev.aptId);
  if (rev.result.apartmentNumberFound && rev.result.apartmentNumberFound !== apt.number) {
    const ok = await confirmDlg('Квартира отличается', `В квитанции кв. ${esc(rev.result.apartmentNumberFound)}, а выбрана ${esc(aptLabel(apt))}. Сохранить в ${esc(aptLabel(apt))}?`, 'Сохранить');
    if (!ok) return;
  }
  const rec = await saveWithDuplicateCheck({ aptId: rev.aptId, period, amounts, source: rev.ctx.source, fileName: rev.ctx.fileNames }, null);
  if (!rec) return;
  if (rev.result.account) {
    const map = (await db.getMeta('accountMap')) || {};
    map[rev.result.account] = rev.aptId;
    await db.setMeta('accountMap', map);
  }
  await afterSave(rec);
}

async function onReviewRetry() {
  const ctx = state.rev.ctx;
  if (state.photo && (ctx.fromPhoto || ctx.source !== 'pdf')) {
    state.sub = 'photo';
    render();
    showPhotoPage(state.photo.idx);
    return;
  }
  if (ctx.pdfFile) {
    const v = await ask('Распознать заново', 'Можно прочитать PDF ещё раз или распознать его как картинку — это дольше и менее точно.', [
      { label: 'Прочитать ещё раз', value: 'text', cls: 'primary' },
      { label: 'Распознать как картинку', value: 'ocr' },
      { label: 'Отмена', value: '' },
    ]);
    if (!v) return;
    try {
      await processPdf(ctx.pdfFile, { fileNames: ctx.fileNames, forceOcr: v === 'ocr' });
    } catch (err) {
      busy(null);
      ask('Ошибка', esc(err.message || err), [{ label: 'Понятно', value: '' }]);
    }
  }
}

// ---------- история ----------

function renderHistory() {
  $('#histApts').innerHTML = chipsHtml(state.histApt);
  const recs = [...state.records.values()].filter((r) => r.aptId === state.histApt).sort((a, b) => b.period.localeCompare(a.period));
  if (!recs.length) {
    $('#histList').innerHTML = '<div class="card hint">Для этой квартиры пока нет сохранённых начислений.</div>';
    return;
  }
  $('#histList').innerHTML = `<div class="card">${recs.map((r) => {
    const prev = getRec(r.aptId, shiftPeriod(r.period, -1));
    const t = totalOf(r.amounts);
    let diff = '';
    if (prev) {
      const d = t - totalOf(prev.amounts);
      diff = `<span class="diff ${d > 0 ? 'up' : d < 0 ? 'down' : ''}">${d > 0 ? '+' : d < 0 ? '−' : '±'}${formatAmount(Math.abs(d))} к пред. мес.</span>`;
    }
    const rows = SERVICES.map((s) => {
      const v = r.amounts[s.key];
      const pv = prev?.amounts[s.key];
      const d = pv == null ? '' : v - pv;
      return `<tr><td>${s.title}</td><td>${formatAmount(v)}</td>${prev ? `<td class="diff ${d > 0 ? 'up' : d < 0 ? 'down' : ''}">${d > 0 ? '+' : d < 0 ? '−' : ''}${formatAmount(Math.abs(d))}</td>` : ''}</tr>`;
    }).join('');
    return `<div class="hist-item">
      <div class="hist-head"><b>${periodTitle(r.period)}</b><b>${formatRub(t)}</b></div>
      ${diff}${arithmeticBadge(r)}
      <details><summary>Подробнее и сравнение</summary>
        <table class="cmp">${prev ? '<tr><td></td><td><small>сумма</small></td><td><small>изменение</small></td></tr>' : ''}${rows}</table>
        <div class="apt-actions" style="display:flex;gap:8px;margin-top:8px">
          <button class="btn small" data-hedit="${r.period}">Изменить</button>
          <button class="btn small danger" data-hdel="${r.period}">Удалить</button>
        </div>
      </details>
    </div>`;
  }).join('')}</div>`;
}

// ---------- ещё: копия и квартиры ----------

async function renderMore() {
  $('#appVersion').textContent = APP_VERSION;
  $('#aptManage').innerHTML = state.apartments.map((a) => {
    const n = [...state.records.values()].filter((r) => r.aptId === a.id).length;
    return `<div class="apt-row"><span><b>${esc(aptLabel(a))}</b> <small>${n} зап.</small></span><button class="btn small danger" data-delapt="${a.id}">Удалить</button></div>`;
  }).join('');
  const last = await db.getMeta('lastBackup');
  $('#lastBackup').textContent = last ? `Последняя копия: ${new Date(last).toLocaleString('ru-RU')}` : 'Копия ещё не сохранялась.';
  $('#btnUndoImport').hidden = !(await db.getMeta('beforeImport'));
  await renderCloud();
  let persisted = false;
  try { persisted = await navigator.storage?.persisted?.(); } catch { /* нет API */ }
  $('#storageInfo').textContent = persisted ? 'Браузер не удалит данные сам.' : 'При нехватке места браузер может удалить данные — сохраняйте копии.';
}

async function onExport() {
  const data = await db.exportAll();
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
  const name = `kommunalka-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([blob], name, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    const v = await ask('Сохранить копию', 'Скачайте файл в «Загрузки» или отправьте — например, в Google Диск или себе в мессенджер.', [
      { label: 'Скачать файл', value: 'dl', cls: 'primary' }, { label: 'Отправить…', value: 'share' }, { label: 'Отмена', value: '' },
    ]);
    if (!v) return;
    if (v === 'share') {
      try { await navigator.share({ files: [file], title: name }); } catch { return; }
      await db.setMeta('lastBackup', new Date().toISOString());
      return renderMore();
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  await db.setMeta('lastBackup', new Date().toISOString());
  toast(`Копия сохранена: ${name} (${nRecords(data.records.length)})`);
  renderMore();
}

async function onImport(file) {
  try {
    await restoreData(JSON.parse(await file.text()), 'копии');
  } catch (err) {
    ask('Не удалось восстановить', esc(err.message || 'Файл не читается'), [{ label: 'Понятно', value: '' }]);
  }
}

async function restoreData(data, from) {
  const info = db.validateBackup(data);
  const cur = state.records.size;
  const kirova = info.kirova == null ? '' : ` Кирова, 40: ${plural(info.kirova, 'месяц', 'месяца', 'месяцев')}.`;
  const ok = await confirmDlg(`Восстановить из ${from}?`,
    `Сейчас в приложении <b>${nRecords(cur)}</b>, в копии — <b>${nRecords(info.records)}</b> (${plural(info.apartments, 'квартира', 'квартиры', 'квартир')}).${kirova} Текущие данные <b>заменятся</b> копией.<br><br>Если что-то пойдёт не так, их можно вернуть кнопкой «Вернуть данные до восстановления».`,
    'Заменить данные', 'danger');
  if (!ok) return false;
  await db.importReplace(data);
  await reload();
  dataChanged();
  render();
  toast(`Данные восстановлены из ${from}`);
  return true;
}

async function onUndoImport() {
  const before = await db.getMeta('beforeImport');
  if (!before) return;
  if (!(await confirmDlg('Вернуть прежние данные?', `Вернутся данные, которые были до восстановления из копии (${nRecords(before.records.length)}). Текущие заменятся.`, 'Вернуть', 'danger'))) return;
  await db.importReplace(before);
  await reload();
  dataChanged();
  render();
  toast('Прежние данные возвращены');
}

// ---------- облачная копия ----------

let syncTimer = null;
let syncing = null;

/** Вызывается после любого изменения данных. */
async function dataChanged() {
  if (!(await cloud.getCloud())) return;
  await cloud.markPending();
  scheduleSync();
}
function scheduleSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => runSync(), 1200);
}
async function runSync({ manual = false } = {}) {
  if (syncing) return syncing;
  syncing = (async () => {
    try {
      if (!(await cloud.getCloud())) return;
      if (manual) busy('Отправляю копию в облако…');
      const n = await cloud.push();
      busy(null);
      if (manual) toast(`Копия в облаке обновлена (${nRecords(n)})`);
    } catch (err) {
      busy(null);
      toast(`Облачная копия не отправлена: ${err.message}`, 5000);
    } finally {
      syncing = null;
      if (state.tab === 'more' && !state.sub) renderCloud();
    }
  })();
  return syncing;
}

async function renderCloud() {
  const cfg = await cloud.getCloud();
  $('#cloudOff').hidden = Boolean(cfg);
  $('#cloudOn').hidden = !cfg;
  if (!cfg) return;
  const when = cfg.lastPush ? new Date(cfg.lastPush).toLocaleString('ru-RU') : 'ещё не отправлялась';
  $('#cloudStatus').innerHTML = `Репозиторий <b>${esc(cfg.repo)}</b>.<br>Последняя отправка: ${esc(when)}${cfg.pending && !cfg.lastError ? ' (есть неотправленные изменения)' : ''}.`;
  $('#cloudError').hidden = !cfg.lastError;
  $('#cloudError').textContent = cfg.lastError ? `Ошибка: ${cfg.lastError}` : '';
}

async function onCloudConnect() {
  const repo = $('#cloudRepo').value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');
  const token = $('#cloudToken').value.trim();
  busy('Проверяю доступ к GitHub…');
  let info;
  let remote;
  try {
    info = await cloud.check(repo, token);
    remote = await cloud.pull({ repo, token });
  } finally { busy(null); }
  if (!info.private) {
    const ok = await confirmDlg('Репозиторий публичный',
      'Копию в нём сможет прочитать кто угодно. Лучше сделайте репозиторий приватным (Settings → Danger Zone → Change visibility). Всё равно подключить?',
      'Подключить', 'danger');
    if (!ok) return;
  }
  await cloud.saveConfig(repo, token);
  $('#cloudToken').value = '';
  if (remote) {
    db.validateBackup(remote);
    const local = state.records.size;
    const date = remote.exportedAt ? new Date(remote.exportedAt).toLocaleString('ru-RU') : '—';
    const v = await ask('В облаке уже есть копия',
      `В облаке: <b>${nRecords(remote.records.length)}</b> от ${esc(date)}.<br>На телефоне: <b>${nRecords(local)}</b>.<br><br>Какие данные оставить?`,
      [
        { label: 'Взять из облака', value: 'pull', cls: local ? '' : 'primary' },
        { label: 'Отправить с телефона', value: 'push', cls: local ? 'primary' : '' },
      ]);
    if (v === 'pull') {
      await db.importReplace(remote);
      await reload();
      render();
      toast('Подключено. Данные взяты из облака');
      return;
    }
    if (v !== 'push') { await cloud.markPending(); renderCloud(); toast('Подключено. Копия отправится при следующем изменении'); return; }
  }
  await runSync({ manual: true });
  renderCloud();
}

async function onCloudPull() {
  busy('Загружаю копию из облака…');
  let data;
  try { data = await cloud.pull(); } finally { busy(null); }
  if (!data) return ask('Копии нет', 'В облаке ещё нет копии. Она появится после первой отправки.', [{ label: 'Понятно', value: '' }]);
  await restoreData(data, 'облака');
}

async function onCloudOff() {
  if (!(await confirmDlg('Отключить облачную копию?', 'Копия в GitHub останется, но новые изменения отправляться не будут. Токен будет удалён с телефона.', 'Отключить', 'danger'))) return;
  await cloud.disconnect();
  renderCloud();
}

// ---------- события ----------

function bind() {
  document.querySelectorAll('#tabbar button').forEach((b) => b.addEventListener('click', async () => { await flushKirova(); state.tab = b.dataset.tab; render(); window.scrollTo(0, 0); }));
  $('#btnBack').addEventListener('click', leaveSub);
  document.querySelectorAll('[data-month-step]').forEach((b) => b.addEventListener('click', () => {
    state.period = shiftPeriod(state.period, Number(b.dataset.monthStep));
    renderMonth();
  }));
  $('#monthInput').addEventListener('change', (e) => { if (e.target.value) { state.period = e.target.value; renderMonth(); } });
  $('#aptCards').addEventListener('click', (e) => {
    const id = e.target.closest('[data-edit]')?.dataset.edit;
    if (id) openEdit(id, state.period);
  });
  $('#btnManual').addEventListener('click', () => openEdit(state.tab === 'history' ? state.histApt : null, state.period));
  $('#fileInput').addEventListener('change', (e) => { const f = e.target.files; onFiles(f).finally(() => { e.target.value = ''; }); });

  // редактирование
  $('#editApts').addEventListener('click', (e) => {
    const id = e.target.closest('[data-apt]')?.dataset.apt;
    if (!id) return;
    state.edit.aptId = id;
    loadEditRecord(false);
  });
  $('#editMonth').addEventListener('change', (e) => {
    if (!e.target.value) return;
    state.edit.period = e.target.value;
    loadEditRecord(false);
  });
  $('#editFields').addEventListener('input', () => { state.edit.dirty = true; updateEditTotal(); });
  $('#editSave').addEventListener('click', () => onEditSave().catch(showError));
  $('#editCancel').addEventListener('click', leaveSub);
  $('#editDelete').addEventListener('click', () => onEditDelete().catch(showError));

  // фото
  $('#rotL').addEventListener('click', () => state.editor.rotate(-1));
  $('#rotR').addEventListener('click', () => state.editor.rotate(1));
  $('#frameReset').addEventListener('click', () => state.editor.resetFrame());
  $('#photoPrev').addEventListener('click', () => { storePhotoPage(); showPhotoPage(Math.max(0, state.photo.idx - 1)); });
  $('#photoNext').addEventListener('click', () => { storePhotoPage(); showPhotoPage(Math.min(state.photo.images.length - 1, state.photo.idx + 1)); });
  $('#photoGo').addEventListener('click', onPhotoRecognize);
  $('#photoCancel').addEventListener('click', leaveSub);

  // проверка
  $('#revApts').addEventListener('click', (e) => {
    const id = e.target.closest('[data-apt]')?.dataset.apt;
    if (!id) return;
    state.rev.aptId = id;
    $('#revApts').innerHTML = chipsHtml(id, state.rev.result.apartment);
  });
  $('#revFields').addEventListener('input', updateReviewTotal);
  $('#revSave').addEventListener('click', () => onReviewSave().catch(showError));
  $('#revRetry').addEventListener('click', () => onReviewRetry().catch(showError));
  $('#revCancel').addEventListener('click', leaveSub);

  // история
  $('#histApts').addEventListener('click', (e) => {
    const id = e.target.closest('[data-apt]')?.dataset.apt;
    if (id) { state.histApt = id; renderHistory(); }
  });
  $('#histList').addEventListener('click', async (e) => {
    const ed = e.target.closest('[data-hedit]')?.dataset.hedit;
    if (ed) return openEdit(state.histApt, ed);
    const del = e.target.closest('[data-hdel]')?.dataset.hdel;
    if (del) {
      const apt = state.apartments.find((a) => a.id === state.histApt);
      const rec = getRec(state.histApt, del);
      if (!(await confirmDlg('Удалить запись?', `${esc(aptLabel(apt))}, ${periodText(del)} — ${formatRub(rec.total)}. Вернуть запись можно будет только из резервной копии.`, 'Удалить', 'danger'))) return;
      await db.deleteRecord(state.histApt, del);
      await reload();
      dataChanged();
      renderHistory();
      toast('Запись удалена');
    }
  });

  // ещё
  $('#btnExport').addEventListener('click', () => onExport().catch(showError));
  $('#importFile').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) onImport(f).finally(() => { e.target.value = ''; }); });
  $('#btnUndoImport').addEventListener('click', () => onUndoImport().catch(showError));
  $('#btnCloudConnect').addEventListener('click', () => onCloudConnect().catch(showError));
  $('#btnCloudPush').addEventListener('click', () => runSync({ manual: true }));
  $('#btnCloudPull').addEventListener('click', () => onCloudPull().catch(showError));
  $('#btnCloudOff').addEventListener('click', () => onCloudOff().catch(showError));
  window.addEventListener('online', async () => { if ((await cloud.getCloud())?.pending) scheduleSync(); });
  $('#btnAddApt').addEventListener('click', async () => {
    const n = $('#newAptNumber').value.trim();
    if (!/^[0-9]{1,5}[а-яА-Яa-zA-Z]?$/.test(n)) return toast('Введите номер квартиры');
    try {
      await db.addApartment(n);
      $('#newAptNumber').value = '';
      await reload();
      dataChanged();
      renderMore();
      toast(`Квартира № ${n} добавлена`);
    } catch (err) { toast(err.message); }
  });
  $('#aptManage').addEventListener('click', async (e) => {
    const id = e.target.closest('[data-delapt]')?.dataset.delapt;
    if (!id) return;
    const apt = state.apartments.find((a) => a.id === id);
    const n = [...state.records.values()].filter((r) => r.aptId === id).length;
    if (!(await confirmDlg(`Удалить ${aptLabel(apt)}?`, n ? `Вместе с квартирой удалятся <b>${nRecords(n)}</b>. Лучше сначала сохраните резервную копию.` : 'Записей у квартиры нет.', 'Удалить', 'danger'))) return;
    await db.deleteApartment(id);
    await reload();
    dataChanged();
    renderMore();
  });
}

function showError(err) {
  busy(null);
  console.error(err);
  ask('Ошибка', esc(err?.message || err), [{ label: 'Понятно', value: '' }]);
}

// ---------- запуск ----------

async function init() {
  bind();
  try {
    await initKirova({ initialPeriod: state.period, shiftPeriod, periodTitle, esc, toast, showError, dataChanged });
    await reload();
  } catch (err) {
    showError(new Error(`Не удалось открыть хранилище: ${err.message}`));
    return;
  }
  // Показываем последний месяц с данными, если за прошлый месяц ещё ничего нет.
  const periods = [...state.records.values()].map((r) => r.period).sort();
  if (periods.length && !periods.includes(state.period)) state.period = periods[periods.length - 1];
  render();
  if ((await cloud.getCloud())?.pending) scheduleSync();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').then((reg) => {
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w?.addEventListener('statechange', () => {
          if (w.state === 'activated' && navigator.serviceWorker.controller) toast('Приложение обновлено, данные на месте.', 3500);
        });
      });
    }).catch((e) => console.warn('SW', e));
  }
}
init();
