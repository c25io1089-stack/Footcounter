-- Төхөөрөмж dataUpload бүртээ насанд хүрэгч/хүүхдийн задаргааг илгээдэг
-- (inAdult, inChild, outAdult, outChild, passbyAdult, passbyChild, turnbackAdult, turnbackChild).
-- Эдгээр нь хүн бүрийн attributes-аас хамаарахгүй, интервал бүрт ирдэг тул хамгийн найдвартай
-- задаргаа — өмнө нь хадгалагдахгүй хаягдаж байсныг хадгалдаг болгов.
ALTER TABLE flow_records ADD COLUMN IF NOT EXISTS in_adult       INT NOT NULL DEFAULT 0;
ALTER TABLE flow_records ADD COLUMN IF NOT EXISTS in_child       INT NOT NULL DEFAULT 0;
ALTER TABLE flow_records ADD COLUMN IF NOT EXISTS out_adult      INT NOT NULL DEFAULT 0;
ALTER TABLE flow_records ADD COLUMN IF NOT EXISTS out_child      INT NOT NULL DEFAULT 0;
ALTER TABLE flow_records ADD COLUMN IF NOT EXISTS passby_adult   INT NOT NULL DEFAULT 0;
ALTER TABLE flow_records ADD COLUMN IF NOT EXISTS passby_child   INT NOT NULL DEFAULT 0;
ALTER TABLE flow_records ADD COLUMN IF NOT EXISTS turnback_adult INT NOT NULL DEFAULT 0;
ALTER TABLE flow_records ADD COLUMN IF NOT EXISTS turnback_child INT NOT NULL DEFAULT 0;
