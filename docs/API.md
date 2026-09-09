# REST API v1 — баримт

**Base URL:** `https://<домэйн>/api/v1`
**Нэвтрэлт:** `X-API-Key: hx_…` толгой (эсвэл `Authorization: Bearer hx_…`, эсвэл `?api_key=`).
Түлхүүр байгууллага (tenant) бүрд тусдаа; бүх хариу тухайн байгууллагын өгөгдлөөр хязгаарлагдана.

**Хариуны бүтэц:** `{ "ok": true, "data": … }` — алдаа: `{ "error": "…" }` (401 түлхүүр буруу, 500 серверийн алдаа).

## Нийтлэг query параметр

| Параметр | Тайлбар | Жишээ |
|---|---|---|
| `from`, `to` | Хугацааны хүрээ (ISO). `to` хамаарахгүй (exclusive). | `from=2026-09-01&to=2026-09-08` эсвэл `from=2026-09-01T09:00:00+08:00` |
| `location_id` | Байршлаар шүүх | `location_id=3` |
| `sn` | Төхөөрөмжөөр шүүх | `sn=201000002501090095` |
| `tz` | Цагийн бүс (bucket, өнөөдөр гэх тооцоонд) | `tz=Asia/Ulaanbaatar` (анхдагч) |
| `granularity` | `flow/series`-д: `hour`, `day`, `week`, `month` | `granularity=day` |
| `limit` | `records`/`events`-д мөрийн дээд тоо | `limit=1000` |

REID/DUP endpoint-д `from`/`to` нь **өдрийн** утга (`YYYY-MM-DD`).

## Endpoint-үүд

### `GET /me`
```json
{"ok":true,"data":{"tenant_id":1,"tenant_name":"Номин Холдинг","scopes":["read"]}}
```

### `GET /locations`
`id, name, address, timezone, open_time, close_time, device_count, online_count`

### `GET /devices`
`sn, name, location_id, location_name, online, last_heartbeat, last_data_at, ip_address, mac_address, connection_type, hw_platform, sw_release, upload_interval, data_mode, timezone_offset`

### `GET /flow/totals`
```json
{"ok":true,"data":{"in_count":8759,"out_count":8544,"passby":5251,"turnback":570,"avg_stay_ms":2614}}
```

### `GET /flow/series?granularity=hour|day|week|month`
```json
{"ok":true,"granularity":"day","data":[
  {"bucket":"2026-09-05T00:00:00.000","in_count":848,"out_count":828,"passby":518,"turnback":50,"avg_stay_ms":2604}
]}
```
`bucket` нь `tz`-ийн орон нутгийн цаг.

### `GET /flow/by-location`
Байршил бүрээр `in_count, out_count, passby, turnback, device_count, online_count`.

### `GET /flow/by-device`
Төхөөрөмж бүрээр `in_count, out_count, passby, turnback, online, last_heartbeat`.

### `GET /flow/records?limit=500`
Түүхий интервалын бичлэг: `sn, ts, start_time, end_time, in_count, out_count, passby, turnback, avg_stay_ms, data_mode`.

### `GET /flow/heatmap`
`[{ "dow": 1..7 (Да=1), "hour": 0..23, "in_count": n }]`

### `GET /occupancy`
```json
{"ok":true,"data":{"total":27,"devices":[
  {"sn":"…","name":"Гол хаалга","location_id":1,"current":7,"snapshot_at":"…","in_today":206,"out_today":204,"from_snapshot":true}
]}}
```
`from_snapshot=true` бол төхөөрөмжийн residence push (`currentStay`), үгүй бол өнөөдрийн орсон − гарсан.

### `GET /demographics`
```json
{"gender":[{"gender":1,"n":4045},{"gender":2,"n":4347}],
 "age_gender":[{"age_group":"17_30","gender":1,"n":1354}, …],
 "total":8839,"staff":533,"wheelchair":107,"children_by_height":384,"avg_height_cm":165,"avg_stay_ms":3300}
```
`gender`: 1 эр, 2 эм, 0 тодорхойгүй. `age_group`: `0_9, 10_16, 17_30, 31_45, 46_60, 61_plus, unknown`.

### `GET /events?limit=200`
Хүн бүрийн үйл явдал: `sn, ts, event_type (0 орсон,1 гарсан,2 өнгөрсөн,3 буцсан), stay_time_ms, height_cm, gender, age_min, age_max, workcard, wheelchair`.

### `GET /reid`
```json
{"summary":{"unique_visitors":6100,"customers":6100,"staff":0,"riders_couriers":0,"repeat_visitors":1909,
            "avg_dwell_ms":1849000,"avg_visits":"1.31","male":2990,"female":3110,"children":224,"adults":5876},
 "daily":[{"report_date":"2026-09-02","unique_visitors":890,"customers":890}],
 "dwell_distribution":[{"bucket":"1-5м","n":290}, …],
 "reports":[{"master_sn":"…","report_date":"2026-09-07","direction":"in","device_sns":["…"],"unique_count":211}]}
```

### `GET /dedup`
```json
{"aggregate":{"raw":9898,"duplicate":3009,"deduped":6889,"customer":6100,"non_customer":789,
              "adult":5876,"child":224,"staff":494,"rider":199,"courier":96,
              "age_gender":{"17_30":{"male":1051,"female":1040,"unknown":0}, …}},
 "reports":[{"master_sn":"…","report_date":"2026-09-07","raw_count":…,"is_final":true,"stats":{…}}]}
```

## Жишээ (Python)

```python
import requests
r = requests.get("https://xxxx.up.railway.app/api/v1/flow/series",
                 headers={"X-API-Key": "hx_XXXX"},
                 params={"granularity": "day", "from": "2026-09-01", "to": "2026-09-08", "location_id": 1})
for row in r.json()["data"]:
    print(row["bucket"][:10], row["in_count"], row["out_count"])
```

## Төхөөрөмжийн ingest (HX-CCD21 → сервер)

Нэвтрэлтгүй, SN-ээр таньдаг. Протокол V2.5-ын дагуу:

| Зам | Body | Хариу |
|---|---|---|
| `POST /api/camera/heartBeat` | `{sn, timestamp, macAddress, ipAddress, …}` | `{code:0, data:{sn, time, timezone, uploadInterval, dataMode, dataStartTime?, dataEndTime?}}` |
| `POST /api/camera/dataUpload` | урсгал `{sn, time, startTime, endTime, in, out, passby, turnback, avgStayTime, attributes[]}` эсвэл residence `{sn, time, currentStay, info[]}` | `{code:0, data:{sn, time}}` |
| `POST /api/camera/reid` | `{date, direction, master_sn, device_sns, reid_records[]}` | `{code:0}` |
| `POST /api/camera/dup` | `{date, direction, master_sn, device_sns, dedup_summary, deduped_stats, records?}` | `{code:0}` |

`code`: 0 амжилттай, 1 SN байхгүй, 2 бусад алдаа.
