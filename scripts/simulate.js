// HX-CCD21 төхөөрөмжийн симулятор — протокол V2.5-ын дагуу heartbeat/dataUpload/reid/dup илгээнэ
// Хэрэглээ:  node scripts/simulate.js [serverUrl] [days] [devicesCsv]
//   node scripts/simulate.js http://localhost:3000 14 201000002501090095,201000002501090096
const BASE = process.argv[2] || process.env.SIM_URL || 'http://localhost:3000';
const DAYS = Number(process.argv[3] || 14);
const SNS = (process.argv[4] || '201000002501090095,201000002501090096,211000002507150614').split(',');

const AGE_BANDS = [[0, 9], [10, 16], [17, 30], [31, 45], [46, 60], [61, 99]];
const AGE_W = [0.04, 0.06, 0.34, 0.30, 0.18, 0.08];
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (w) => { let r = Math.random(); for (let i = 0; i < w.length; i++) { r -= w[i]; if (r <= 0) return i; } return w.length - 1; };

async function post(path, body) {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (j.code !== 0) console.warn('⚠', path, j);
  return j;
}

// Цагийн хүчин зүйл (дэлгүүр 09-21 нээлттэй, 12-14 ба 17-19 оргил)
function hourFactor(h) {
  if (h < 9 || h >= 21) return 0;
  const peaks = [[13, 2.2], [18, 2.0]];
  let f = 0.6;
  for (const [c, s] of peaks) f += Math.exp(-((h + 0.5 - c) ** 2) / s);
  return f;
}

function deviceInfo(sn, i) {
  return {
    macAddress: '4C:BC:98:66:00:' + (0x5e + i).toString(16).toUpperCase(),
    ipAddress: '10.10.2.' + (150 + i), connectionType: i % 2 ? 'Wifi' : 'Wired',
    wifiSSID: i % 2 ? 'store-wifi' : '', ipAddressMethod: 'DHCP', hostName: 'CAM-' + i, timeZone: 8,
    hwPlatform: 'V5.0', swRelease: 'V7.2.3.9-V5-21-RT', sn,
  };
}

async function main() {
  console.log('Сервер:', BASE, '| хоног:', DAYS, '| SN:', SNS.join(', '));
  const now = new Date();
  const startDay = new Date(now); startDay.setDate(now.getDate() - DAYS + 1); startDay.setHours(0, 0, 0, 0);

  for (let i = 0; i < SNS.length; i++) {
    const sn = SNS[i];
    const info = deviceInfo(sn, i);
    const baseRate = rnd(25, 70); // цагт орох дундаж
    await post('/api/camera/heartBeat', { ...info, timestamp: Math.floor(Date.now() / 1000) });

    for (let d = 0; d < DAYS; d++) {
      const day = new Date(startDay); day.setDate(startDay.getDate() + d);
      const weekend = day.getDay() === 0 || day.getDay() === 6;
      const dayStr = day.toISOString().slice(0, 10);
      let dayIn = 0;
      const reidRecords = [];
      let gid = 1000;

      for (let h = 0; h < 24; h++) {
        for (let m = 0; m < 60; m += 5) {
          const t = new Date(day); t.setHours(h, m, 0, 0);
          if (t > now) break;
          const f = hourFactor(h) * (weekend ? 1.35 : 1);
          if (f === 0) continue;
          const inN = Math.max(0, Math.round((baseRate * f / 12) * rnd(0.6, 1.4)));
          const outN = Math.max(0, Math.round(inN * rnd(0.8, 1.15)));
          const passby = Math.round(inN * rnd(0.3, 0.9));
          const turnback = Math.random() < 0.3 ? 1 : 0;
          dayIn += inN;
          const attributes = [];
          for (let k = 0; k < inN; k++) {
            const band = AGE_BANDS[pick(AGE_W)];
            const staff = Math.random() < 0.05 ? 1 : 0;
            attributes.push({
              idIndex: gid, personId: gid, timeStamp: t.getTime() + Math.floor(rnd(0, 300000)), eventType: 0,
              stayTime: Math.floor(rnd(600, 6000)), lineId: 0, height: Math.floor(band[0] < 10 ? rnd(95, 135) : rnd(150, 185)),
              gender: Math.random() < 0.52 ? 2 : 1, age: band, workcard: staff, wheelchair: Math.random() < 0.01 ? 1 : 0,
            });
            if (!staff && Math.random() < 0.85) {
              const enterTs = t.getTime() + Math.floor(rnd(0, 300000));
              const dwell = Math.floor(rnd(120000, 2700000));
              reidRecords.push({
                global_id: gid,
                pairs: [{ enter: { camera_sn: sn, person_id: gid, timestamp_ms: enterTs, image_path: `${sn}_${gid}.jpg` },
                  leave: { camera_sn: sn, person_id: gid, timestamp_ms: enterTs + dwell, image_path: `${sn}_${gid}.jpg` }, dwell_time_ms: dwell }],
                extra_info: { age_range_min: band[0], age_range_max: band[1], gender: attributes[attributes.length - 1].gender,
                  person_type: 0, height_category: band[0] < 10 ? 2 : 1 },
              });
            }
            gid++;
          }
          const ts = Math.floor(t.getTime() / 1000);
          await post('/api/camera/dataUpload', {
            ...info, time: ts + 300, startTime: ts, endTime: ts + 300, in: inN, out: outN, passby, turnback,
            avgStayTime: Math.floor(rnd(1200, 4000)), len: attributes.length, attributes,
          });
        }
      }
      // Ажлын цаг дууссаны дараа: REID + DUP (final)
      if (day < now && day.toDateString() !== now.toDateString()) {
        // Зарим хүн давтан ирсэн байдлаар давхардал үүсгэнэ
        const dupCount = Math.round(reidRecords.length * rnd(0.15, 0.3));
        const deduped = reidRecords.slice(0, reidRecords.length - dupCount);
        for (let k = 0; k < dupCount && k < deduped.length; k++) {
          const src = reidRecords[reidRecords.length - 1 - k];
          deduped[k].pairs.push(src.pairs[0]);
        }
        await post('/api/camera/reid', { date: dayStr, direction: 'in', master_sn: sn, device_sns: [sn], reid_records: deduped });

        const ag = {}; const hc = { adult: 0, child: 0, unknown: 0 };
        for (const r of deduped) {
          const key = r.extra_info.age_range_min >= 61 ? '61_plus' : `${r.extra_info.age_range_min}_${r.extra_info.age_range_max}`;
          ag[key] = ag[key] || { male: 0, female: 0, unknown: 0 };
          ag[key][r.extra_info.gender === 1 ? 'male' : 'female']++;
          hc[r.extra_info.height_category === 2 ? 'child' : 'adult']++;
        }
        const staff = Math.round(dayIn * 0.05), rider = Math.round(dayIn * 0.02), courier = Math.round(dayIn * 0.01);
        await post('/api/camera/dup', {
          date: dayStr, direction: 'in', master_sn: sn, device_sns: [sn],
          dedup_summary: { raw: dayIn, duplicate: dayIn - deduped.length - staff - rider - courier, deduped: deduped.length + staff + rider + courier },
          deduped_stats: { customer: { count: deduped.length, height_category: hc, age_gender: ag },
            non_customer: { count: staff + rider + courier, categories: { staff, rider, courier } } },
          records: deduped.slice(0, 20).map((r) => ({ global_id: r.global_id, events: r.pairs.map((p) => p.enter), extra_info: r.extra_info })),
        });
      }
      process.stdout.write(`  ${sn} ${dayStr} орсон=${dayIn}\n`);
    }
    // Residence push (одоо байгаа хүн)
    await post('/api/camera/dataUpload', { sn, time: Math.floor(Date.now() / 1000), currentStay: Math.floor(rnd(3, 25)),
      info: [{ id: 1, height: 170, status: 1, staytime: 2000 }, { id: 2, height: 165, status: 1, staytime: 3000 }] });
  }
  console.log('Дууслаа.');
}
main().catch((e) => { console.error(e); process.exit(1); });
