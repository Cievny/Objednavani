-- ============================================================
-- ADMIN USERS 001 — správa rolí priamo v aplikácii
--
-- Superadmin dostane v správe objednávok záložku „Používatelia":
-- vidí všetky kontá personálu a klikaním im prideľuje roly
-- (superadmin / sestra / lekár + meno lekára).
--
-- Kontá sa naďalej zakladajú v Supabase: Authentication → Users
-- → Invite user (verejná registrácia ostáva vypnutá). Rola sa
-- potom priradí už v aplikácii.
--
-- Funkcie sú SECURITY DEFINER s kontrolou my_role() = superadmin
-- — bežný personál ich zavolať nemôže.
-- ============================================================

-- zoznam kont: e-mail + rola (aj kontá bez roly, aby sa dali priradiť)
create or replace function list_staff()
returns table (email text, role text, doctor_name text)
language plpgsql security definer set search_path = public as $$
begin
  if my_role() <> 'superadmin' then
    raise exception 'Len superadmin môže spravovať používateľov.';
  end if;
  return query
    select u.email::text,
           coalesce(r.role, '')::text,
           coalesce(r.doctor_name, '')::text
    from auth.users u
    left join staff_roles r on r.user_id = u.id
    order by u.email;
end $$;

-- priradenie / zmena roly podľa e-mailu
create or replace function set_staff_role(p_email text, p_role text, p_doctor_name text default '')
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid;
  v_my_email text;
begin
  if my_role() <> 'superadmin' then
    raise exception 'Len superadmin môže spravovať používateľov.';
  end if;
  if p_role not in ('superadmin', 'sestra', 'lekar') then
    raise exception 'Neznáma rola.';
  end if;
  if p_role = 'lekar' and coalesce(trim(p_doctor_name), '') = '' then
    raise exception 'Pri role lekár vyberte meno lekára.';
  end if;

  select u.id into v_uid from auth.users u where lower(u.email) = lower(trim(p_email));
  if not found then
    raise exception 'Konto % neexistuje. Najprv ho pozvite v Supabase (Authentication → Users → Invite user).', p_email;
  end if;

  -- poistka proti odstaveniu samého seba
  select u.email into v_my_email from auth.users u where u.id = auth.uid();
  if lower(v_my_email) = lower(trim(p_email)) and p_role <> 'superadmin' then
    raise exception 'Nemôžete si odobrať vlastnú rolu superadmina.';
  end if;

  insert into staff_roles (user_id, role, doctor_name)
  values (v_uid, p_role, case when p_role = 'lekar' then trim(p_doctor_name) else '' end)
  on conflict (user_id) do update
    set role = excluded.role, doctor_name = excluded.doctor_name;
end $$;

-- odobratie roly (konto ostáva, ale do správy sa nedostane)
create or replace function remove_staff_role(p_email text)
returns void
language plpgsql security definer set search_path = public as $$
declare v_my_email text;
begin
  if my_role() <> 'superadmin' then
    raise exception 'Len superadmin môže spravovať používateľov.';
  end if;
  select u.email into v_my_email from auth.users u where u.id = auth.uid();
  if lower(v_my_email) = lower(trim(p_email)) then
    raise exception 'Nemôžete odobrať rolu sám sebe.';
  end if;
  delete from staff_roles
  where user_id = (select id from auth.users where lower(email) = lower(trim(p_email)));
end $$;

revoke all on function list_staff() from public, anon;
revoke all on function set_staff_role(text, text, text) from public, anon;
revoke all on function remove_staff_role(text) from public, anon;
grant execute on function list_staff() to authenticated;
grant execute on function set_staff_role(text, text, text) to authenticated;
grant execute on function remove_staff_role(text) to authenticated;

-- ============================================================
-- JEDNORAZOVO (bootstrap): prvý superadmin sa musí priradiť tu,
-- v aplikácii to potom už robíte klikaním.
--
--   insert into staff_roles (user_id, role)
--   select id, 'superadmin' from auth.users where email = 'lukas.vincze@nusch.sk'
--   on conflict (user_id) do update set role = 'superadmin';
-- ============================================================
