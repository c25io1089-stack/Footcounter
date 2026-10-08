// Excel тайлан (.xlsx) — «Бүрэн тайлан» товч үүнийг татна.
// CSV нь зөвхөн түүхий утга өгдөг тул Excel-д нээхэд багана нарийн, гарчиг нь
// хаалтанд, тоо нь баруун зэрэгцээгүй — уншихад хэцүү байв. Энд багана бүрийн
// өргөн, тооны формат, гарчгийн хэв маяг, шүүлтүүр, хөлдөөсөн толгойг нь
// бэлнээр нь өгнө: хэрэглэгч файлаа нээхэд шууд бэлэн тайлан харагдана.
const ExcelJS = require('exceljs');

// Самбарын брэндийн өнгө (app.css-тэй нийцүүлэв)
const NAVY = 'FF1E293B';
const BLUE = 'FF2563EB';
const SOFT = 'FFF8FAFC';
const LINE = 'FFE2E8F0';
const MUTED = 'FF64748B';
const BAR = 'FF93C5FD';

const DOW = ['Даваа', 'Мягмар', 'Лхагва', 'Пүрэв', 'Баасан', 'Бямба', 'Ням'];

const NF = {
  int: '#,##0',
  dec1: '#,##0.0',
  pct: '0.0%',
  sec: '#,##0.0" сек"',
  min: '#,##0.0" мин"',
  cm: '#,##0" см"',
  dt: 'yyyy-mm-dd hh:mm',
  date: 'yyyy-mm-dd',
};

// ---- Excel-ийн огнооны серийн дугаар. Багцын цаг нь аль хэдийн тайлангийн
// цагийн бүсэд бичигдсэн «YYYY-MM-DD HH:MM:SS» мөр тул цагийн бүс дахин
// хөрвүүлэхгүй — хэрэглэгчийн хараад байсан цаг яг тэр хэвээрээ файлд орно.
function xlSerial(y, mo, d, h = 0, mi = 0, s = 0) {
  return Math.floor(Date.UTC(y, mo - 1, d) / 86400000) + 25569 + (h * 3600 + mi * 60 + s) / 86400;
}
function bucketSerial(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(v || ''));
  return m ? xlSerial(+m[1], +m[2], +m[3], +m[4], +m[5]) : null;
}
function dateSerial(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || ''));
  return m ? xlSerial(+m[1], +m[2], +m[3]) : null;
}
// timestamptz (ISO) → тайлангийн цагийн бүс дэх уншигдах мөр
function tsText(v, tz) {
  if (!v) return '—';
  try {
    return new Intl.DateTimeFormat('sv-SE', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(new Date(v)).replace('T', ' ');
  } catch { return String(v); }
}

const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const share = (v, total) => (total ? Number(v || 0) / total : null);

// ================= хэв маягийн туслахууд =================
function thin(argb = LINE) { return { style: 'thin', color: { argb } }; }

// Хуудасны толгой: нэр + контекст. Хэвлэхэд ч ойлгомжтой байхаар.
function titleBlock(ws, nCols, title, lines) {
  const colLetter = (n) => {
    let s = '';
    while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = (n - r - 1) / 26; }
    return s;
  };
  const last = colLetter(nCols);
  ws.mergeCells(`A1:${last}1`);
  const t = ws.getCell('A1');
  t.value = title;
  t.font = { name: 'Calibri', size: 16, bold: true, color: { argb: NAVY } };
  t.alignment = { vertical: 'middle' };
  ws.getRow(1).height = 26;

  let r = 2;
  for (const line of lines.filter(Boolean)) {
    ws.mergeCells(`A${r}:${last}${r}`);
    const c = ws.getCell(`A${r}`);
    c.value = line;
    c.font = { size: 10, color: { argb: MUTED } };
    r++;
  }
  ws.getRow(r).height = 6;
  return r + 1;   // дараагийн чөлөөт мөр
}

// Хүснэгтийн гарчиг: бараан дэвсгэр, цагаан тод бичиг, хөлдөөнө
function headerRow(ws, rowIdx, cols) {
  const row = ws.getRow(rowIdx);
  cols.forEach((c, i) => {
    const cell = row.getCell(i + 1);
    cell.value = c.h;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10.5 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
    cell.alignment = { vertical: 'middle', horizontal: c.t && c.t !== 'text' ? 'right' : 'left', wrapText: true };
    cell.border = { bottom: thin(NAVY) };
  });
  row.height = 24;
  // Нэг хуудсанд хэд хэдэн хүснэгт байж болох тул өргөнийг зөвхөн нэмэгдүүлнэ —
  // доорх хүснэгт дээрхийнхээ бичгийг тасалж болохгүй.
  cols.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    col.width = Math.max(col.width || 0, c.w || 14);
  });
  return row;
}

// Утгын мөрүүд. Сондгой мөрийг сулхан будаж уншихад хялбар болгоно.
function bodyRows(ws, startRow, cols, rows) {
  rows.forEach((data, n) => {
    const row = ws.getRow(startRow + n);
    cols.forEach((c, i) => {
      const cell = row.getCell(i + 1);
      const v = data[i];
      cell.value = v === undefined ? null : v;
      if (c.t && c.t !== 'text') cell.numFmt = NF[c.t] || NF.int;
      cell.alignment = { vertical: 'middle', horizontal: c.t && c.t !== 'text' ? 'right' : 'left' };
      cell.font = { size: 10.5, color: { argb: c.strong ? NAVY : 'FF0F172A' }, bold: !!c.strong };
      cell.border = { bottom: thin() };
      if (n % 2) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SOFT } };
    });
    row.height = 18;
  });
  return startRow + rows.length;
}

// Нэг хуудсанд нэг хүснэгт: толгой + мөрүүд + шүүлтүүр + хөлдөөлт
function table(ws, startRow, cols, rows, opt = {}) {
  headerRow(ws, startRow, cols);
  const end = bodyRows(ws, startRow + 1, cols, rows);
  if (rows.length) {
    ws.autoFilter = { from: { row: startRow, column: 1 }, to: { row: end - 1, column: cols.length } };
    if (opt.bar) {
      const col = String.fromCharCode(64 + opt.bar);
      ws.addConditionalFormatting({
        ref: `${col}${startRow + 1}:${col}${end - 1}`,
        rules: [{ type: 'dataBar', cfvo: [{ type: 'min' }, { type: 'max' }], color: { argb: BAR } }],
      });
    }
  } else {
    const c = ws.getCell(startRow + 1, 1);
    c.value = 'Энэ хугацаанд өгөгдөл алга';
    c.font = { size: 10.5, italic: true, color: { argb: MUTED } };
  }
  ws.views = [{ state: 'frozen', ySplit: startRow }];
  return end;
}

// ================= тайлан =================
// d = { meta, totals, occupancy, byDevice, byLocation, series, rows, heat, dedup }
async function buildWorkbook(d) {
  const tz = d.meta.tz;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Footfall';
  wb.created = new Date();

  const ctx = [
    `Байгууллага: ${d.meta.tenant}`,
    `Хугацаа: ${d.meta.from} — ${d.meta.to}  (${tz})`,
    `Байршил: ${d.meta.loc}      Төхөөрөмж: ${d.meta.dev}`,
    `Татсан: ${tsText(new Date().toISOString(), tz)}`,
  ];

  // ---------- 1. Хураангуй ----------
  {
    const ws = wb.addWorksheet('Хураангуй', { properties: { defaultRowHeight: 18 } });
    let r = titleBlock(ws, 4, 'Footfall — хүний урсгалын тайлан', ctx);

    const t = d.totals;
    const ad = num(t.in_adult) || 0, ch = num(t.in_child) || 0;
    const unAC = Math.max(0, (num(t.in_count) || 0) - ad - ch);
    const kCols = [
      { h: 'Үзүүлэлт', w: 34 }, { h: 'Утга', w: 16, t: 'int' },
      { h: 'Нэгж', w: 10 }, { h: 'Тайлбар', w: 56 },
    ];
    const kRows = [
      ['Орсон', num(t.in_count) || 0, 'хүн', 'Тоолох шугамыг дотогш давсан нийт тоо'],
      ['Гарсан', num(t.out_count) || 0, 'хүн', 'Тоолох шугамыг гадагш давсан нийт тоо'],
      ['Өнгөрсөн', num(t.passby) || 0, 'хүн', 'Шугам хүрэлгүй хажуугаар өнгөрсөн'],
      ['Буцсан', num(t.turnback) || 0, 'хүн', 'Орох гэж ойртоод буцсан'],
      ['Одоо дотор байгаа', num(d.occupancy && d.occupancy.total) || 0, 'хүн', 'Орсон − гарсан (эсвэл төхөөрөмжийн тоолол)'],
      ['Насанд хүрэгч (орсон)', ad, 'хүн', 'Төхөөрөмжийн өндрийн ангиллаар'],
      ['Хүүхэд (орсон)', ch, 'хүн', 'Төхөөрөмжийн өндрийн ангиллаар'],
      ['Ангилагдаагүй (орсон)', unAC, 'хүн', 'Насанд хүрэгч/хүүхэд гэж тодорхойлогдоогүй'],
      ['Тоолох бүсэд байсан дундаж', num(t.avg_stay_ms) ? num(t.avg_stay_ms) / 1000 : null, 'сек', 'Камерын харааны талбарт байсан хором — дэлгүүрт байсан хугацаа БИШ'],
      ['Дэлгүүрт байсан дундаж', num(t.store_dwell_ms) ? num(t.store_dwell_ms) / 60000 : null, 'мин', t.store_dwell_source ? `Эх сурвалж: ${t.store_dwell_source}` : 'REID тайлан эсвэл орох→гарах хос шаардана'],
      ['Дэлгүүрт байсан — зочны тоо', num(t.store_dwell_n) || 0, 'зочин', 'Дээрх дунджийг тооцоход хамрагдсан зочин'],
      ['Зогссон зочин', num(t.stay_count) || 0, 'зочин', `Босгоос удаан зогссон (босго ${((num(t.stay_threshold_ms) || 0) / 1000).toFixed(0)} сек)`],
    ];
    // Нэгжүүд өөр өөр тул «Утга» баганад int формат тохирохгүй мөрүүдийг нь тусад нь
    headerRow(ws, r, kCols);
    const first = r + 1;
    bodyRows(ws, first, kCols, kRows);
    [8, 9].forEach((i) => { ws.getCell(first + i, 2).numFmt = NF.dec1; });
    r = first + kRows.length + 1;

    // --- Зочны бүтэц ---
    const s = d.profile;
    const gT = s.male + s.female + s.gender_unknown;
    const aT = s.age.reduce((a, b) => a + b, 0);
    const hT = s.hgt.reduce((a, b) => a + b, 0);
    ws.getCell(r, 1).value = 'Зочны бүтэц';
    ws.getCell(r, 1).font = { size: 13, bold: true, color: { argb: NAVY } };
    r += 1;
    const pCols = [
      { h: 'Бүлэг', w: 20 }, { h: 'Ангилал', w: 22 },
      { h: 'Тоо', w: 14, t: 'int' }, { h: 'Хувь', w: 12, t: 'pct' },
    ];
    const pRows = [];
    [['Эрэгтэй', s.male], ['Эмэгтэй', s.female], ['Тодорхойгүй', s.gender_unknown]]
      .forEach(([k, v]) => pRows.push(['Хүйс', k, v, share(v, gT)]));
    d.meta.ageBands.forEach(([, label], i) => pRows.push(['Насны бүлэг', label, s.age[i], share(s.age[i], aT)]));
    d.meta.hBands.forEach(([, label], i) => pRows.push(['Өндөр', label, s.hgt[i], share(s.hgt[i], hT)]));
    headerRow(ws, r, pCols);
    const pFirst = r + 1;
    bodyRows(ws, pFirst, pCols, pRows);
    ws.addConditionalFormatting({
      ref: `C${pFirst}:C${pFirst + pRows.length - 1}`,
      rules: [{ type: 'dataBar', cfvo: [{ type: 'min' }, { type: 'max' }], color: { argb: BAR } }],
    });
    r = pFirst + pRows.length;
    if (s.people) {
      ws.getCell(r, 2).value = 'Дундаж өндөр';
      ws.getCell(r, 2).font = { size: 10.5, bold: true, color: { argb: NAVY } };
      ws.getCell(r, 3).value = Math.round(s.hsum / s.people);
      ws.getCell(r, 3).numFmt = NF.cm;
      ws.getCell(r, 3).alignment = { horizontal: 'right' };
      ws.getCell(r, 3).font = { size: 10.5, bold: true, color: { argb: NAVY } };
    }
    ws.views = [{ state: 'frozen', ySplit: 5 }];
  }

  // ---------- 2. Төхөөрөмж ----------
  {
    const ws = wb.addWorksheet('Төхөөрөмж');
    const r = titleBlock(ws, 8, 'Төхөөрөмжөөр', ctx);
    const cols = [
      { h: 'Төхөөрөмж', w: 24 }, { h: 'SN', w: 22 }, { h: 'Байршил', w: 20 }, { h: 'Төлөв', w: 11 },
      { h: 'Орсон', w: 12, t: 'int' }, { h: 'Гарсан', w: 12, t: 'int' },
      { h: 'Өнгөрсөн', w: 12, t: 'int' }, { h: 'Буцсан', w: 12, t: 'int' },
    ];
    table(ws, r, cols, (d.byDevice || []).map((x) => [
      x.name || '(нэргүй)', x.sn, x.location_name || '—', x.online ? 'Online' : 'Offline',
      num(x.in_count) || 0, num(x.out_count) || 0, num(x.passby) || 0, num(x.turnback) || 0,
    ]), { bar: 5 });
  }

  // ---------- 3. Байршил ----------
  {
    const ws = wb.addWorksheet('Байршил');
    const r = titleBlock(ws, 7, 'Байршлаар', ctx);
    const cols = [
      { h: 'Байршил', w: 26 }, { h: 'Төхөөрөмж', w: 13, t: 'int' }, { h: 'Online', w: 11, t: 'int' },
      { h: 'Орсон', w: 12, t: 'int' }, { h: 'Гарсан', w: 12, t: 'int' },
      { h: 'Өнгөрсөн', w: 12, t: 'int' }, { h: 'Буцсан', w: 12, t: 'int' },
    ];
    table(ws, r, cols, (d.byLocation || []).map((x) => [
      x.location_name || '—', num(x.device_count) || 0, num(x.online_count) || 0,
      num(x.in_count) || 0, num(x.out_count) || 0, num(x.passby) || 0, num(x.turnback) || 0,
    ]), { bar: 4 });
  }

  // ---------- 4. Өдрийн цуваа ----------
  {
    const ws = wb.addWorksheet('Өдрөөр');
    const r = titleBlock(ws, 6, 'Өдөр бүрийн урсгал', ctx);
    const cols = [
      { h: 'Огноо', w: 14, t: 'date' }, { h: 'Орсон', w: 12, t: 'int' }, { h: 'Гарсан', w: 12, t: 'int' },
      { h: 'Өнгөрсөн', w: 12, t: 'int' }, { h: 'Буцсан', w: 12, t: 'int' },
      { h: 'Бүсэд байсан', w: 15, t: 'sec' },
    ];
    table(ws, r, cols, (d.series || []).map((x) => [
      dateSerial(x.bucket), num(x.in_count) || 0, num(x.out_count) || 0,
      num(x.passby) || 0, num(x.turnback) || 0, num(x.avg_stay_ms) ? num(x.avg_stay_ms) / 1000 : null,
    ]), { bar: 2 });
  }

  // ---------- 5. Өдөр × цаг (матриц) ----------
  if ((d.heat || []).length) {
    const ws = wb.addWorksheet('Өдөр × цаг');
    const r = titleBlock(ws, 25, 'Долоо хоногийн өдөр × цагийн нягтрал — орсон хүн', ctx);
    const grid = {};
    let max = 0;
    for (const x of d.heat) {
      grid[`${x.dow}:${x.hour}`] = num(x.in_count) || 0;
      if (grid[`${x.dow}:${x.hour}`] > max) max = grid[`${x.dow}:${x.hour}`];
    }
    const head = ws.getRow(r);
    head.getCell(1).value = 'Гараг';
    for (let h = 0; h < 24; h++) head.getCell(h + 2).value = `${String(h).padStart(2, '0')}:00`;
    head.eachCell((cell, i) => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
      cell.alignment = { horizontal: i === 1 ? 'left' : 'center' };
    });
    head.height = 22;
    ws.getColumn(1).width = 12;
    for (let h = 0; h < 24; h++) ws.getColumn(h + 2).width = 7;
    for (let dw = 1; dw <= 7; dw++) {
      const row = ws.getRow(r + dw);
      row.getCell(1).value = DOW[dw - 1];
      row.getCell(1).font = { bold: true, size: 10.5, color: { argb: NAVY } };
      for (let h = 0; h < 24; h++) {
        const cell = row.getCell(h + 2);
        cell.value = grid[`${dw}:${h}`] || 0;
        cell.numFmt = NF.int;
        cell.alignment = { horizontal: 'center' };
        cell.font = { size: 10 };
        cell.border = { top: thin(), bottom: thin(), left: thin(), right: thin() };
      }
      row.height = 18;
    }
    ws.addConditionalFormatting({
      ref: `B${r + 1}:Y${r + 7}`,
      rules: [{
        type: 'colorScale',
        cfvo: [{ type: 'min' }, { type: 'percentile', value: 50 }, { type: 'max' }],
        color: [{ argb: 'FFFFFFFF' }, { argb: 'FFDBEAFE' }, { argb: 'FF60A5FA' }],
      }],
    });
    ws.getCell(r + 9, 1).value = `Хамгийн ачаалалтай цагт ${max.toLocaleString('en-US')} хүн орсон.`;
    ws.getCell(r + 9, 1).font = { size: 10, color: { argb: MUTED }, italic: true };
    ws.views = [{ state: 'frozen', xSplit: 1, ySplit: r }];
  }

  // ---------- 6. Давхардалгүй (DUP) ----------
  const ag = d.dedup && d.dedup.aggregate;
  if (ag && (d.dedup.reports || []).length) {
    const ws = wb.addWorksheet('Давхардалгүй');
    let r = titleBlock(ws, 4, 'Давхардалгүй зочин — төхөөрөмжийн DUP тайлан', [
      ...ctx,
      'Энэ тоо түүхий тоололтой давхцахгүй — давхардлыг төхөөрөмж өөрөө хасч илгээнэ.',
    ]);
    const cols = [{ h: 'Үзүүлэлт', w: 30 }, { h: 'Тоо', w: 14, t: 'int' }, { h: 'Хувь', w: 12, t: 'pct' }, { h: 'Тайлбар', w: 46 }];
    const rows = [
      ['Түүхий тоолол', ag.raw, share(ag.raw, ag.raw), 'Давхардал арилгахаас өмнөх тоо'],
      ['Давхардал', ag.duplicate, share(ag.duplicate, ag.raw), 'Дахин тоологдсон гэж тогтоосон'],
      ['Давхардалгүй', ag.deduped, share(ag.deduped, ag.raw), 'Түүхий тооллоос үлдсэн. Доорх хувь үүнээс.'],
      ['Зочин', ag.customer, share(ag.customer, ag.deduped), 'person_type = 0'],
      ['Зочин бус', ag.non_customer, share(ag.non_customer, ag.deduped), 'Ажилтан, rider, courier'],
      ['Ажилтан', ag.staff, share(ag.staff, ag.deduped), ''],
      ['Rider', ag.rider, share(ag.rider, ag.deduped), ''],
      ['Courier', ag.courier, share(ag.courier, ag.deduped), ''],
      ['Насанд хүрэгч', ag.adult, share(ag.adult, ag.deduped), 'Өндрийн ангиллаар'],
      ['Хүүхэд', ag.child, share(ag.child, ag.deduped), 'Өндрийн ангиллаар'],
      ['Өндөр тодорхойгүй', ag.unknown_h, share(ag.unknown_h, ag.deduped), ''],
    ];
    headerRow(ws, r, cols);
    r = bodyRows(ws, r + 1, cols, rows) + 1;

    const agT = Object.values(ag.age_gender || {}).reduce((a, v) => a + (v.male || 0) + (v.female || 0) + (v.unknown || 0), 0);
    if (agT) {
      ws.getCell(r, 1).value = 'Нас × хүйс';
      ws.getCell(r, 1).font = { size: 13, bold: true, color: { argb: NAVY } };
      r += 1;
      const gCols = [
        { h: 'Насны бүлэг', w: 20 }, { h: 'Эрэгтэй', w: 12, t: 'int' }, { h: 'Эмэгтэй', w: 12, t: 'int' },
        { h: 'Тодорхойгүй', w: 14, t: 'int' }, { h: 'Бүгд', w: 12, t: 'int' }, { h: 'Хувь', w: 11, t: 'pct' },
      ];
      const gRows = [];
      for (const [key, label] of d.meta.dupAgeBands) {
        const v = (ag.age_gender || {})[key];
        if (!v) continue;
        const n = (v.male || 0) + (v.female || 0) + (v.unknown || 0);
        gRows.push([label, v.male || 0, v.female || 0, v.unknown || 0, n, share(n, agT)]);
      }
      headerRow(ws, r, gCols);
      r = bodyRows(ws, r + 1, gCols, gRows) + 1;
    }

    ws.getCell(r, 1).value = 'Өдрийн тайлангууд';
    ws.getCell(r, 1).font = { size: 13, bold: true, color: { argb: NAVY } };
    r += 1;
    const rCols = [
      { h: 'Огноо', w: 13, t: 'date' }, { h: 'Master SN', w: 22 }, { h: 'Чиглэл', w: 10 },
      { h: 'Түүхий', w: 12, t: 'int' }, { h: 'Давхардал', w: 12, t: 'int' }, { h: 'Давхардалгүй', w: 14, t: 'int' },
      { h: 'Зочин', w: 12, t: 'int' }, { h: 'Зочин бус', w: 12, t: 'int' }, { h: 'Эцсийн', w: 10 },
    ];
    headerRow(ws, r, rCols);
    bodyRows(ws, r + 1, rCols, d.dedup.reports.map((x) => [
      dateSerial(x.report_date instanceof Date ? x.report_date.toISOString() : x.report_date),
      x.master_sn, x.direction, num(x.raw_count) || 0, num(x.duplicate_count) || 0,
      num(x.deduped_count) || 0, num(x.customer_count) || 0, num(x.non_customer_count) || 0,
      x.is_final ? 'Тийм' : 'Үгүй',
    ]));
    ws.views = [{ state: 'frozen', ySplit: 5 }];
  }

  // ---------- 7. 30 минутын дэлгэрэнгүй ----------
  {
    const ws = wb.addWorksheet('30 минут');
    const r = titleBlock(ws, 12, '30 минутын нэгтгэл', [
      ...ctx,
      `Нийт ${(d.rows || []).length.toLocaleString('en-US')} мөр. Гарчиг дээрх сумаар шүүж, эрэмбэлж болно.`,
      d.meta.rowCap ? `Анхаар: хамгийн сүүлийн ${d.meta.rowCap.toLocaleString('en-US')} мөрөөр хязгаарласан — илүү урт хугацааг хэсэгчлэн татна уу.` : null,
    ]);
    const cols = [
      { h: 'Эхлэх үе', w: 17, t: 'dt' }, { h: 'Төхөөрөмж', w: 20 }, { h: 'SN', w: 21 }, { h: 'Байршил', w: 18 },
      { h: 'Орсон', w: 10, t: 'int' }, { h: 'Гарсан', w: 10, t: 'int' }, { h: 'Буцсан', w: 10, t: 'int' }, { h: 'Өнгөрсөн', w: 11, t: 'int' },
      { h: 'Бүсэд байсан', w: 14, t: 'sec' }, { h: 'Эр', w: 9, t: 'int' }, { h: 'Эм', w: 9, t: 'int' }, { h: 'Хүйс тодорхойгүй', w: 15, t: 'int' },
      ...d.meta.ageBands.map(([, l]) => ({ h: 'Нас ' + l, w: 12, t: 'int' })),
      ...d.meta.hBands.map(([, l]) => ({ h: l, w: 13, t: 'int' })),
      { h: 'Дундаж өндөр', w: 14, t: 'cm' }, { h: 'Ажилтан', w: 11, t: 'int' },
    ];
    table(ws, r, cols, (d.rows || []).map((x) => [
      bucketSerial(x.bucket), x.device_name || '(нэргүй)', x.sn, x.location_name || '—',
      num(x.in_count) || 0, num(x.out_count) || 0, num(x.turnback) || 0, num(x.passby) || 0,
      num(x.avg_stay_ms) ? num(x.avg_stay_ms) / 1000 : null,
      num(x.male) || 0, num(x.female) || 0, num(x.gender_unknown) || 0,
      ...d.meta.ageBands.map(([k]) => num(x['age_' + k]) || 0),
      ...d.meta.hBands.map(([k]) => num(x['h_' + k]) || 0),
      num(x.avg_height_cm), num(x.staff) || 0,
    ]), { bar: 5 });
  }

  return wb;
}

module.exports = { buildWorkbook };
