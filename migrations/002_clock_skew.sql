-- Төхөөрөмжийн цагийн зөрүү (сек): heartbeat-ийн timestamp = төхөөрөмжийн «одоо» тул серверийн цагтай харьцуулж олно.
-- Төхөөрөмж орон нутгийн цагаа UTC мэт илгээвэл (жишээ нь +8 цаг) бүх ирж буй цагийг энэ утгаар засна.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS clock_skew_sec INT NOT NULL DEFAULT 0;
