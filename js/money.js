// Все суммы — целые числа в копейках.

export const SERVICES = [
  { key: 'cold', title: 'Холодная вода', hint: 'ХВС' },
  { key: 'hotCarrier', title: 'Горячая вода — носитель', hint: 'ХВС для ГВС' },
  { key: 'hotEnergy', title: 'Горячая вода — энергия', hint: 'Подогрев ГВС' },
  { key: 'elDay', title: 'Электроэнергия — день', hint: 'Т1' },
  { key: 'elNight', title: 'Электроэнергия — ночь', hint: 'Т2' },
  { key: 'drain', title: 'Водоотведение', hint: 'Канализация' },
];
export const SERVICE_KEYS = SERVICES.map((s) => s.key);

/** Строгий разбор суммы с ровно двумя знаками после запятой: "1 836,36", "1477.60". */
export function parseMoneyStrict(str) {
  if (str == null) return null;
  const s = String(str).replace(/[\s  ]/g, '').replace(/₽|руб\.?$/i, '').replace('−', '-');
  const m = /^(-?)(\d{1,7})[.,](\d{2})$/.exec(s);
  if (!m) return null;
  const cents = Number(m[2]) * 100 + Number(m[3]);
  return m[1] ? -cents : cents;
}

/** Разбор пользовательского ввода: "1234", "1234,5", "1 234.56". '' → 0. Ошибка → null. */
export function parseUserMoney(str) {
  const s = String(str ?? '').replace(/[\s  ₽]/g, '').replace(',', '.');
  if (s === '') return 0;
  const m = /^(\d{1,7})(?:\.(\d{0,2}))?$/.exec(s);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0'));
}

export function formatAmount(cents) {
  if (cents == null || !Number.isInteger(cents)) return '';
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const rub = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const kop = String(abs % 100).padStart(2, '0');
  return `${neg ? '−' : ''}${rub},${kop}`;
}
export const formatRub = (cents) => `${formatAmount(cents)} ₽`;

export function sumCents(list) {
  let t = 0;
  for (const v of list) {
    if (!Number.isInteger(v)) throw new Error('Сумма не является целым числом копеек');
    t += v;
  }
  return t;
}

export function totalOf(amounts) {
  return sumCents(SERVICE_KEYS.map((k) => amounts?.[k] ?? 0));
}
