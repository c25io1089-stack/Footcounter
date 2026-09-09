// Гадаад REST API v1 — X-API-Key толгойгоор нэвтэрнэ, tenant-ийн хүрээнд л өгөгдөл өгнө
const express = require('express');
const auth = require('../lib/auth');
const stats = require('../lib/stats');

const router = express.Router();
router.use(auth.requireApiKey);

function filters(req) {
  const q = req.query;
  return {
    tenantId: req.tenantId,
    locationId: q.location_id ? Number(q.location_id) : null,
    sn: q.sn || null,
    from: q.from || null,
    to: q.to || null,
    granularity: q.granularity || 'hour',
    tz: q.tz || stats.DEFAULT_TZ,
    limit: q.limit,
  };
}
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => { console.error(e); res.status(500).json({ error: e.message }); });
const ok = (res, data, extra = {}) => res.json({ ok: true, ...extra, data });

router.get('/me', (req, res) => ok(res, { tenant_id: req.tenantId, tenant_name: req.apiKey.tenant_name, scopes: req.apiKey.scopes }));
router.get('/locations', wrap(async (req, res) => ok(res, await stats.listLocations(req.tenantId))));
router.get('/devices', wrap(async (req, res) => {
  const rows = await stats.listDevices(filters(req));
  // WiFi нууц үг зэрэг эмзэг талбарыг гадагш өгөхгүй
  ok(res, rows.map(({ wifi_ssid, ...d }) => d));
}));
router.get('/flow/series', wrap(async (req, res) => ok(res, await stats.flowSeries(filters(req)), { granularity: filters(req).granularity })));
router.get('/flow/totals', wrap(async (req, res) => ok(res, await stats.flowTotals(filters(req)))));
router.get('/flow/by-location', wrap(async (req, res) => ok(res, await stats.flowByLocation(filters(req)))));
router.get('/flow/by-device', wrap(async (req, res) => ok(res, await stats.flowByDevice(filters(req)))));
router.get('/flow/records', wrap(async (req, res) => ok(res, await stats.flowRecords(filters(req)))));
router.get('/flow/heatmap', wrap(async (req, res) => ok(res, await stats.heatmap(filters(req)))));
router.get('/occupancy', wrap(async (req, res) => ok(res, await stats.currentOccupancy(filters(req)))));
router.get('/demographics', wrap(async (req, res) => ok(res, await stats.demographics(filters(req)))));
router.get('/events', wrap(async (req, res) => ok(res, await stats.personEvents(filters(req)))));
router.get('/reid', wrap(async (req, res) => ok(res, await stats.reidSummary(filters(req)))));
router.get('/dedup', wrap(async (req, res) => ok(res, await stats.dedupSummary(filters(req)))));

module.exports = router;
