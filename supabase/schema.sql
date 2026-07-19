-- ============================================================
-- Návrh databázovej schémy pre Supabase (Postgres)
-- Objednávanie pacientov na USG — NÚSCH, a.s.
--
-- Toto je pripravený návrh; appka zatiaľ beží na localStorage.
-- Po vytvorení Supabase projektu spustite tento skript v SQL
-- editore a dátovú vrstvu v src/booking.jsx (useBookingData)
-- vymeňte za volania supabase-js.
-- ============================================================

-- Cenník vyšetrení (samoplatca / doplatok so žiadankou)
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

-- Objednávky pacientov
create table orders (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  status text not null default 'new'
    check (status in ('new', 'confirmed', 'rejected', 'done', 'noshow')),
  status_note text not null default '',
  has_referral boolean not null,
  exam_type_id text not null references pricelist (id),
  exam_label text not null,          -- kópia názvu v čase objednania
  price numeric(8, 2) not null,      -- kópia ceny v čase objednania
  reason text not null,
  referrer_name text not null default '',
  referrer_facility text not null default '',
  patient_name text not null,
  birth_number text not null,
  insurance text not null,
  phone text not null,
  email text not null default '',
  slot_date date not null,
  slot_time time not null,
  variable_symbol text not null,
  paid_at timestamptz
);

-- Jeden aktívny pacient na termín (zamietnuté objednávky termín uvoľnia)
create unique index orders_slot_unique
  on orders (slot_date, slot_time)
  where status <> 'rejected';

-- Nastavenia platby
create table settings (
  key text primary key,
  value text not null
);
insert into settings (key, value) values
  ('iban', 'SK__ DOPLŇTE __'),
  ('beneficiary', 'NÚSCH, a.s.');

-- ============================================================
-- Row Level Security (náčrt)
--
-- Pacient (anonymný klient):
--   - open_slots: SELECT
--   - orders: INSERT (a SELECT len vlastnej objednávky cez RPC/token)
--   - pricelist: SELECT (active = true)
-- Pracovisko (prihlásený používateľ cez Supabase Auth):
--   - všetko: SELECT / UPDATE / INSERT / DELETE
--
-- Vloženie objednávky riešte cez Postgres funkciu (rpc), ktorá
-- overí, že termín je v open_slots a nie je obsadený — unikátny
-- index vyššie zachytí súbeh dvoch pacientov o ten istý čas.
-- ============================================================

alter table pricelist enable row level security;
alter table open_slots enable row level security;
alter table orders enable row level security;
alter table settings enable row level security;

create policy "pricelist verejne citanie" on pricelist
  for select using (active = true);

create policy "sloty verejne citanie" on open_slots
  for select using (true);

create policy "objednavku moze vlozit ktokolvek" on orders
  for insert with check (true);

create policy "plny pristup pre prihlasenych" on orders
  for all using (auth.role() = 'authenticated');

create policy "sloty spravuje prihlaseny" on open_slots
  for all using (auth.role() = 'authenticated');

create policy "cennik spravuje prihlaseny" on pricelist
  for all using (auth.role() = 'authenticated');

create policy "nastavenia cita a spravuje prihlaseny" on settings
  for all using (auth.role() = 'authenticated');
