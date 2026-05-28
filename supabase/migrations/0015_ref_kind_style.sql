-- Extend ref_kind enum with 'style' so style references (mood board uploads
-- on /generate page) can be inserted. Previously the enum only had
-- ('character', 'product'), and any query/insert with kind='style' returned
-- 400 Bad Request because PostgREST rejects unknown enum values.
--
-- Safe re-run: `IF NOT EXISTS` makes ALTER TYPE idempotent.

alter type ref_kind add value if not exists 'style';

-- Also reserve future-use values so we don't hit this again next time we add
-- a new ref category. (Adding now is free; using later requires no migration.)
alter type ref_kind add value if not exists 'brand_logo';
alter type ref_kind add value if not exists 'background';
