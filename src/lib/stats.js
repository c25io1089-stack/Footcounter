// Dashboard болон гадаад API-д хамтдаа ашиглагдах статистик асуулгууд
const { query, APP_TZ } = require('./db');

const ONLINE_WINDOW_MIN = 3; // heartbeat минут тутам → 3 минут ирэхгүй бол offline
const DEFAULT_TZ = APP_TZ;

// Хамрах хүрээний нөхцөл: tenant / байршил / SN
function scope(f, p) {
  const where = [];
  if (f.tenantId) { p.push(f.tenantId); where.push(`d.tenant_id = $${p.length}`); }
  if (f.locationId) { p.push(f.locationId); where.push(`d.location_id = $${p.length}`); }
  if (f.sn) { p.push(f.sn); where.push(`d.sn = $${p.length}`); }
  return where.length ? ' AND ' + where.join(' AND ') : '';
}

// Query string-д '+08:00' offset-ийг encode хийлгүй өгвөл '+' → ' ' болж ирдэг ("…T00:00:00 08:00") — буцааж засна
function normTs(v) {
  if (typeof v !== 'string') return v;
  return v.trim().replace(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?) (\d{2}:?\d{2})$/, '$1+$2');
}

function range(f, p, col = 'ts') {
  const w = [];
  if (f.from) { p.push(normTs(f.from)); w.push(`${col} >= $${p.length}`); }
  if (f.to) { p.push(normTs(f.to)); w.push(`${col} < $${p.length}`); }
  return w.length ? ' AND ' + w.join(' AND ') : '';
}

const GRAN = { minute: 'minute', hour: 'hour', day: 'day', week: 'week', month: 'month' };

async function listLocations(tenantId) {
  const p = [];
  const w = tenantId ? (p.push(tenantId), `WHERE l.tenant_id=$1`) : '';
  const r = await query(
    `SELECT l.*, t.name AS tenant_name,
       (SELECT count(*) FROM devices d WHERE d.location_id=l.id) AS device_count,
       (SELECT count(*) FROM devices d WHERE d.location_id=l.id AND d.last_heartbeat > now() - interval '${ONLINE_WINDOW_MIN} minutes') AS online_count
     FROM locations l JOIN tenants t ON t.id=l.tenant_id ${w} ORDER BY t.name, l.name`, p);
  return r.rows;
}

async function listDevices(f) {
  const p = [];
  const r = await query(
    `SELECT d.*, l.name AS location_name, t.name AS tenant_name,
       (d.last_heartbeat > now() - interval '${ONLINE_WINDOW_MIN} minutes') AS online
     FROM devices d LEFT JOIN locations l ON l.id=d.location_id LEFT JOIN tenants t ON t.id=d.tenant_id
     WHERE 1=1 ${scope(f, p)} ORDER BY t.name NULLS LAST, l.name NULLS LAST, d.name, d.sn`, p);
  return r.rows;
}

// Урсгалын цаг хугацааны цуваа
async function flowSeries(f) {
  const g = GRAN[f.granularity] || 'hour';
  const tz = f.tz || DEFAULT_TZ;
  const p = [tz];
  const r = await query(
    `SELECT date_trunc('${g}', fr.ts AT TIME ZONE $1) AS bucket,
       sum(fr.in_count)::int AS in_count, sum(fr.out_count)::int AS out_count,
       sum(fr.passby)::int AS passby, sum(fr.turnback)::int AS turnback,
       CASE WHEN sum(fr.in_count)>0 THEN (sum(fr.avg_stay_ms*fr.in_count)/sum(fr.in_count))::int ELSE 0 END AS avg_stay_ms
     FROM flow_records fr JOIN devices d ON d.sn=fr.sn
     WHERE fr.data_mode='Add' ${scope(f, p)} ${range(f, p, 'fr.ts')}
     GROUP BY 1 ORDER BY 1`, p);
  // bucket: 'YYYY-MM-DD HH:MM:SS' (tz-ийн орон нутгийн цаг) → 'YYYY-MM-DDTHH:MM:SS'
  return r.rows.map((x) => ({ ...x, bucket: String(x.bucket).replace(' ', 'T').slice(0, 19) }));
}

async function flowTotals(f) {
  const p = [];
  const r = await query(
    `SELECT coalesce(sum(fr.in_count),0)::int AS in_count, coalesce(sum(fr.out_count),0)::int AS out_count,
       coalesce(sum(fr.passby),0)::int AS passby, coalesce(sum(fr.turnback),0)::int AS turnback,
       CASE WHEN sum(fr.in_count)>0 THEN (sum(fr.avg_stay_ms*fr.in_count)/sum(fr.in_count))::int ELSE 0 END AS avg_stay_ms
     FROM flow_records fr JOIN devices d ON d.sn=fr.sn
     WHERE fr.data_mode='Add' ${scope(f, p)} ${range(f, p, 'fr.ts')}`, p);
  // «Байх» (Stay): төхөөрөмжийн Stay шиг — тоолох бүсэд STAY_THRESHOLD_MS-ээс удаан зогссон хүний тоо (гарах үйл явдлын stayTime)
  const p2 = [STAY_THRESHOLD_MS];
  const s = await query(
    `SELECT count(*)::int AS stay_count FROM person_events pe JOIN devices d ON d.sn=pe.sn
     WHERE pe.event_type=1 AND pe.stay_time_ms >= $1 ${scope(f, p2)} ${range(f, p2, 'pe.ts')}`, p2);
  // Дэлгүүрт байсан хугацаа (орсноос гарах хүртэл): 1) REID тайлангийн орох–гарах хос (нарийн, өдрийн эцэст ирдэг),
  // 2) байхгүй бол ижил хүний (sn, id_index) орох(0)→гарах(1) үйл явдлын цагийн зөрүү (12 цагаас бага, эерэг)
  const p3 = [];
  const reid = await query(
    `SELECT count(*)::int AS n, coalesce(avg(rp.total_dwell_ms),0)::bigint AS avg_ms
     FROM reid_persons rp JOIN devices d ON d.sn=rp.master_sn
     WHERE coalesce(rp.person_type,0)=0 AND rp.total_dwell_ms > 0 ${scope(f, p3)} ${dateRange(f, p3, 'rp.report_date')}`, p3);
  let dwell = { n: reid.rows[0].n, avg_ms: Number(reid.rows[0].avg_ms), source: 'reid' };
  if (!dwell.n) {
    const p4 = [];
    const ev = await query(
      `WITH e AS (
         SELECT pe.sn, pe.id_index, min(pe.ts) FILTER (WHERE pe.event_type=0) AS t_in, max(pe.ts) FILTER (WHERE pe.event_type=1) AS t_out
         FROM person_events pe JOIN devices d ON d.sn=pe.sn
         WHERE pe.id_index IS NOT NULL AND coalesce(pe.workcard,0)=0 ${scope(f, p4)} ${range(f, p4, 'pe.ts')}
         GROUP BY pe.sn, pe.id_index)
       SELECT count(*)::int AS n, coalesce(avg(extract(epoch FROM (t_out - t_in)) * 1000),0)::bigint AS avg_ms
       FROM e WHERE t_in IS NOT NULL AND t_out IS NOT NULL AND t_out > t_in AND t_out - t_in < interval '12 hours'`, p4);
    dwell = { n: ev.rows[0].n, avg_ms: Number(ev.rows[0].avg_ms), source: ev.rows[0].n ? 'events' : null };
  }
  return { ...r.rows[0], stay_count: s.rows[0].stay_count, stay_threshold_ms: STAY_THRESHOLD_MS,
    store_dwell_ms: dwell.avg_ms, store_dwell_n: dwell.n, store_dwell_source: dwell.source };
}
const STAY_THRESHOLD_MS = Number(process.env.STAY_THRESHOLD_MS || 5000);

// Байршил бүрээр нэгтгэл
async function flowByLocation(f) {
  const p = [];
  const r = await query(
    `SELECT l.id AS location_id, l.name AS location_name, t.name AS tenant_name,
       coalesce(sum(fr.in_count),0)::int AS in_count, coalesce(sum(fr.out_count),0)::int AS out_count,
       coalesce(sum(fr.passby),0)::int AS passby, coalesce(sum(fr.turnback),0)::int AS turnback,
       count(DISTINCT d.sn)::int AS device_count,
       count(DISTINCT d.sn) FILTER (WHERE d.last_heartbeat > now() - interval '${ONLINE_WINDOW_MIN} minutes')::int AS online_count
     FROM locations l JOIN tenants t ON t.id=l.tenant_id
     LEFT JOIN devices d ON d.location_id=l.id
     LEFT JOIN flow_records fr ON fr.sn=d.sn AND fr.data_mode='Add' ${range(f, p, 'fr.ts')}
     WHERE 1=1 ${f.tenantId ? (p.push(f.tenantId), `AND l.tenant_id=$${p.length}`) : ''}
       ${f.locationId ? (p.push(f.locationId), `AND l.id=$${p.length}`) : ''}
       ${f.sn ? (p.push(f.sn), `AND EXISTS (SELECT 1 FROM devices x WHERE x.location_id=l.id AND x.sn=$${p.length})`) : ''}
     GROUP BY l.id, l.name, t.name ORDER BY in_count DESC`, p);
  return r.rows;
}

// Төхөөрөмж бүрээр нэгтгэл
async function flowByDevice(f) {
  const p = [];
  const r = await query(
    `SELECT d.sn, d.name, d.location_id, l.name AS location_name,
       (d.last_heartbeat > now() - interval '${ONLINE_WINDOW_MIN} minutes') AS online, d.last_heartbeat, d.last_data_at,
       coalesce(sum(fr.in_count),0)::int AS in_count, coalesce(sum(fr.out_count),0)::int AS out_count,
       coalesce(sum(fr.passby),0)::int AS passby, coalesce(sum(fr.turnback),0)::int AS turnback
     FROM devices d LEFT JOIN locations l ON l.id=d.location_id
     LEFT JOIN flow_records fr ON fr.sn=d.sn AND fr.data_mode='Add' ${range(f, p, 'fr.ts')}
     WHERE 1=1 ${scope(f, p)}
     GROUP BY d.sn, d.name, d.location_id, l.name, d.last_heartbeat, d.last_data_at ORDER BY l.name NULLS LAST, d.name, d.sn`, p);
  return r.rows;
}

// Одоо байгаа хүн: residence push байвал сүүлийн snapshot, үгүй бол өнөөдрийн орсон-гарсан
async function currentOccupancy(f) {
  const tz = f.tz || DEFAULT_TZ;
  const p = [tz];
  const r = await query(
    `WITH dev AS (SELECT d.sn, d.name, d.location_id FROM devices d WHERE 1=1 ${scope(f, p)}),
     snap AS (
       SELECT DISTINCT ON (o.sn) o.sn, o.current_stay, o.ts FROM occupancy_snapshots o JOIN dev ON dev.sn=o.sn
       WHERE o.ts > now() - interval '15 minutes' ORDER BY o.sn, o.ts DESC),
     today AS (
       SELECT fr.sn, sum(fr.in_count)::int AS in_count, sum(fr.out_count)::int AS out_count
       FROM flow_records fr JOIN dev ON dev.sn=fr.sn
       WHERE fr.data_mode='Add' AND fr.ts >= date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1
       GROUP BY fr.sn)
     SELECT dev.sn, dev.name, dev.location_id,
       coalesce(snap.current_stay, GREATEST(coalesce(today.in_count,0)-coalesce(today.out_count,0),0)) AS current,
       snap.ts AS snapshot_at, coalesce(today.in_count,0) AS in_today, coalesce(today.out_count,0) AS out_today,
       (snap.sn IS NOT NULL) AS from_snapshot
     FROM dev LEFT JOIN snap ON snap.sn=dev.sn LEFT JOIN today ON today.sn=dev.sn`, p);
  const rows = r.rows;
  return { total: rows.reduce((s, x) => s + Number(x.current), 0), devices: rows };
}

// Долоо хоногийн өдөр × цагийн дулааны зураг
async function heatmap(f) {
  const tz = f.tz || DEFAULT_TZ;
  const p = [tz];
  const r = await query(
    `SELECT extract(isodow FROM fr.ts AT TIME ZONE $1)::int AS dow, extract(hour FROM fr.ts AT TIME ZONE $1)::int AS hour,
       sum(fr.in_count)::int AS in_count
     FROM flow_records fr JOIN devices d ON d.sn=fr.sn
     WHERE fr.data_mode='Add' ${scope(f, p)} ${range(f, p, 'fr.ts')}
     GROUP BY 1,2 ORDER BY 1,2`, p);
  return r.rows;
}

// Нас, хүйс — хүн бүрийн үйл явдлаас. Төхөөрөмж нас/хүйс/өндөр/байх хугацааг ихэвчлэн ГАРАХ (1) үйл явдалд хавсаргадаг,
// орох (0) үйл явдалд заримдаа хоосон ирдэг тул хүн бүрийг (sn, id_index) нэг удаа — мэдээлэл илүүтэй мөрийг нь — тоолно.
async function demographics(f) {
  const p = [];
  const base = `FROM (
      SELECT DISTINCT ON (pe.sn, coalesce(pe.id_index, pe.id)) pe.*
      FROM person_events pe JOIN devices d ON d.sn=pe.sn
      WHERE pe.event_type IN (0,1) ${scope(f, p)} ${range(f, p, 'pe.ts')}
      ORDER BY pe.sn, coalesce(pe.id_index, pe.id),
        (CASE WHEN pe.gender IN (1,2) THEN 0 ELSE 1 END), (CASE WHEN pe.age_min IS NULL THEN 1 ELSE 0 END), pe.event_type DESC, pe.ts DESC
    ) pe WHERE 1=1`;
  const gender = await query(`SELECT coalesce(pe.gender,0) AS gender, count(*)::int AS n ${base} AND coalesce(pe.workcard,0)=0 GROUP BY 1`, p);
  const age = await query(
    `SELECT CASE WHEN pe.age_min IS NULL THEN 'unknown'
       WHEN pe.age_min < 10 THEN '0_9' WHEN pe.age_min < 17 THEN '10_16' WHEN pe.age_min < 31 THEN '17_30'
       WHEN pe.age_min < 46 THEN '31_45' WHEN pe.age_min < 61 THEN '46_60' ELSE '61_plus' END AS age_group,
       coalesce(pe.gender,0) AS gender, count(*)::int AS n ${base} AND coalesce(pe.workcard,0)=0 GROUP BY 1,2`, p);
  const misc = await query(
    `SELECT count(*)::int AS total,
       count(*) FILTER (WHERE coalesce(pe.workcard,0)=1)::int AS staff,
       count(*) FILTER (WHERE coalesce(pe.wheelchair,0)=1)::int AS wheelchair,
       count(*) FILTER (WHERE pe.height_cm IS NOT NULL AND pe.height_cm < 140)::int AS children_by_height,
       avg(pe.height_cm) FILTER (WHERE pe.height_cm > 0)::int AS avg_height_cm,
       avg(pe.stay_time_ms) FILTER (WHERE pe.stay_time_ms > 0)::int AS avg_stay_ms ${base}`, p);
  return { gender: gender.rows, age_gender: age.rows, ...misc.rows[0] };
}

// REID — давхардалгүй хүн (өдрийн тайлан)
function dateRange(f, p, col) {
  const w = [];
  if (f.from) { p.push(normTs(f.from)); w.push(`${col} >= ($${p.length})::date`); }
  if (f.to) { p.push(normTs(f.to)); w.push(`${col} < ($${p.length})::date`); }
  return w.length ? ' AND ' + w.join(' AND ') : '';
}

async function reidSummary(f) {
  const p1 = [];
  const reports = await query(
    `SELECT r.id, r.master_sn, d.name AS device_name, l.name AS location_name, r.report_date, r.direction, r.device_sns, r.unique_count, r.received_at
     FROM reid_reports r JOIN devices d ON d.sn=r.master_sn LEFT JOIN locations l ON l.id=d.location_id
     WHERE 1=1 ${scope(f, p1)} ${dateRange(f, p1, 'r.report_date')} ORDER BY r.report_date DESC, l.name`, p1);
  const p2 = [];
  const persons = await query(
    `SELECT count(*)::int AS unique_visitors,
       count(*) FILTER (WHERE coalesce(rp.person_type,0)=0)::int AS customers,
       count(*) FILTER (WHERE rp.person_type=1)::int AS staff,
       count(*) FILTER (WHERE rp.person_type IN (2,3))::int AS riders_couriers,
       count(*) FILTER (WHERE rp.visit_count > 1)::int AS repeat_visitors,
       coalesce(avg(rp.total_dwell_ms),0)::int AS avg_dwell_ms,
       coalesce(avg(rp.visit_count),0)::numeric(6,2) AS avg_visits,
       count(*) FILTER (WHERE rp.gender=1)::int AS male, count(*) FILTER (WHERE rp.gender=2)::int AS female,
       count(*) FILTER (WHERE rp.height_category=2)::int AS children, count(*) FILTER (WHERE rp.height_category=1)::int AS adults
     FROM reid_persons rp JOIN devices d ON d.sn=rp.master_sn
     WHERE 1=1 ${scope(f, p2)} ${dateRange(f, p2, 'rp.report_date')}`, p2);
  const p3 = [];
  const dwellDist = await query(
    `SELECT CASE WHEN rp.total_dwell_ms < 60000 THEN '<1м' WHEN rp.total_dwell_ms < 300000 THEN '1-5м'
       WHEN rp.total_dwell_ms < 900000 THEN '5-15м' WHEN rp.total_dwell_ms < 1800000 THEN '15-30м'
       WHEN rp.total_dwell_ms < 3600000 THEN '30-60м' ELSE '>60м' END AS bucket, count(*)::int AS n
     FROM reid_persons rp JOIN devices d ON d.sn=rp.master_sn
     WHERE coalesce(rp.person_type,0)=0 ${scope(f, p3)} ${dateRange(f, p3, 'rp.report_date')}
     GROUP BY 1`, p3);
  const p4 = [];
  const daily = await query(
    `SELECT rp.report_date, count(*)::int AS unique_visitors, count(*) FILTER (WHERE coalesce(rp.person_type,0)=0)::int AS customers
     FROM reid_persons rp JOIN devices d ON d.sn=rp.master_sn
     WHERE 1=1 ${scope(f, p4)} ${dateRange(f, p4, 'rp.report_date')}
     GROUP BY 1 ORDER BY 1`, p4);
  return { reports: reports.rows, summary: persons.rows[0], dwell_distribution: dwellDist.rows, daily: daily.rows };
}

// DUP тайлан
async function dedupSummary(f) {
  const p = [];
  const r = await query(
    `SELECT r.id, r.master_sn, d.name AS device_name, l.name AS location_name, r.report_date, r.direction, r.device_sns,
       r.raw_count, r.duplicate_count, r.deduped_count, r.customer_count, r.non_customer_count, r.stats, r.is_final, r.received_at
     FROM dedup_reports r JOIN devices d ON d.sn=r.master_sn LEFT JOIN locations l ON l.id=d.location_id
     WHERE 1=1 ${scope(f, p)} ${dateRange(f, p, 'r.report_date')} ORDER BY r.report_date DESC, l.name`, p);
  const rows = r.rows;
  // нэгтгэсэн нас×хүйс
  const agg = { raw: 0, duplicate: 0, deduped: 0, customer: 0, non_customer: 0, adult: 0, child: 0, unknown_h: 0,
    staff: 0, rider: 0, courier: 0, age_gender: {} };
  for (const x of rows) {
    agg.raw += x.raw_count; agg.duplicate += x.duplicate_count; agg.deduped += x.deduped_count;
    agg.customer += x.customer_count; agg.non_customer += x.non_customer_count;
    const c = (x.stats && x.stats.customer) || {};
    const h = c.height_category || {};
    agg.adult += h.adult || 0; agg.child += h.child || 0; agg.unknown_h += h.unknown || 0;
    const nc = ((x.stats && x.stats.non_customer) || {}).categories || {};
    agg.staff += nc.staff || 0; agg.rider += nc.rider || 0; agg.courier += nc.courier || 0;
    for (const [k, v] of Object.entries(c.age_gender || {})) {
      agg.age_gender[k] = agg.age_gender[k] || { male: 0, female: 0, unknown: 0 };
      agg.age_gender[k].male += v.male || 0; agg.age_gender[k].female += v.female || 0; agg.age_gender[k].unknown += v.unknown || 0;
    }
  }
  return { reports: rows, aggregate: agg };
}

// Бодит цаг: зочин бүр нэг мөр — (sn, id_index)-ээр орох(0)/гарах(1) үйл явдлыг нэгтгэнэ (сүүлийн 6 цаг); өнгөрсөн/буцсан тусдаа
async function liveVisits(f) {
  const p = [];
  const visits = await query(
    `SELECT pe.sn, pe.id_index, d.name AS device_name,
       min(pe.ts) FILTER (WHERE pe.event_type=0) AS t_in, max(pe.ts) FILTER (WHERE pe.event_type=1) AS t_out,
       max(pe.gender) FILTER (WHERE pe.gender IN (1,2)) AS gender,
       max(pe.age_min) AS age_min, max(pe.age_max) AS age_max, max(pe.height_cm) FILTER (WHERE pe.height_cm > 0) AS height_cm,
       max(pe.stay_time_ms) AS stay_time_ms, bool_or(coalesce(pe.workcard,0)=1) AS staff, bool_or(coalesce(pe.wheelchair,0)=1) AS wheelchair,
       max(pe.ts) AS last_ts
     FROM person_events pe JOIN devices d ON d.sn=pe.sn
     WHERE pe.id_index IS NOT NULL AND pe.event_type IN (0,1) AND pe.ts > now() - interval '6 hours' ${scope(f, p)}
     GROUP BY pe.sn, pe.id_index, d.name ORDER BY last_ts DESC LIMIT 40`, p);
  const p2 = [];
  const passes = await query(
    `SELECT pe.id, pe.sn, pe.ts, pe.event_type, pe.gender, pe.age_min, pe.age_max, pe.height_cm, d.name AS device_name
     FROM person_events pe JOIN devices d ON d.sn=pe.sn
     WHERE pe.event_type IN (2,3) AND pe.ts > now() - interval '1 hour' ${scope(f, p2)} ORDER BY pe.ts DESC LIMIT 20`, p2);
  return { visits: visits.rows, passes: passes.rows };
}

async function personEvents(f) {
  const p = [];
  const limit = Math.min(Number(f.limit) || 200, 5000);
  const r = await query(
    `SELECT pe.*, d.name AS device_name, d.location_id FROM person_events pe JOIN devices d ON d.sn=pe.sn
     WHERE 1=1 ${scope(f, p)} ${range(f, p, 'pe.ts')} ORDER BY pe.ts DESC LIMIT ${limit}`, p);
  return r.rows;
}

async function flowRecords(f) {
  const p = [];
  const limit = Math.min(Number(f.limit) || 500, 10000);
  const r = await query(
    `SELECT fr.*, d.name AS device_name, d.location_id FROM flow_records fr JOIN devices d ON d.sn=fr.sn
     WHERE 1=1 ${scope(f, p)} ${range(f, p, 'fr.ts')} ORDER BY fr.ts DESC LIMIT ${limit}`, p);
  return r.rows;
}

module.exports = {
  ONLINE_WINDOW_MIN, DEFAULT_TZ, listLocations, listDevices, flowSeries, flowTotals, flowByLocation, flowByDevice,
  currentOccupancy, heatmap, demographics, reidSummary, dedupSummary, personEvents, flowRecords, liveVisits,
};
