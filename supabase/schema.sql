-- ============================================================
-- Schéma pre Supabase (Postgres) — Objednávanie na USG, NÚSCH
--
-- Spustite celý tento skript v Supabase SQL editore (Database
-- -> SQL Editor -> New query -> vložiť -> Run).
--
-- Bezpečnostný model:
--  - pacient (anon) NEČÍTA tabuľku orders priamo; obsadenosť,
--    vytvorenie, overenie aj zrušenie objednávky idú výhradne
--    cez SECURITY DEFINER funkcie nižšie, ktoré vracajú len
--    nevyhnutné údaje
--  - personál = prihlásený používateľ (Supabase Auth; kontá
--    zakladajte pozvánkou, verejnú registráciu vypnite v
--    Authentication -> Sign In / Up)
-- ============================================================

-- Cenník vyšetrení
create table pricelist (
  id text primary key,
  label text not null,
  price_self numeric(8, 2) not null,
  price_referral numeric(8, 2), -- null = so žiadankou nedostupné
  active boolean not null default true,
  sort_order int not null default 0
);

-- Termíny otvorené pracoviskom
create table open_slots (
  slot_date date not null,
  slot_time time not null,
  primary key (slot_date, slot_time)
);

-- Objednávky pacientov (id generuje aplikácia: USG-…)
create table orders (
  id text primary key,
  created_at timestamptz not null default now(),
  status text not null default 'new'
    check (status in ('new', 'confirmed', 'rejected', 'done', 'noshow')),
  status_note text not null default '',
  has_referral boolean not null,
  exam_type_id text not null,
  exam_label text not null,          -- kópia názvu v čase objednania
  price numeric(8, 2) not null,      -- kópia ceny v čase objednania
  reason text not null,
  referrer_name text not null default '',
  referrer_facility text not null default '',
  patient_name text not null,
  birth_date date,
  insurance text not null default '',
  phone text not null,
  email text not null default '',
  slot_date date not null,
  slot_time time not null,
  variable_symbol text not null default ''
);

-- Jeden aktívny pacient na termín (zamietnuté objednávky termín uvoľnia)
create unique index orders_slot_unique
  on orders (slot_date, slot_time)
  where status <> 'rejected';

-- Nastavenia platby (IBAN je verejný platobný údaj — číta ho aj pacient pre QR)
create table settings (
  key text primary key,
  value text not null
);
insert into settings (key, value) values
  ('iban', 'SK__DOPLNTE_SKUTOCNY_IBAN__'),
  ('beneficiary', 'NÚSCH, a.s.');

-- Predvolený cenník (platnosť od 01.03.2026)
insert into pricelist (id, label, price_self, price_referral, sort_order) values
  ('abdomen', 'USG brucha a brušnej dutiny', 45, 30, 0),
  ('kidneys', 'USG obličiek a močového mechúra', 40, 30, 1),
  ('pelvis', 'USG orgánov malej panvy', 40, 30, 2),
  ('soft', 'USG mäkkých tkanív', 40, 30, 3),
  ('thyroid', 'USG štítnej žľazy', 40, 30, 4),
  ('neck', 'USG orgánov krku (štítna žľaza, slinné žľazy, lymfatické uzliny)', 50, 30, 5),
  ('carotid', 'Dopplerova ultrasonografia extrakraniálnych mozgových tepien (karotíd a vertebrálnych artérií)', 50, 30, 6),
  ('upper1', 'Dopplerova ultrasonografia žíl alebo tepien horných končatín (jedna končatina)', 40, 30, 7),
  ('upper2', 'Dopplerova ultrasonografia žíl alebo tepien horných končatín (obe končatiny)', 50, 30, 8),
  ('lower1', 'Dopplerova ultrasonografia žíl alebo tepien dolných končatín (jedna končatina)', 40, 30, 9),
  ('lower2', 'Dopplerova ultrasonografia žíl alebo tepien dolných končatín (obe končatiny)', 50, 30, 10),
  ('renal', 'USG brucha s vyšetrením renálnych artérií', 60, 30, 11),
  ('aorta', 'USG brucha s vyšetrením brušnej aorty', 50, 30, 12),
  ('tos', 'Dopplerova ultrasonografia na vylúčenie TOS (žilový alebo tepnový typ)', 100, 30, 13),
  ('complete_vessels', 'Kompletné sonografické vyšetrenie ciev (tepny a žily krku, dolných končatín a brušnej aorty)', 100, null, 14),
  ('compressions', 'Kompletné sonografické vyšetrenie abdominálnych cievnych kompresií + konzultácia', 350, null, 15),
  ('consultation', 'USG vyšetrenie a komplexná rádiologická konzultácia prinesených materiálov', 90, null, 16);

-- ============================================================
-- Row Level Security
-- ============================================================

alter table pricelist enable row level security;
alter table open_slots enable row level security;
alter table orders enable row level security;
alter table settings enable row level security;

create policy "cennik cita ktokolvek" on pricelist
  for select using (active = true);
create policy "cennik spravuje personal" on pricelist
  for all using (auth.role() = 'authenticated');

create policy "sloty cita ktokolvek" on open_slots
  for select using (true);
create policy "sloty spravuje personal" on open_slots
  for all using (auth.role() = 'authenticated');

-- orders: ŽIADNA anon politika — pacient ide výhradne cez funkcie nižšie
create policy "objednavky spravuje personal" on orders
  for all using (auth.role() = 'authenticated');

create policy "nastavenia cita ktokolvek" on settings
  for select using (true);
create policy "nastavenia spravuje personal" on settings
  for all using (auth.role() = 'authenticated');

-- ============================================================
-- Funkcie pre pacienta (SECURITY DEFINER — obchádzajú RLS,
-- ale vracajú len presne vymedzené údaje)
-- ============================================================

-- Obsadené termíny (bez akýchkoľvek údajov o pacientoch)
create or replace function get_booked_slots()
returns table (slot_date date, slot_time time)
language sql security definer set search_path = public as $$
  select o.slot_date, o.slot_time
  from orders o
  where o.status <> 'rejected' and o.slot_date >= current_date;
$$;

-- Vytvorenie objednávky s kontrolou otvorenosti a obsadenosti termínu
create or replace function create_order(
  p_id text, p_exam_type_id text, p_exam_label text, p_price numeric,
  p_has_referral boolean, p_reason text, p_referrer_name text, p_referrer_facility text,
  p_patient_name text, p_birth_date date, p_insurance text, p_phone text, p_email text,
  p_slot_date date, p_slot_time time, p_variable_symbol text
) returns text
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from open_slots s where s.slot_date = p_slot_date and s.slot_time = p_slot_time) then
    raise exception 'Vybraný termín nie je otvorený na objednávanie.';
  end if;
  if exists (select 1 from orders o where o.slot_date = p_slot_date and o.slot_time = p_slot_time and o.status <> 'rejected') then
    raise exception 'Vybraný termín bol medzičasom obsadený. Vyberte iný.';
  end if;
  insert into orders (
    id, has_referral, exam_type_id, exam_label, price, reason,
    referrer_name, referrer_facility, patient_name, birth_date,
    insurance, phone, email, slot_date, slot_time, variable_symbol
  ) values (
    p_id, p_has_referral, p_exam_type_id, p_exam_label, p_price, p_reason,
    coalesce(p_referrer_name, ''), coalesce(p_referrer_facility, ''), p_patient_name, p_birth_date,
    coalesce(p_insurance, ''), p_phone, coalesce(p_email, ''), p_slot_date, p_slot_time, p_variable_symbol
  );
  return p_id;
end $$;

-- Overenie objednávky (číslo + telefón); vracia len nevyhnutné polia
create or replace function lookup_order(p_id text, p_phone text)
returns jsonb
language sql security definer set search_path = public as $$
  select to_jsonb(x) from (
    select o.id, o.status, o.status_note, o.has_referral, o.exam_label,
           o.price, o.slot_date, o.slot_time
    from orders o
    where upper(o.id) = upper(p_id)
      and length(regexp_replace(p_phone, '\D', '', 'g')) >= 9
      and right(regexp_replace(o.phone, '\D', '', 'g'), 9)
        = right(regexp_replace(p_phone, '\D', '', 'g'), 9)
  ) x;
$$;

-- Zrušenie objednávky pacientom
create or replace function cancel_order(p_id text, p_phone text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare v_count int;
begin
  update orders o set status = 'rejected', status_note = 'Zrušené pacientom'
  where upper(o.id) = upper(p_id)
    and length(regexp_replace(p_phone, '\D', '', 'g')) >= 9
    and right(regexp_replace(o.phone, '\D', '', 'g'), 9)
      = right(regexp_replace(p_phone, '\D', '', 'g'), 9)
    and o.status in ('new', 'confirmed');
  get diagnostics v_count = row_count;
  return v_count > 0;
end $$;

revoke all on function get_booked_slots() from public;
revoke all on function create_order(text, text, text, numeric, boolean, text, text, text, text, date, text, text, text, date, time, text) from public;
revoke all on function lookup_order(text, text) from public;
revoke all on function cancel_order(text, text) from public;
grant execute on function get_booked_slots() to anon, authenticated;
grant execute on function create_order(text, text, text, numeric, boolean, text, text, text, text, date, text, text, text, date, time, text) to anon, authenticated;
grant execute on function lookup_order(text, text) to anon, authenticated;
grant execute on function cancel_order(text, text) to anon, authenticated;

-- Realtime notifikácie pre stránku pracoviska
alter publication supabase_realtime add table orders;
alter publication supabase_realtime add table open_slots;
