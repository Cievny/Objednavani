-- ============================================================
-- AUDIT VLNA 5 — 001
--
-- #1 (KRITICKÉ): purge_orphan_attachments mazal aj platné CT
-- žiadanky. Pôvodná podmienka kontrolovala len tabuľku `orders`,
-- takže prílohy v priečinku `CT-XXXX/` (patria do `ct_orders`)
-- boli považované za osirelé a deň po nahratí sa zmazali —
-- hoci pri CT je žiadanka povinná (ct-005).
--
-- Oprava: za „platný" priečinok sa považuje ID z `orders`
-- ALEBO z `ct_orders`. Zvyšok správania (mazanie po 1 dni,
-- ošetrenie výnimkou, cron o 02:30) ostáva nezmenený.
--
-- Idempotentné. Bez kľúčov. Spúšťať PO audit-vlna4-001 a ct-002.
-- ============================================================

create or replace function purge_orphan_attachments()
returns int
language plpgsql security definer set search_path = public as $$
declare v int := 0;
begin
  begin
    with valid_ids as (
      select id from orders
      union all
      select id from ct_orders
    ),
    del as (
      delete from storage.objects o
      where o.bucket_id = 'prilohy'
        and o.created_at < now() - interval '1 day'
        and split_part(o.name, '/', 1) not in (select id from valid_ids)
      returning 1
    )
    select count(*) into v from del;
  exception when others then
    v := 0; -- prípadný chýbajúci prístup k storage.objects nesmie zhodiť cron
  end;
  return v;
end $$;
revoke all on function purge_orphan_attachments() from public, anon, authenticated;

-- Cron ostáva rovnaký (usg-orphan-attachments, 02:30). Netreba prepisovať.
-- ============================================================
