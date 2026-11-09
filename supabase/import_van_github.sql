-- =====================================================================
-- Missies automatisch ophalen uit missies.json in de GitHub-repository.
-- De database downloadt het bestand zelf; de inhoud komt nergens in beeld.
-- Aanroepen: select public.ververs_missies();   (geeft alleen aantallen terug)
-- =====================================================================

-- Eén missie-object netjes maken: Engelse veldnamen vertalen, base64-velden decoderen.
create or replace function geheim.normaliseer(e jsonb) returns jsonb
language plpgsql immutable set search_path = public as $$
declare uit jsonb := '{}'; k text; v jsonb; sleutel text; t text; d text;
begin
  for k, v in select * from jsonb_each(e) loop
    sleutel := case lower(k)
      when 'text' then 'tekst' when 'mission' then 'tekst' when 'missie' then 'tekst'
      when 'explanation' then 'uitleg' when 'category' then 'categorie' when 'family' then 'familie'
      when 'difficulty' then 'moeilijkheid' when 'theme' then 'thema' when 'target' then 'doelwit'
      when 'requires' then 'vereist' when 'age' then 'leeftijd' else lower(k) end;
    if jsonb_typeof(v) = 'string' and sleutel in ('tekst', 'uitleg') then
      t := v #>> '{}';
      if t !~ '\s' and length(t) >= 8 and t ~ '^[A-Za-z0-9+/=_-]+$' then
        begin
          d := convert_from(decode(translate(t, '-_', '+/'), 'base64'), 'UTF8');
          if d ~ '\s' then v := to_jsonb(d); end if;
        exception when others then null;
        end;
      end if;
    end if;
    uit := uit || jsonb_build_object(sleutel, v);
  end loop;
  return uit;
end $$;

-- De inhoud van missies.json (als tekst) importeren. Vervangt de bestaande missies.
create or replace function geheim.importeer_tekst(p_inhoud text) returns json
language plpgsql security definer set search_path = public as $$
declare d jsonb; lijst jsonb; woorden jsonb; tok text;
begin
  begin
    d := p_inhoud::jsonb;
  exception when others then
    d := convert_from(decode(regexp_replace(p_inhoud, '\s', '', 'g'), 'base64'), 'UTF8')::jsonb;
  end;
  if jsonb_typeof(d) = 'string' then
    d := convert_from(decode(d #>> '{}', 'base64'), 'UTF8')::jsonb;
  end if;
  if jsonb_typeof(d) = 'array' then
    lijst := d;
  else
    lijst := coalesce(d->'missies', d->'missions', d->'items');
    woorden := coalesce(d->'woorden', d->'words', d->'woordenlijst');
  end if;
  if lijst is null or jsonb_typeof(lijst) <> 'array' then raise exception 'geen_lijst_met_missies'; end if;
  select coalesce(jsonb_agg(geheim.normaliseer(x)), '[]') into lijst from jsonb_array_elements(lijst) x;
  if woorden is not null and jsonb_typeof(woorden) = 'array' then
    select coalesce(jsonb_agg(to_jsonb(coalesce(
             (geheim.normaliseer(jsonb_build_object('tekst', w)))->>'tekst', w #>> '{}'))), '[]')
      into woorden from jsonb_array_elements(woorden) w;
  end if;
  select waarde into tok from geheim.config where sleutel = 'beheer_token';
  return public.beheer_import(tok, lijst, woorden, true);
end $$;

-- Ophalen van GitHub (Pages) en importeren. Iedereen mag dit aanroepen:
-- het haalt alleen het vaste bestand op en geeft alleen aantallen terug.
create or replace function public.ververs_missies() returns json
language plpgsql security definer set search_path = public, extensions as $$
declare r record; v_url text := 'https://raw.githubusercontent.com/barryselim-code/laat-je-niet-ontdekken/main/missies.json';
        v_res json;
begin
  select * into r from extensions.http_get(v_url || '?t=' || extract(epoch from now())::bigint);
  if r.status <> 200 then raise exception 'download_mislukt (status %)', r.status; end if;
  v_res := geheim.importeer_tekst(r.content);
  return json_build_object('geimporteerd', v_res->'geimporteerd',
                           'overgeslagen', json_array_length(v_res->'fouten'),
                           'redenen', (select coalesce(json_agg(distinct f->>'reden'), '[]') from json_array_elements(v_res->'fouten') f),
                           'overzicht', v_res->'overzicht');
end $$;

revoke execute on function geheim.normaliseer(jsonb), geheim.importeer_tekst(text) from public, anon, authenticated;
revoke execute on function public.ververs_missies() from public;
grant execute on function public.ververs_missies() to anon, authenticated;
