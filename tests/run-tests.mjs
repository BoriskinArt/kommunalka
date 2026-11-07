// Тесты: node tests/run-tests.mjs [путь_к_pdfjs_legacy]
// Проверяют арифметику на контрольных примерах ТЗ, классификацию названий и разбор реальных PDF.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMoneyStrict, parseUserMoney, formatRub, totalOf } from '../js/money.js';
import { classifyService, parseReceipt } from '../js/parser.js';
import { pdfTextToItems } from '../js/extract.js';

const here = path.dirname(fileURLToPath(import.meta.url));
let passed = 0;
let failed = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { passed++; console.log('  ✓', name); },
    (e) => { failed++; console.log('  ✗', name, '\n     ', e.message); },
  );
}
const rub = (s) => parseUserMoney(s);

console.log('Контрольные примеры (раздел 16 ТЗ)');
const CONTROL = [
  ['Кв. 76, сентябрь 2026', ['177,43', '182,82', '1155,49', '679,96', '74,69', '265,44'], '2 535,83 ₽'],
  ['Кв. 76, октябрь 2026', ['169,79', '201,21', '1294,00', '709,44', '70,58', '273,55'], '2 718,57 ₽'],
  ['Кв. 231, сентябрь 2026', ['361,31', '219,37', '1279,69', '1153,60', '106,20', '427,86'], '3 548,03 ₽'],
  ['Кв. 231, октябрь 2026', ['445,21', '309,39', '1836,36', '1367,46', '155,88', '556,40'], '4 670,70 ₽'],
];
const keys = ['cold', 'hotCarrier', 'hotEnergy', 'elDay', 'elNight', 'drain'];
for (const [name, vals, expected] of CONTROL) {
  await test(name, () => {
    const amounts = Object.fromEntries(keys.map((k, i) => [k, rub(vals[i])]));
    assert.equal(formatRub(totalOf(amounts)).replace(/ /g, ' '), expected);
  });
}
await test('Общий итог за месяц складывается из итогов квартир', () => {
  const t = CONTROL.map(([, vals]) => totalOf(Object.fromEntries(keys.map((k, i) => [k, rub(vals[i])]))));
  assert.equal(t[0] + t[2], 253583 + 354803);
});
await test('Строгий разбор денег', () => {
  assert.equal(parseMoneyStrict('1 836,36'), 183636);
  assert.equal(parseMoneyStrict('1477.60'), 147760);
  assert.equal(parseMoneyStrict('1836,3'), null);
  assert.equal(parseMoneyStrict('18З6,36'), null);
  assert.equal(rub('0,1'), 10);
  assert.equal(rub('12,345'), null);
});

console.log('Классификация названий услуг');
const CASES = {
  cold: ['ХВС', 'Холодная вода', 'Холодное водоснабжение', 'Холодное водоснабжение (ХВС)', 'Водоснабжение холодное',
    'Холодное водоснабжение индивидуальное', 'ХВС индивидуальное потребление', 'Холодное водоснабжение жилого помещения',
    'ХОЛОДНОЕ В/С', 'ХВС ПР КВ', 'XBC' /* латиница */],
  hotCarrier: ['ХВС для ГВС', 'ХВС на ГВС', 'ХВС для горячего водоснабжения', 'Холодная вода для ГВС', 'Холодное водоснабжение для ГВС',
    'Холодная вода на подогрев', 'Вода для приготовления ГВС', 'Горячее водоснабжение — носитель', 'Горячая вода (носитель)',
    'ГВС (носитель)', 'Носитель ГВС', 'Компонент ХВС в составе ГВС', 'Компонент холодной воды для ГВС', 'ГОРЯЧЕЕ В/С (НОСИТЕЛЬ)',
    'ХВС для ГВС пр', 'ХВСдляГВС'],
  hotEnergy: ['Подогрев ГВС', 'Подогрев горячей воды', 'Подогрев воды', 'Горячее водоснабжение — энергия', 'Горячая вода (энергия)',
    'ГВС (энергия)', 'Энергия ГВС', 'Тепловая энергия на подогрев воды', 'Тепловая энергия для ГВС',
    'Компонент тепловой энергии в составе ГВС', 'Нагрев воды', 'Тепло на подогрев воды', 'Тепловая энергия на горячее водоснабжение',
    'ГОРЯЧЕЕ В/С (ЭНЕРГИЯ)', 'Подогрев ГВС пр', 'подогрев ГВС'],
  elDay: ['Электроснабжение день', 'Электроснабжение дневное', 'Электроэнергия день', 'Электроэнергия дневная', 'Электричество день',
    'Электрическая энергия день', 'Электроэнергия Т1', 'Т1', 'Тариф Т1', 'Дневная зона', 'Дневное потребление электроэнергии',
    'ЭЛЕКТРИЧЕСТВО ДЕНЬ ДВУХТАРИФНЫЙ ПУ (Д1)', 'Эл-во день', 'Элетроснабжение день', 'Электроснабжение-день'],
  elNight: ['Электроснабжение ночь', 'Электроснабжение ночное', 'Электроэнергия ночь', 'Электроэнергия ночная', 'Электричество ночь',
    'Электрическая энергия ночь', 'Электроэнергия Т2', 'Т2', 'Тариф Т2', 'Ночная зона', 'Ночное потребление электроэнергии',
    'ЭЛЕКТРИЧЕСТВО НОЧЬ ДВУХТАРИФНЫЙ ПУ (Д1)', 'Эл-во ночь', 'Элетроснабжение ночь'],
  drain: ['Водоотведение', 'Водоотведение ХВС и ГВС', 'Водоотведение холодной и горячей воды', 'Водоотведение (стоки)',
    'Отведение сточных вод', 'Отведение сточных вод ХВС и ГВС', 'Стоки', 'Канализация', 'Приём сточных вод', 'Услуга водоотведения',
    'Канал. пр. кв.', 'ВОДООТВЕДЕНИЕ'],
};
for (const [key, names] of Object.entries(CASES)) {
  await test(`${key}: ${names.length} вариантов`, () => {
    const bad = names.filter((n) => classifyService(n).key !== key).map((n) => `«${n}» → ${classifyService(n).key}`);
    assert.deepEqual(bad, []);
  });
}
await test('Исключаются ОДН, СОИ и прочие услуги', () => {
  const excluded = ['ХВС СОИ', 'ГВС СОИ', 'Электроэнергия СОИ', 'ВОДООТВЕДЕНИЕ ОДН', 'ГОРЯЧЕЕ В/С (НОСИТЕЛЬ) ОДН',
    'ГОРЯЧЕЕ В/С (ЭНЕРГИЯ) ОДН', 'ХОЛОДНОЕ В/С ОДН', 'ЭЛЕКТРОСНАБЖЕНИЕ ОДН', 'ХВС для ГВС ОДН', 'ПодогревГВС ОДН',
    'Вод-ние ОДН', 'ЭЛ-ВО ОДН', 'ХВС ОДН', 'Содержание и ремонт жилья', 'ОТОПЛЕНИЕ', 'ОБРАЩЕНИЕ С ТКО', 'Вывоз мусора',
    'ВЗНОС НА КАПИТАЛЬНЫЙ РЕМОНТ', 'ОХРАНА', 'Домофон', 'СОДЕРЖАНИЕ ЖИЛОГО ПОМЕЩЕНИЯ', 'ХВС на содержание общего имущества',
    'Электроэнергия в целях содержания общего имущества'];
  const bad = excluded.filter((n) => classifyService(n).key).map((n) => `«${n}» → ${classifyService(n).key}`);
  assert.deepEqual(bad, []);
});
await test('Т1/Т2 без контекста электроэнергии не считаются', () => {
  assert.equal(classifyService('Т1', { electricityContext: false }).key, null);
  assert.equal(classifyService('Тариф Т2', { electricityContext: false }).key, null);
});
await test('«Горячее водоснабжение» без уточнения — не угадываем', () => {
  const r = classifyService('Горячее водоснабжение');
  assert.equal(r.key, null);
  assert.ok(r.ambiguous);
});

// ---------- Раздел общего имущества (синтетическая таблица) ----------
console.log('Раздел общего имущества');
function table(rows) {
  // rows: [name, volume, tariff, accrued] | ['#', заголовок раздела]
  const items = [
    { str: 'Виды услуг', x: 20, y: 10, w: 40, h: 7 }, { str: 'Объем', x: 160, y: 10, w: 20, h: 7 },
    { str: 'Тариф', x: 250, y: 10, w: 25, h: 7 }, { str: 'Начислено', x: 300, y: 10, w: 35, h: 7 },
    { str: 'по тарифу', x: 300, y: 17, w: 35, h: 7 }, { str: 'Перерасчеты', x: 360, y: 10, w: 45, h: 7 },
    { str: 'кв. 76 за октябрь 2026 электроэнергия', x: 20, y: 0, w: 100, h: 7 },
  ];
  rows.forEach((r, i) => {
    const y = 40 + i * 8;
    if (r[0] === '#') items.push({ str: r[1], x: 20, y, w: 300, h: 7 });
    else items.push({ str: r[0], x: 20, y, w: 100, h: 7 }, { str: r[1], x: 165, y, w: 15, h: 7 },
      { str: r[2], x: 255, y, w: 20, h: 7 }, { str: r[3], x: 310, y, w: 22, h: 7 }, { str: '0.00', x: 380, y, w: 15, h: 7 });
  });
  return [{ items, source: 'pdf' }];
}
const APT76 = [{ id: 'apt-76', number: '76' }];
await test('Строки раздела общего имущества без пометки ОДН не учитываются', () => {
  const r = parseReceipt(table([
    ['#', 'в том числе коммунальные ресурсы, потребляемые при содержании общего имущества в многоквартирном доме:'],
    ['Холодная вода', '0.43', '37.73', '16.33'], ['Сточные воды', '0.52', '27.82', '14.60'],
    ['#', 'Коммунальные услуги'],
    ['Холодное водоснабжение', '9', '37.73', '339.57'], ['Водоотведение', '18', '27.82', '500.76'],
  ]), { knownApartments: APT76 });
  assert.equal(r.services.cold.cents, 33957);
  assert.equal(r.services.drain.cents, 50076);
  assert.equal(r.services.cold.status, 'ok');
});
await test('Если есть только строка общего имущества — 0 сам не ставится', () => {
  const r = parseReceipt(table([
    ['#', 'в том числе коммунальные ресурсы, потребляемые при содержании общего имущества:'],
    ['Сточные воды', '0.52', '27.82', '14.60'],
    ['#', 'Коммунальные услуги'],
    ['Холодное водоснабжение', '9', '37.73', '339.57'],
  ]), { knownApartments: APT76 });
  assert.equal(r.services.drain.cents, null);
  assert.equal(r.services.drain.status, 'unreadable');
  assert.equal(r.services.hotCarrier.cents, 0); // услуги нет вовсе — 0
});

// ---------- Реальные PDF ----------
const pdfjsPath = process.argv[2];
const APTS = [{ id: 'apt-76', number: '76' }, { id: 'apt-211', number: '211' }, { id: 'apt-231', number: '231' }, { id: 'apt-5', number: '5' }];
const FIXTURES = [
  { file: 'epd-231-2026-10.pdf', apt: 'apt-231', period: '2026-10',
    expect: { cold: 44521, hotCarrier: 30939, hotEnergy: 183636, elDay: 136746, elNight: 15588, drain: 55640 } },
  { file: 'antey-76-2026-08.pdf', apt: 'apt-76', period: '2026-08',
    expect: { cold: 35486, hotCarrier: 19356, hotEnergy: 122339, elDay: 147760, elNight: 32646, drain: 40409 } },
  { file: 'altair-76-2026-10.pdf', apt: 'apt-76', period: '2026-10',
    expect: { cold: 33957, hotCarrier: 33957, hotEnergy: 218375, elDay: 124343, elNight: 21074, drain: 50076 } },
];
if (pdfjsPath) {
  console.log('Разбор реальных квитанций (PDF)');
  const pdfjs = await import(pdfjsPath);
  for (const fx of FIXTURES) {
    const fp = path.join(here, 'fixtures', fx.file);
    if (!fs.existsSync(fp)) { console.log('  – нет файла', fx.file); continue; }
    await test(fx.file, async () => {
      const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(fp)), verbosity: 0 }).promise;
      const pages = [];
      for (let p = 1; p <= doc.numPages; p++) {
        const page = await doc.getPage(p);
        const vp = page.getViewport({ scale: 1 });
        pages.push({ items: pdfTextToItems(await page.getTextContent(), vp.height), source: 'pdf' });
      }
      const r = parseReceipt(pages, { knownApartments: APTS });
      assert.equal(r.apartment, fx.apt, 'квартира');
      assert.equal(r.period, fx.period, 'период');
      for (const [k, v] of Object.entries(fx.expect)) {
        assert.equal(r.services[k].cents, v, `${k}: ${r.services[k].cents} ≠ ${v} (${r.services[k].notes.join('; ')})`);
        assert.equal(r.services[k].status, 'ok', `${k} статус ${r.services[k].status}: ${r.services[k].notes.join('; ')}`);
      }
      if (process.env.VERBOSE) console.log(JSON.stringify(r, null, 1));
    });
  }
}

console.log(`\nИтого: ${passed} пройдено, ${failed} с ошибками`);
process.exit(failed ? 1 : 0);
