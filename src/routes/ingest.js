// Төхөөрөмжөөс ирэх HTTP POST хүсэлтүүд (HX-CCD21 Data Protocol V2.5)
const express = require('express');
const db = require('../lib/db');
const { query } = db;

const router = express.Router();

// Unix timestamp: секунд (10 орон) эсвэл миллисекунд (13 орон) → Date
function toDate(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return new Date(n > 1e12 ? n : n * 1000);
}
const nowSec = () => Math.floor(Date.now() / 1000);

function safeJson(body) {
  const s = JSON.stringify(body);
  return s.length > 200000 ? JSON.stringify({ truncated: true, length: s.length, head: s.slice(0, 2000) }) : s;
}

async function log(path, sn, status, message, body) {
  try {
    await query('INSERT INTO ingest_log(path, sn, status, message, body) VALUES($1,$2,$3,$4,$5)', [
      path, sn || null, status, message || null, body ? safeJson(body) : null,
    ]);
  } catch (e) { console.error('ingest_log', e.message); }
}

// Танигдаагүй SN → автоматаар бүртгэнэ (tenant/байршилгүй, админ дараа нь оноож өгнө)
async function ensureDevice(sn, body = {}) {
  const r = await query(
    `INSERT INTO devices (sn, mac_address, ip_address, connection_type, host_name, wifi_ssid, ip_method, hw_platform, sw_release, timezone_offset)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10,8))
     ON CONFLICT (sn) DO UPDATE SET
       mac_address     = COALESCE(EXCLUDED.mac_address, devices.mac_address),
       ip_address      = COALESCE(EXCLUDED.ip_address, devices.ip_address),
       connection_type = COALESCE(EXCLUDED.connection_type, devices.connection_type),
       host_name       = COALESCE(EXCLUDED.host_name, devices.host_name),
       wifi_ssid       = COALESCE(EXCLUDED.wifi_ssid, devices.wifi_ssid),
       ip_method       = COALESCE(EXCLUDED.ip_method, devices.ip_method),
       hw_platform     = COALESCE(EXCLUDED.hw_platform, devices.hw_platform),
       sw_release      = COALESCE(EXCLUDED.sw_release, devices.sw_release)
     RETURNING *`,
    [sn, body.macAddress || null, body.ipAddress || null, body.connectionType || null, body.hostName || null,
      body.wifiSSID || null, body.ipAddressMethod || null, body.hwPlatform || null, body.swRelease || null,
      body.timeZone != null ? Number(body.timeZone) : null]
  );
  return r.rows[0];
}

// REID/DUP тайлан олон SN нэгтгэдэг — өөр өөр байгууллагын SN холилдсон тайланг хүлээж авахгүй (өгөгдөл хольдохоос сэргийлнэ)
async function crossTenant(sns) {
  const r = await query('SELECT DISTINCT tenant_id FROM devices WHERE sn = ANY($1) AND tenant_id IS NOT NULL', [[...new Set(sns.filter(Boolean))]]);
  if (r.rowCount > 1) return `device_sns өөр өөр байгууллагын SN агуулж байна (tenant ${r.rows.map((x) => x.tenant_id).join(', ')})`;
  return null;
}

// ---------- 1. Heartbeat ----------
async function heartBeat(req, res) {
  const b = req.body || {};
  const sn = b.sn;
  if (!sn) { await log(req.path, null, 1, 'sn байхгүй', b); return res.json({ code: 1, msg: 'sn does not exist' }); }
  try {
    const dev = await ensureDevice(sn, b);
    const ts = toDate(b.timestamp) || new Date();
    await query('UPDATE devices SET last_heartbeat=now() WHERE sn=$1', [sn]); // серверийн цагаар (төхөөрөмжийн цаг зөрж болно)
    await query('INSERT INTO heartbeats(sn, ts, payload) VALUES($1,$2,$3)', [sn, ts, JSON.stringify(b)]);

    const data = {
      sn,
      time: nowSec(),
      timezone: dev.timezone_offset,
      uploadInterval: dev.upload_interval,
      dataMode: dev.data_mode,
    };
    // Түүхэн өгөгдөл дахин татах хүсэлт байвал нэг удаа явуулаад цэвэрлэнэ
    if (dev.resync_start && dev.resync_end) {
      data.dataStartTime = Math.floor(new Date(dev.resync_start).getTime() / 1000);
      data.dataEndTime = Math.floor(new Date(dev.resync_end).getTime() / 1000);
      await query('UPDATE devices SET resync_start=NULL, resync_end=NULL WHERE sn=$1', [sn]);
    }
    res.json({ code: 0, msg: 'success', data });
  } catch (e) {
    console.error('heartBeat', e);
    await log(req.path, sn, 2, e.message, b);
    res.json({ code: 2, msg: 'server error' });
  }
}

// ---------- 2. Data upload (хүний урсгал + residence) ----------
async function dataUpload(req, res) {
  const b = req.body || {};
  const sn = b.sn;
  if (!sn) { await log(req.path, null, 1, 'sn байхгүй', b); return res.json({ code: 1, msg: 'sn does not exist' }); }
  const client = await db.pool.connect();
  try {
    await ensureDevice(sn, b);
    await client.query('BEGIN');

    const isResidence = b.currentStay !== undefined || Array.isArray(b.info);
    const isFlow = b.in !== undefined || b.out !== undefined || b.startTime !== undefined;

    if (isResidence) {
      const ts = toDate(b.time) || new Date();
      await client.query(
        'INSERT INTO occupancy_snapshots(sn, ts, current_stay, info) VALUES($1,$2,$3,$4)',
        [sn, ts, Number(b.currentStay) || 0, JSON.stringify(b.info || [])]
      );
    }

    if (isFlow) {
      const ts = toDate(b.time) || new Date();
      const start = toDate(b.startTime) || ts;
      const end = toDate(b.endTime) || ts;
      await client.query(
        `INSERT INTO flow_records(sn, ts, start_time, end_time, in_count, out_count, passby, turnback, avg_stay_ms, data_mode)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (sn, start_time, end_time, ts) DO UPDATE SET
           in_count=EXCLUDED.in_count, out_count=EXCLUDED.out_count, passby=EXCLUDED.passby,
           turnback=EXCLUDED.turnback, avg_stay_ms=EXCLUDED.avg_stay_ms`,
        [sn, ts, start, end, Number(b.in) || 0, Number(b.out) || 0, Number(b.passby) || 0,
          Number(b.turnback) || 0, Number(b.avgStayTime) || 0, b.dataMode === 'Total' ? 'Total' : 'Add']
      );

      const attrs = Array.isArray(b.attributes) ? b.attributes : [];
      for (const a of attrs) {
        const age = Array.isArray(a.age) ? a.age : [null, null];
        const ageMin = age[0] === 255 ? null : age[0];
        const ageMax = age[1] === 255 ? null : age[1];
        await client.query(
          `INSERT INTO person_events(sn, id_index, person_id, ts, event_type, stay_time_ms, height_cm, gender, age_min, age_max, workcard, wheelchair)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           ON CONFLICT (sn, id_index, ts, event_type) DO NOTHING`,
          [sn, a.idIndex ?? null, a.personId ?? null, toDate(a.timeStamp) || ts, Number(a.eventType) || 0,
            a.stayTime ?? null, a.height ?? null, a.gender ?? null, ageMin, ageMax, a.workcard ?? 0, a.wheelchair ?? 0]
        );
      }
    }

    await client.query('UPDATE devices SET last_data_at=now() WHERE sn=$1', [sn]);
    await client.query('COMMIT');
    res.json({ code: 0, msg: 'Report submitted successfully', data: { sn, time: nowSec() } });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('dataUpload', e);
    await log(req.path, sn, 2, e.message, b);
    res.json({ code: 2, msg: 'server error' });
  } finally {
    client.release();
  }
}

// ---------- 3. REID (өдрийн давхардалгүй хүн бүрийн бичлэг) ----------
async function reid(req, res) {
  const b = req.body || {};
  const sn = b.master_sn;
  if (!sn || !b.date) { await log(req.path, sn, 1, 'master_sn/date байхгүй', b); return res.json({ code: 1, msg: 'sn does not exist' }); }
  const client = await db.pool.connect();
  try {
    await ensureDevice(sn);
    for (const s of b.device_sns || []) if (s !== sn) await ensureDevice(s);
    const mix = await crossTenant([sn, ...(b.device_sns || [])]);
    if (mix) { await log(req.path, sn, 1, mix, b); return res.json({ code: 1, msg: 'device_sns belong to different tenants' }); }
    await client.query('BEGIN');
    const records = Array.isArray(b.reid_records) ? b.reid_records : [];
    const rep = await client.query(
      `INSERT INTO reid_reports(master_sn, report_date, direction, device_sns, unique_count, payload)
       VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT (master_sn, report_date, direction) DO UPDATE SET
         device_sns=EXCLUDED.device_sns, unique_count=EXCLUDED.unique_count, payload=EXCLUDED.payload, received_at=now()
       RETURNING id`,
      [sn, b.date, b.direction || 'in', b.device_sns || [sn], records.length, JSON.stringify(b)]
    );
    const reportId = rep.rows[0].id;
    await client.query('DELETE FROM reid_persons WHERE report_id=$1', [reportId]);
    for (const r of records) {
      const pairs = Array.isArray(r.pairs) ? r.pairs : [];
      const dwell = pairs.reduce((s, p) => s + (Number(p.dwell_time_ms) || 0), 0);
      const enters = pairs.map((p) => toDate(p.enter && p.enter.timestamp_ms)).filter(Boolean);
      const leaves = pairs.map((p) => toDate(p.leave && p.leave.timestamp_ms)).filter(Boolean);
      const x = r.extra_info || {};
      await client.query(
        `INSERT INTO reid_persons(report_id, master_sn, report_date, global_id, visit_count, total_dwell_ms, first_enter, last_leave,
           gender, age_min, age_max, person_type, height_category, pairs)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [reportId, sn, b.date, r.global_id ?? 0, pairs.length, dwell,
          enters.length ? new Date(Math.min(...enters)) : null, leaves.length ? new Date(Math.max(...leaves)) : null,
          x.gender ?? null, x.age_range_min ?? null, x.age_range_max ?? null, x.person_type ?? null, x.height_category ?? null,
          JSON.stringify(pairs)]
      );
    }
    await client.query('COMMIT');
    res.json({ code: 0, msg: 'Report submitted successfully' });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('reid', e);
    await log(req.path, sn, 2, e.message, b);
    res.json({ code: 2, msg: 'server error' });
  } finally {
    client.release();
  }
}

// ---------- 4. DUP (давхардал арилгасан статистик — realtime & final) ----------
async function dup(req, res) {
  const b = req.body || {};
  const sn = b.master_sn;
  if (!sn || !b.date) { await log(req.path, sn, 1, 'master_sn/date байхгүй', b); return res.json({ code: 1, msg: 'sn does not exist' }); }
  try {
    await ensureDevice(sn);
    for (const s of b.device_sns || []) if (s !== sn) await ensureDevice(s);
    const mix = await crossTenant([sn, ...(b.device_sns || [])]);
    if (mix) { await log(req.path, sn, 1, mix, b); return res.json({ code: 1, msg: 'device_sns belong to different tenants' }); }
    const sum = b.dedup_summary || {};
    const stats = b.deduped_stats || {};
    const isFinal = Array.isArray(b.records);
    await query(
      `INSERT INTO dedup_reports(master_sn, report_date, direction, device_sns, raw_count, duplicate_count, deduped_count,
         customer_count, non_customer_count, stats, records, is_final)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (master_sn, report_date, direction) DO UPDATE SET
         device_sns=EXCLUDED.device_sns, raw_count=EXCLUDED.raw_count, duplicate_count=EXCLUDED.duplicate_count,
         deduped_count=EXCLUDED.deduped_count, customer_count=EXCLUDED.customer_count, non_customer_count=EXCLUDED.non_customer_count,
         stats=EXCLUDED.stats, records=COALESCE(EXCLUDED.records, dedup_reports.records),
         is_final=(dedup_reports.is_final OR EXCLUDED.is_final), received_at=now()`,
      [sn, b.date, b.direction || 'in', b.device_sns || [sn], sum.raw || 0, sum.duplicate || 0, sum.deduped || 0,
        (stats.customer && stats.customer.count) || 0, (stats.non_customer && stats.non_customer.count) || 0,
        JSON.stringify(stats), isFinal ? JSON.stringify(b.records) : null, isFinal]
    );
    res.json({ code: 0, msg: 'Report submitted successfully' });
  } catch (e) {
    console.error('dup', e);
    await log(req.path, sn, 2, e.message, b);
    res.json({ code: 2, msg: 'server error' });
  }
}

// Төхөөрөмжийн тохиргоонд ямар зам бичсэн ч ажиллахаар олон замыг зөвшөөрнө
router.post(['/api/camera/heartBeat', '/api/camera/heartbeat', '/heartBeat', '/heartbeat'], heartBeat);
router.post(['/api/camera/dataUpload', '/api/camera/dataupload', '/dataUpload', '/dataupload'], dataUpload);
router.post(['/api/camera/reid', '/reid'], reid);
router.post(['/api/camera/dup', '/dup'], dup);

module.exports = router;
