-- ============================================================
-- KONZULTACIE-004 (25. 11. 2026) — „Pozvať k nám" → žiadosť na pracovný e-mail lekára
--
-- Keď lekár pri žiadosti rozhodne „Pozvať k nám (ústav)", môže si celú
-- žiadosť nechať poslať na pracovný e-mail, aby mal podľa čoho pacienta
-- objednať (zo systému sa žiadosť vybavením maže).
--
--  • Adresa sa nastavuje výslovne: správa → Konzultácie → „Upozornenia
--    e-mailom" → „Pracovný e-mail lekára" (settings.consult_forward_email).
--    Bez nastavenej adresy sa nič neprepošle — systém adresu neháda
--    (nepoužije prihlasovací e-mail ani adresy pracoviska).
--  • E-mail obsahuje: iniciály, rok narodenia, kraj, kontakt, odpovede
--    z dotazníka, vlastný popis, návrh zaradenia a odpoveď pacientovi.
--    POZOR: sú to zdravotné údaje — kópia v pošte už nepodlieha
--    automatickému mazaniu zo systému.
--  • Len pri rozhodnutí „ustav" a len pri prvom vybavení (pri opakovanom
--    odoslaní neodoslanej odpovede sú údaje už zmazané).
--  • Pacient je o tom informovaný v súhlase, na stránke o ochrane údajov
--    a v pätičke e-mailu s odpoveďou.
--
-- Idempotentné. Spúšťať PO konzultacie-002.sql (na konzultacie-003 nezávisí).
-- ============================================================

do $$
begin
  if to_regprocedure('consult_finalize()') is null or to_regclass('public.consult_stats') is null then
    raise exception 'KONZULTACIE-004: najprv spustite konzultacie-002.sql (projekt „USG objednavanie").';
  end if;
end $$;

drop function if exists consult_resolve(text, text, text, boolean);

create or replace function consult_resolve(p_id text, p_outcome text, p_reply text default '', p_send boolean default false,
                                           p_forward boolean default false, p_summary text default '')
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c consult_requests%rowtype; v_reply text := btrim(coalesce(p_reply, '')); v_summary text := btrim(coalesce(p_summary, ''));
  v_sms text; v_req bigint; v_app_id text; v_app_tok text; v_key text; v_from text;
  v_fwd text; v_fwd_to jsonb; v_do_fwd boolean := false; v_will_send boolean; v_year int;
begin
  if my_role() not in ('superadmin', 'lekar') or not mfa_ok() then raise exception 'Odpovedať na konzultácie môže len lekár.'; end if;
  if coalesce(p_outcome, '') not in ('ustav', 'angiolog', 'obvodny', 'akutne', 'ine') then raise exception 'Vyberte rozhodnutie.'; end if;
  if length(v_reply) > 2000 or length(v_summary) > 6000 then raise exception 'Text je príliš dlhý.'; end if;
  select * into c from consult_requests where id = p_id for update;
  if not found then raise exception 'Žiadosť sa nenašla (už bola vybavená a zmazaná).'; end if;
  if c.status = 'sending' then raise exception 'Odpoveď na túto žiadosť sa práve odosiela.'; end if;
  v_will_send := p_send is true and c.contact_type in ('sms', 'email');

  -- preposlanie na pracovný e-mail lekára: len „pozvať k nám", len na výslovne nastavenú adresu,
  -- len kým žiadosť ešte má údaje (stav new)
  if p_forward is true then
    if p_outcome <> 'ustav' then raise exception 'Na pracovný e-mail sa posiela len žiadosť, pri ktorej odporúčate návštevu u nás.'; end if;
    if c.status = 'new' then
      select nullif(btrim(value), '') into v_fwd from settings where key = 'consult_forward_email';
      select jsonb_agg(distinct a) into v_fwd_to
        from (select lower(btrim(x)) as a from unnest(string_to_array(coalesce(v_fwd, ''), ',')) x) s
        where a ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$';
      if v_fwd_to is null then
        raise exception 'Nie je nastavený pracovný e-mail lekára (správa → Konzultácie → Upozornenia e-mailom).';
      end if;
      v_do_fwd := true;
    end if;
  end if;

  if v_will_send or v_do_fwd then
    select value into v_from from settings where key = 'mail_from';
    if coalesce(v_from, '') = '' then v_from := 'NÚSCH Objednávanie <onboarding@resend.dev>'; end if;
  end if;
  if v_do_fwd or (v_will_send and c.contact_type = 'email') then
    v_key := app_secret('resend_api_key');
    if v_key like 'SEM\_%' then raise exception 'E-mailová služba nie je nastavená — správa sa nedá odoslať.'; end if;
  end if;

  if v_will_send then
    if length(v_reply) < 10 then raise exception 'Napíšte odpoveď pacientovi.'; end if;
    if c.contact_type = 'sms' then
      v_app_id := app_secret('bulkgate_app_id'); v_app_tok := app_secret('bulkgate_app_token');
      if v_app_id like 'SEM\_%' or v_app_tok like 'SEM\_%' then raise exception 'SMS brána nie je nastavená — odpoveď sa nedá odoslať.'; end if;
      v_sms := 'NUSCH: ' || sms_plain(v_reply);
      if length(v_sms) > 459 then raise exception 'SMS je príliš dlhá (% znakov, najviac 450). Skráťte ju.', length(v_sms) - 7; end if;
      select net.http_post(
        url := 'https://portal.bulkgate.com/api/1.0/simple/transactional',
        headers := jsonb_build_object('Content-Type', 'application/json'),
        body := jsonb_build_object('application_id', v_app_id, 'application_token', v_app_tok,
          'number', ltrim(c.contact, '+'), 'text', v_sms, 'unicode', false, 'sender_id', 'gText', 'sender_id_value', 'NUSCH')) into v_req;
    else
      select net.http_post(
        url := 'https://api.resend.com/emails',
        headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
        body := jsonb_build_object('from', v_from, 'to', jsonb_build_array(c.contact),
          'subject', 'Odpoveď na vašu žiadosť o konzultáciu — NÚSCH',
          'html', '<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#0f172a">' || email_header()
            || '<h2 style="color:#003d7c">Odpoveď na vašu žiadosť o konzultáciu</h2>'
            || '<p style="font-size:15px;line-height:1.5">' || replace(html_escape(v_reply), E'\n', '<br>') || '</p>'
            || '<p style="font-size:12px;color:#64748b;margin-top:18px;border-top:1px solid #e2e8f0;padding-top:10px">Odpoveď vychádza len z údajov, ktoré ste uviedli vo formulári, a nenahrádza lekárske vyšetrenie. '
            || 'Pri náhlom zhoršení stavu volajte 155. '
            || case when v_do_fwd then 'Údaje z vášho dotazníka zo systému po odoslaní tejto odpovede mažeme; keďže vám odporúčame vyšetrenie u nás, lekár si žiadosť ponechá na účely objednania.'
                    else 'Údaje z vášho dotazníka po odoslaní tejto odpovede mažeme.' end
            || '</p></div>')) into v_req;
    end if;
  end if;

  -- kópia celej žiadosti lekárovi (pred zmazaním údajov)
  if v_do_fwd then
    v_year := extract(year from (now() at time zone 'Europe/Bratislava'))::int;
    perform net.http_post(
      url := 'https://api.resend.com/emails',
      headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
      body := jsonb_build_object('from', v_from, 'to', v_fwd_to,
        'subject', 'Konzultácia ' || c.id || ' — odporučené vyšetrenie u nás',
        'html', '<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#0f172a">'
          || '<h2 style="color:#003d7c">Konzultácia ' || html_escape(c.id) || ' — odporučené vyšetrenie u nás</h2>'
          || '<table style="font-size:15px;line-height:1.5;border-collapse:collapse">'
          || '<tr><td style="color:#64748b;padding:2px 14px 2px 0">Pacient</td><td><b>' || html_escape(c.initials) || '</b>, nar. ' || c.birth_year
          || ' (' || (v_year - c.birth_year) || ' r.)' || case when c.region <> '' then ' · ' || html_escape(c.region) || ' kraj' else '' end || '</td></tr>'
          || '<tr><td style="color:#64748b;padding:2px 14px 2px 0">Kontakt</td><td><b>'
          || case c.contact_type when 'sms' then 'mobil ' when 'email' then 'e-mail ' else 'Instagram @' end || html_escape(c.contact) || '</b></td></tr>'
          || '<tr><td style="color:#64748b;padding:2px 14px 2px 0">Prijaté</td><td>' || to_char(c.created_at at time zone 'Europe/Bratislava', 'DD.MM.YYYY HH24:MI') || '</td></tr></table>'
          || '<h3 style="color:#003d7c;margin:16px 0 4px">Dotazník</h3><p style="font-size:14px;line-height:1.55;margin:0">'
          || case when v_summary <> '' then replace(html_escape(v_summary), E'\n', '<br>')
                  else 'Téma: ' || html_escape(c.topic) || '<br>Odpovede: ' || html_escape(c.answers::text)
                       || case when jsonb_array_length(c.flags) > 0 then '<br>Akútne príznaky: ' || html_escape(c.flags::text) else '' end end || '</p>'
          || '<h3 style="color:#003d7c;margin:16px 0 4px">Vlastnými slovami</h3><p style="font-size:14px;line-height:1.55;margin:0">'
          || case when c.note <> '' then replace(html_escape(c.note), E'\n', '<br>') else '— bez popisu —' end || '</p>'
          || '<h3 style="color:#003d7c;margin:16px 0 4px">Odpoveď pacientovi</h3><p style="font-size:14px;line-height:1.55;margin:0">'
          || case when v_reply <> '' then replace(html_escape(v_reply), E'\n', '<br>') else '— bez textu —' end || '<br><span style="color:#64748b">'
          || case when v_will_send then 'Odoslaná zo systému ' || case c.contact_type when 'sms' then 'ako SMS.' else 'e-mailom.' end
                  when c.contact_type = 'instagram' then 'Zo systému neodoslaná — odpovedá sa na Instagrame.' else 'Zo systému neodoslaná.' end || '</span></p>'
          || '<p style="font-size:12px;color:#64748b;margin-top:18px;border-top:1px solid #e2e8f0;padding-top:10px">Táto správa obsahuje zdravotné údaje. '
          || 'Zo systému objednávania bola žiadosť vybavením vymazaná; táto kópia slúži na objednanie pacienta a už nepodlieha automatickému mazaniu.</p></div>'));
  end if;

  if v_will_send then
    -- zdravotné údaje preč hneď; kontakt a text odpovede len do potvrdenia brány (consult_finalize)
    update consult_requests set status = 'sending', outcome = p_outcome, reply_text = v_reply, send_req = v_req, sent_at = now(), send_error = '',
      initials = '', birth_year = 0, region = '', answers = '{}'::jsonb, flags = '[]'::jsonb, note = ''
    where id = c.id;
    return jsonb_build_object('ok', true, 'sent', c.contact_type, 'forwarded', v_do_fwd);
  end if;

  -- bez odoslania zo systému (Instagram, alebo lekár odpovedal inak): zmazať hneď
  insert into consult_stats (topic, outcome, channel, reply_sent, wait_days)
  values (c.topic, p_outcome, c.contact_type, false, greatest(0, extract(day from now() - c.created_at)::int));
  delete from consult_requests where id = c.id;
  return jsonb_build_object('ok', true, 'sent', null, 'forwarded', v_do_fwd);
end $$;
revoke all on function consult_resolve(text, text, text, boolean, boolean, text) from public, anon;
grant execute on function consult_resolve(text, text, text, boolean, boolean, text) to authenticated;

notify pgrst, 'reload schema';

-- ------------------------------------------------------------
-- kontrola
-- ------------------------------------------------------------
do $$
begin
  if to_regprocedure('consult_resolve(text,text,text,boolean)') is not null then
    raise exception 'KONZULTACIE-004: stará funkcia ostala.';
  end if;
  if has_function_privilege('anon', 'consult_resolve(text,text,text,boolean,boolean,text)', 'execute')
     or not has_function_privilege('authenticated', 'consult_resolve(text,text,text,boolean,boolean,text)', 'execute') then
    raise exception 'KONZULTACIE-004: oprávnenia funkcie nie sú správne.';
  end if;
  raise notice 'KONZULTACIE-004 OK.';
end $$;

-- výsledok (SQL editor ukáže tento riadok)
select 'KONZULTACIE-004 OK' as vysledok,
       case when exists (select 1 from settings where key = 'consult_forward_email' and btrim(value) <> '')
            then 'pracovný e-mail je nastavený' else 'pracovný e-mail ešte nastavte v správe → Konzultácie → Upozornenia e-mailom' end as pracovny_email;
