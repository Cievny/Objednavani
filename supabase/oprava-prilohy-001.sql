-- ============================================================
-- OPRAVA PRÍLOHY 001 — „new row violates row-level security policy"
--   pri nahrávaní žiadanky (USG, CT aj angio)
--
-- Príčina: audit-vlna6-001 (časť N) viazal upload na EXISTUJÚCU
-- objednávku, ale aplikácia nahráva prílohy PRED vytvorením objednávky
-- (číslo objednávky sa generuje v prehliadači, potom sa nahrajú súbory,
-- až potom sa volá create_order s ich cestami). Politika preto každý
-- upload odmietla.
--
-- Nová ochrana namiesto toho:
--   • cesta musí byť <USG|CT|ANG>-<id>/<súbor> (bez ďalších lomítok)
--   • max 3 súbory na jeden priečinok (objednávku)
--   • max 30 uploadov / 15 min z jednej IP (ak je IP známa)
--   • osirelé priečinky bez objednávky čistí purge_orphan_attachments
-- Idempotentné. Rovnaký blok je aj v audit-vlna6-001 a angio-001
-- (opravené verzie), takže poradie spúšťania sa nemení.
-- ============================================================

create or replace function upload_allowed(p_name text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_ip     text := client_ip();
  v_folder text := split_part(p_name, '/', 1);
begin
  if p_name !~ '^(USG|CT|ANG)-[A-Za-z0-9-]{4,40}/[^/]{1,120}$' then
    return false;
  end if;
  if (select count(*) from storage.objects
      where bucket_id = 'prilohy' and name like v_folder || '/%') >= 3 then
    return false;
  end if;
  if v_ip <> '' then
    perform check_rate_limit('upload-ip:' || v_ip, 30);
  end if;
  return true;
end $$;
revoke all on function upload_allowed(text) from public;
grant execute on function upload_allowed(text) to anon, authenticated;

drop policy if exists "prilohy upload" on storage.objects;
create policy "prilohy upload" on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'prilohy' and upload_allowed(name));

-- Diagnostika:
--   select policyname, with_check from pg_policies where tablename = 'objects' and policyname = 'prilohy upload';
-- ============================================================
