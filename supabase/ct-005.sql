-- ============================================================
-- CT 005 — povinná žiadanka (príloha) pri CT objednávke
--
-- Každá CT objednávka musí mať aspoň jednu prílohu (žiadanku).
-- Serverová poistka BEFORE INSERT (frontend to kontroluje tiež).
-- Bez kľúčov. Idempotentné. Spúšťať PO ct-003.
-- ============================================================

create or replace function ct_require_attachment()
returns trigger
language plpgsql set search_path = public as $$
begin
  if jsonb_array_length(coalesce(NEW.attachments, '[]'::jsonb)) = 0 then
    raise exception 'Pri objednávke na CT je potrebné priložiť žiadanku (výmenný lístok).';
  end if;
  return NEW;
end $$;

drop trigger if exists ct_orders_require_attachment on ct_orders;
create trigger ct_orders_require_attachment
before insert on ct_orders
for each row execute function ct_require_attachment();

-- ============================================================
