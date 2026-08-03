-- ============================================================
-- USG ŽIADANKA 001 — povinná príloha pri objednávke so žiadankou
--
-- Ak pacient objednáva so žiadankou (has_referral = true), musí
-- priložiť aspoň jeden súbor (odfotenú/naskenovanú žiadanku).
-- Serverová poistka (frontend to kontroluje tiež). Rieši sa
-- BEFORE INSERT triggerom — netreba meniť create_order.
--
-- Bez kľúčov. Idempotentné.
-- ============================================================

create or replace function orders_require_referral_attachment()
returns trigger
language plpgsql set search_path = public as $$
begin
  if NEW.has_referral
     and jsonb_array_length(coalesce(NEW.attachments, '[]'::jsonb)) = 0 then
    raise exception 'Pri objednávke so žiadankou je potrebné priložiť žiadanku (výmenný lístok).';
  end if;
  return NEW;
end $$;

drop trigger if exists orders_require_referral on orders;
create trigger orders_require_referral
before insert on orders
for each row execute function orders_require_referral_attachment();

-- Diagnostika: objednávka so žiadankou bez prílohy cez create_order
-- musí zlyhať s hláškou vyššie.
-- ============================================================
