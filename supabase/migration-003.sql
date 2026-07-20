-- ============================================================
-- Migrácia 003 — prílohy pri objednávke (Supabase Storage)
-- Spustite v SQL editore, ak už máte databázu z predošlej schémy.
-- ============================================================

alter table orders add column if not exists attachments jsonb not null default '[]';

drop function if exists create_order(text, text, text, numeric, boolean, text, text, text, text, date, text, text, text, date, time, text);

create or replace function create_order(
  p_id text, p_exam_type_id text, p_exam_label text, p_price numeric,
  p_has_referral boolean, p_reason text, p_referrer_name text, p_referrer_facility text,
  p_patient_name text, p_birth_date date, p_insurance text, p_phone text, p_email text,
  p_slot_date date, p_slot_time time, p_variable_symbol text,
  p_attachments jsonb default '[]'::jsonb
) returns text
language plpgsql security definer set search_path = public as $$
declare v_doctor text;
begin
  select s.doctor into v_doctor
  from open_slots s
  where s.slot_date = p_slot_date and s.slot_time = p_slot_time;
  if not found then
    raise exception 'Vybraný termín nie je otvorený na objednávanie.';
  end if;
  if exists (select 1 from orders o where o.slot_date = p_slot_date and o.slot_time = p_slot_time and o.status <> 'rejected') then
    raise exception 'Vybraný termín bol medzičasom obsadený. Vyberte iný.';
  end if;
  insert into orders (
    id, has_referral, exam_type_id, exam_label, price, reason,
    referrer_name, referrer_facility, patient_name, birth_date,
    insurance, phone, email, slot_date, slot_time, variable_symbol, doctor, attachments
  ) values (
    p_id, p_has_referral, p_exam_type_id, p_exam_label, p_price, p_reason,
    coalesce(p_referrer_name, ''), coalesce(p_referrer_facility, ''), p_patient_name, p_birth_date,
    coalesce(p_insurance, ''), p_phone, coalesce(p_email, ''), p_slot_date, p_slot_time, p_variable_symbol,
    coalesce(v_doctor, ''), coalesce(p_attachments, '[]'::jsonb)
  );
  return p_id;
end $$;

revoke all on function create_order(text, text, text, numeric, boolean, text, text, text, text, date, text, text, text, date, time, text, jsonb) from public;
grant execute on function create_order(text, text, text, numeric, boolean, text, text, text, text, date, text, text, text, date, time, text, jsonb) to anon, authenticated;

-- súkromný bucket na prílohy
insert into storage.buckets (id, name, public) values ('prilohy', 'prilohy', false)
on conflict (id) do nothing;

drop policy if exists "prilohy upload" on storage.objects;
create policy "prilohy upload" on storage.objects
  for insert to anon, authenticated with check (bucket_id = 'prilohy');
drop policy if exists "prilohy citanie personal" on storage.objects;
create policy "prilohy citanie personal" on storage.objects
  for select to authenticated using (bucket_id = 'prilohy');
drop policy if exists "prilohy mazanie personal" on storage.objects;
create policy "prilohy mazanie personal" on storage.objects
  for delete to authenticated using (bucket_id = 'prilohy');
