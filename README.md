# HX-CCD21 Хүний урсгалын Dashboard + API

FOORIR **HX-CCD21 (3D AI хүн тоологч)** төхөөрөмжөөс HTTP POST-оор ирэх өгөгдлийг хүлээн авч, олон байгууллага (tenant), олон байршлын хэмжээнд Монгол хэлээр харуулах dashboard болон API key-тэй REST API. Railway дээр нэг сервисээр (Node.js + PostgreSQL) ажиллана.

```
HX-CCD21 ──HTTP POST──▶  Railway (Node.js/Express)  ──▶  PostgreSQL
                              │
                              ├── /            Dashboard (Монгол хэл, cookie нэвтрэлт)
                              ├── /api/camera  Төхөөрөмжийн ingest (протокол V2.5)
                              └── /api/v1      Гадаад REST API (X-API-Key)
```

## Юу харуулдаг вэ

| Хуудас | Агуулга |
|---|---|
| **Тойм** | Орсон/гарсан/өнгөрсөн/буцсан, одоо байгаа хүн, дундаж байх хугацаа, өмнөх үетэй харьцуулалт, цаг/өдрийн график, байршлаар харьцуулалт, долоо хоногийн өдөр × цагийн heatmap |
| **Байршил** | Байршил бүрийн нэгтгэл, орох хувь (in ÷ (in+passby)), төхөөрөмжийн online тоо |
| **Төхөөрөмж** | Online/offline (heartbeat 3 минут), IP/MAC/firmware, илгээх давтамж, Add/Total горим, түүхэн өгөгдөл дахин татах (90 хоног), heartbeat лог, SN-ээр шинэ төхөөрөмж холбох |
| **Зочны портрет** | Нас × хүйс, ажилтан (картаар), тэргэнцэр, дундаж өндөр; DUP тайлангаас давхардал арилгасан бүтэц |
| **Давхардалгүй зочид** | REID: давхардалгүй зочин, давтан орсон, байх хугацааны тархалт, зочин/ажилтан/хүргэлт, өдөр бүрээр |
| **Тохиргоо** | Байгууллага (tenant), байршил, хэрэглэгч (superadmin/admin/viewer), API түлхүүр, API баримт, ingest алдааны лог |

## 1. Railway дээр байршуулах

1. Энэ хавтсыг GitHub repo болгож push хийнэ (эсвэл Railway CLI-аар `railway up`).
2. Railway → **New Project → Deploy from GitHub repo** → repo-гоо сонгоно.
3. Мөн project дотор **+ New → Database → PostgreSQL** нэмнэ. Railway автоматаар `DATABASE_URL` хувьсагчийг сервис рүү өгнө (өгөөгүй бол Variables → `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` гэж reference хийнэ).
4. Сервисийн **Variables** дээр нэмнэ:

   | Хувьсагч | Утга |
   |---|---|
   | `JWT_SECRET` | урт санамсаргүй мөр (`openssl rand -hex 32`) |
   | `ADMIN_EMAIL` | анхны супер админы и-мэйл |
   | `ADMIN_PASSWORD` | анхны нууц үг (нэвтэрсний дараа солино) |
   | `NODE_ENV` | `production` |

5. **Settings → Networking → Generate Domain** → `xxxx.up.railway.app` хаяг авна. Эхний deploy-д migration автоматаар хэрэгжиж, superadmin үүснэ.
6. `https://xxxx.up.railway.app` руу орж нэвтэрнэ → Тохиргоо → Байгууллага, Байршил үүсгэнэ.

> Railway дээр Postgres-ийн `DATABASE_URL` дотор `railway` гэсэн үг байвал SSL автоматаар асна. Өөр хостод SSL хэрэгтэй бол `PGSSL=1` тавина.

## 2. Төхөөрөмжийг холбох

Төхөөрөмж өөрөө сервер рүү илгээдэг (push) тул серверийн хаягийг төхөөрөмжийн тохиргоонд оруулна:

1. Төхөөрөмжийн удирдлагын хуудас руу орно (`foorir-search` хэрэгслээр IP-г олох, эсвэл hotspot `HF+SN-ийн сүүлийн 10 орон` → `192.168.4.10`, admin / hf123456).
2. **Settings → Data Push → HTTP → Add**:
   * Protocol: **HTTPS**
   * Server Address: `xxxx.up.railway.app`
   * Server Port: `443`
3. **Interface** таб дээр замуудыг тохируулна (эсвэл анхдагчаар үлдээнэ — доорх бүх зам дэмжигдэнэ):

   | Функц | Зам |
   |---|---|
   | Heartbeat | `/api/camera/heartBeat` |
   | Data upload | `/api/camera/dataUpload` |
   | REID | `/api/camera/reid` (эсвэл `/reid`) |
   | DUP | `/api/camera/dup` (эсвэл `/dup`) |

4. Төхөөрөмж эхний heartbeat илгээмэгц Dashboard → **Төхөөрөмж** хуудсанд "Оноогоогүй" гэж гарч ирнэ → **Засах** дарж нэр, байршил оноож өгнө. Эсвэл **+ SN-ээр төхөөрөмж нэмэх** дарж SN-ийг урьдчилан бүртгэнэ.

Илгээх давтамж (бодит цаг / 1 / 5 / 60 мин), Add/Total горим, цагийн бүсийг dashboard-аас тохируулбал дараагийн heartbeat-ийн хариугаар төхөөрөмж рүү очно (протоколын `uploadInterval`, `dataMode`, `timezone`). "Дахин татах" товч нь `dataStartTime/dataEndTime`-ийг илгээж 90 хоног хүртэлх түүхэн өгөгдлийг дахин авчруулна.

## 3. Гадаад REST API

Тохиргоо → **API түлхүүр** → үүсгэнэ (байгууллага бүрд тусдаа; өгөгдөл тухайн байгууллагаар автоматаар хязгаарлагдана).

```bash
curl -H "X-API-Key: hx_XXXX" \
  "https://xxxx.up.railway.app/api/v1/flow/series?granularity=day&from=2026-09-01&to=2026-09-08&location_id=1"
```

Нийтлэг query: `from`, `to` (ISO огноо/цаг), `location_id`, `sn`, `tz` (анхдагч `Asia/Ulaanbaatar`), `granularity` (`hour|day|week|month`), `limit`.

| Endpoint | Тайлбар |
|---|---|
| `GET /api/v1/me` | Түлхүүрийн байгууллага |
| `GET /api/v1/locations` | Байршлууд, төхөөрөмж/online тоо |
| `GET /api/v1/devices` | Төхөөрөмжийн төлөв, heartbeat, IP, firmware |
| `GET /api/v1/flow/totals` | Нийлбэр (in/out/passby/turnback/avg_stay_ms) |
| `GET /api/v1/flow/series` | Цаг хугацааны цуваа |
| `GET /api/v1/flow/by-location` · `by-device` | Нэгтгэл |
| `GET /api/v1/flow/records` | Түүхий интервалын бичлэгүүд |
| `GET /api/v1/flow/heatmap` | Долоо хоногийн өдөр × цаг |
| `GET /api/v1/occupancy` | Одоо байгаа хүн |
| `GET /api/v1/demographics` | Нас × хүйс, ажилтан, тэргэнцэр, өндөр |
| `GET /api/v1/events` | Хүн бүрийн үйл явдал |
| `GET /api/v1/reid` | REID давхардалгүй зочид |
| `GET /api/v1/dedup` | DUP тайлан нэгтгэл |

Дэлгэрэнгүй: `docs/API.md` эсвэл dashboard → Тохиргоо → API баримт.

## 4. Локал ажиллуулах / тест

```bash
cp .env.example .env            # DATABASE_URL-аа засна
npm install
npm start                       # http://localhost:3000  (admin@example.com / admin1234)
npm run simulate                # 3 виртуал төхөөрөмж, 14 хоногийн өгөгдөл илгээнэ
# node scripts/simulate.js https://xxxx.up.railway.app 7 SN1,SN2   ← Railway руу тест өгөгдөл
```

## 5. Бүтэц

```
src/server.js          Express, migration, seed, housekeeping
src/routes/ingest.js   Төхөөрөмжийн 4 endpoint (протокол V2.5)
src/routes/dashboard.js Dashboard-ийн дотоод API + админ CRUD
src/routes/publicApi.js Гадаад REST API (X-API-Key)
src/lib/stats.js       Бүх статистик SQL (tenant/байршил/SN/огноо шүүлтүүртэй)
src/lib/auth.js        JWT cookie, эрх, API key hash
migrations/001_init.sql PostgreSQL схем
public/                Dashboard (index.html, app.js, app.css, vendor/chart.umd.js)
scripts/simulate.js    Төхөөрөмжийн симулятор
```

**Өгөгдлийн хүснэгтүүд:** `tenants`, `users`, `locations`, `devices`, `heartbeats`, `flow_records` (интервалын in/out), `person_events` (нас/хүйс/өндөр), `occupancy_snapshots`, `reid_reports` + `reid_persons`, `dedup_reports`, `api_keys`, `ingest_log`.

**Эрхийн түвшин:** `superadmin` — бүх байгууллага; `admin` — өөрийн байгууллагын байршил/төхөөрөмж/хэрэглэгч/API түлхүүр; `viewer` — зөвхөн харах.

## Анхаарах зүйлс

* Төхөөрөмжийн `dataMode` **Add** (нэмэгдэл) байх ёстой — статистик Add бичлэгээс тооцно. Total горимын бичлэг хадгалагдана, гэхдээ нэгтгэлд орохгүй.
* Heartbeat 3 минут ирэхгүй бол offline гэж үзнэ (`ONLINE_WINDOW_MIN`, `src/lib/stats.js`).
* "Одоо байгаа хүн": төхөөрөмж residence push (`currentStay`) илгээж байвал түүнийг, үгүй бол өнөөдрийн орсон − гарсан.
* Ingest-ийн алдаа `ingest_log`-д 7 хоног, heartbeat 30 хоног хадгалагдаад автоматаар цэвэрлэгдэнэ.
* Төхөөрөмж SN-ээр танигддаг тул ingest endpoint-үүд нэвтрэлтгүй; хүсвэл Railway дээр Cloudflare/IP allowlist нэмж болно.
