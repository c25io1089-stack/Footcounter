-- Төхөөрөмжийн сүүлд илгээсэн dataUpload body (attributes-ийн эхний 5 нь) — бодит форматыг Лог цонхноос харж дебаг хийхэд
ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_upload JSONB;
