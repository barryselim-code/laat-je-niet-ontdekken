-- =====================================================================
-- Onthulling met twee stemrondes (design 9 nov 2026)
--  Ronde 1: "Heeft X dit echt gedaan?"  Ja / Nee / Weet niet.
--           Meer nee dan ja = missiepunten vervallen.
--  Ronde 2: per afgewezen beschuldiging: "Raakte de beschuldiging de kern?"
--           Meer ja dan nee = alsnog ontmaskerd; de beschuldigers krijgen dan
--           alsnog de punten van een terechte beschuldiging (+2 / +1).
--  De speler over wie het gaat stemt niet.
-- =====================================================================

create table if not exists public.stemrondes (
  id               uuid primary key default gen_random_uuid(),
  sessie_id        uuid not null references public.sessies(id) on delete cascade,
  speler_id        uuid not null references public.spelers(id) on delete cascade,
  beschuldiging_id uuid references public.beschuldigingen(id) on delete cascade,
  stemmer_id       uuid not null references public.spelers(id) on delete cascade,
  keuze            text not null check (keuze in ('ja','nee','weet'))
);
create unique index if not exists stemrondes_uniek on public.stemrondes
  (stemmer_id, speler_id, coalesce(beschuldiging_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index if not exists stemrondes_sessie on public.stemrondes(sessie_id);
alter table public.stemrondes enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'stemrondes' and policyname = 'lid_leest') then
    create policy lid_leest on public.stemrondes for select to authenticated using (public.is_lid(sessie_id));
  end if;
end $$;
revoke insert, update, delete, truncate on public.stemrondes from anon, authenticated;
revoke select on public.stemrondes from anon;
grant select on public.stemrondes to authenticated;
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'stemrondes') then
    alter publication supabase_realtime add table public.stemrondes;
  end if;
end $$;
-- (de oude tabel public.stemmen wordt niet meer gebruikt)

-- onthul_check: -1 = geen controle-stap; 0, 1, ... = welke afgewezen beschuldiging nu besproken wordt
alter table public.sessies add column if not exists onthul_check int not null default -1;
alter table public.beschuldigingen add column if not exists alsnog boolean not null default false;

-- Afgewezen beschuldigingen tegen een speler, in volgorde
create or replace function geheim.afgewezen_van(p_speler uuid) returns uuid[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(id order by aangemaakt), '{}') from public.beschuldigingen
   where beschuldigde_id = p_speler and status = 'afgewezen'
$$;

create or replace function public.onthul_stap(p_sessie uuid, p_vooruit boolean default true)
returns void language plpgsql security definer set search_path = public as $$
declare s public.sessies; n int; v_aw int; v_vorig_aw int;
begin
  perform geheim.eis_host(p_sessie);
  s := geheim.sessie_lock(p_sessie);
  if s.status <> 'onthulling' then raise exception 'geen_onthulling'; end if;
  n := coalesce(array_length(s.onthul_volgorde, 1), 0);
  if n = 0 then return; end if;
  v_aw := coalesce(array_length(geheim.afgewezen_van(s.onthul_volgorde[s.onthul_index + 1]), 1), 0);
  if p_vooruit then
    if s.onthul_stap = 'naam' then
      update public.sessies set onthul_stap = 'missie', onthul_check = -1 where id = p_sessie;
    elsif s.onthul_check < v_aw - 1 then
      update public.sessies set onthul_check = onthul_check + 1 where id = p_sessie;
    elsif s.onthul_index < n - 1 then
      update public.sessies set onthul_stap = 'naam', onthul_check = -1, onthul_index = onthul_index + 1 where id = p_sessie;
    end if;
  else
    if s.onthul_stap = 'missie' and s.onthul_check >= 0 then
      update public.sessies set onthul_check = onthul_check - 1 where id = p_sessie;
    elsif s.onthul_stap = 'missie' then
      update public.sessies set onthul_stap = 'naam' where id = p_sessie;
    elsif s.onthul_index > 0 then
      v_vorig_aw := coalesce(array_length(geheim.afgewezen_van(s.onthul_volgorde[s.onthul_index]), 1), 0);
      update public.sessies
         set onthul_index = onthul_index - 1, onthul_stap = 'missie', onthul_check = v_vorig_aw - 1
       where id = p_sessie;
    end if;
  end if;
end $$;

create or replace function public.onthulling_data(p_sessie uuid)
returns json language plpgsql security definer set search_path = public as $$
declare s public.sessies;
begin
  perform geheim.mij(p_sessie);
  select * into s from public.sessies where id = p_sessie;
  if s.status not in ('onthulling', 'einde') then raise exception 'nog_geheim'; end if;
  return (
    select coalesce(json_agg(json_build_object(
      'speler_id', x.id,
      'naam', x.naam,
      'tekst', geheim.ontsleutel(t.tekst_enc),
      'uitleg', geheim.ontsleutel(t.uitleg_enc),
      'moeilijkheid', t.moeilijkheid,
      'voltooid', t.voltooid_op is not null,
      'voltooid_op', t.voltooid_op,
      'getuige', (select naam from public.spelers g where g.id = t.getuige_id),
      'ontmaskerd', x.ontmaskerd,
      'keer_verdacht', (select count(*) from public.beschuldigingen b where b.beschuldigde_id = x.id and b.status <> 'vervallen'),
      'afgewezen', (select coalesce(json_agg(json_build_object(
                        'id', b.id,
                        'door', (select coalesce(json_agg(e.naam order by d.tijdstip), '[]') from public.deelnames d
                                   join public.spelers e on e.id = d.speler_id where d.beschuldiging_id = b.id),
                        'op', b.aangemaakt, 'door_host', b.door_host, 'alsnog', b.alsnog)
                        order by b.aangemaakt), '[]'::json)
                      from public.beschuldigingen b
                     where b.beschuldigde_id = x.id and b.status = 'afgewezen')
    ) order by x.volgnr), '[]'::json)
    from public.spelers x join public.toewijzingen t on t.speler_id = x.id
    where x.sessie_id = p_sessie and not x.verwijderd
  );
end $$;

revoke execute on function public.stem(uuid, uuid, boolean) from public, anon, authenticated;
create or replace function public.stem(p_sessie uuid, p_speler uuid, p_keuze text, p_beschuldiging uuid default null)
returns void language plpgsql security definer set search_path = public as $$
declare v public.spelers; s public.sessies;
begin
  v := geheim.mij(p_sessie);
  select * into s from public.sessies where id = p_sessie;
  if s.status <> 'onthulling' then raise exception 'geen_onthulling'; end if;
  if p_keuze not in ('ja','nee','weet') then raise exception 'onbekende_keuze'; end if;
  if p_speler = v.id then raise exception 'jezelf'; end if;
  if not exists (select 1 from public.spelers where id = p_speler and sessie_id = p_sessie) then
    raise exception 'onbekende_speler';
  end if;
  if p_beschuldiging is not null and not exists (select 1 from public.beschuldigingen
       where id = p_beschuldiging and beschuldigde_id = p_speler and status = 'afgewezen') then
    raise exception 'onbekend';
  end if;
  insert into public.stemrondes (sessie_id, speler_id, beschuldiging_id, stemmer_id, keuze)
  values (p_sessie, p_speler, p_beschuldiging, v.id, p_keuze)
  on conflict (stemmer_id, speler_id, coalesce(beschuldiging_id, '00000000-0000-0000-0000-000000000000'::uuid))
  do update set keuze = excluded.keuze;
end $$;

create or replace function public.naar_scorebord(p_sessie uuid)
returns void language plpgsql security definer set search_path = public as $$
declare s public.sessies; b record;
begin
  perform geheim.eis_host(p_sessie);
  s := geheim.sessie_lock(p_sessie);
  if s.status <> 'onthulling' then raise exception 'geen_onthulling'; end if;

  -- Ronde 2: afgewezen beschuldigingen waarbij de tafel vindt dat het de kern raakte
  for b in select bb.* from public.beschuldigingen bb
            where bb.sessie_id = p_sessie and bb.status = 'afgewezen'
              and (select count(*) from public.stemrondes st where st.beschuldiging_id = bb.id and st.keuze = 'ja')
                > (select count(*) from public.stemrondes st where st.beschuldiging_id = bb.id and st.keuze = 'nee') loop
    update public.beschuldigingen set alsnog = true where id = b.id;
    update public.spelers set ontmaskerd = true, ontmaskerd_op = coalesce(ontmaskerd_op, now()) where id = b.beschuldigde_id;
    -- beschuldigers krijgen alsnog de punten van een terechte beschuldiging
    update public.spelers x
       set punten_beschuldiging = x.punten_beschuldiging - d.punten + (case d.rol when 'eerste' then 2 else 1 end)
      from public.deelnames d
     where d.beschuldiging_id = b.id and d.speler_id = x.id;
    update public.deelnames set punten = case rol when 'eerste' then 2 else 1 end where beschuldiging_id = b.id;
  end loop;

  -- Ronde 1: missie gehaald als voltooid, niet ontmaskerd en niet meer nee dan ja
  update public.spelers x
     set missie_gehaald = q.gehaald,
         missie_punten = case when q.gehaald then q.moeilijkheid else 0 end,
         eindscore = x.punten_beschuldiging + case when q.gehaald then q.moeilijkheid else 0 end
    from (
      select t.speler_id, t.moeilijkheid,
             (t.voltooid_op is not null and not sp.ontmaskerd
              and (select count(*) from public.stemrondes st where st.speler_id = t.speler_id and st.beschuldiging_id is null and st.keuze = 'nee')
                <= (select count(*) from public.stemrondes st where st.speler_id = t.speler_id and st.beschuldiging_id is null and st.keuze = 'ja')
             ) as gehaald
        from public.toewijzingen t join public.spelers sp on sp.id = t.speler_id
       where t.sessie_id = p_sessie
    ) q
   where q.speler_id = x.id;
  update public.spelers set eindscore = punten_beschuldiging, missie_gehaald = false, missie_punten = 0
   where sessie_id = p_sessie and eindscore is null;
  update public.sessies set status = 'einde' where id = p_sessie;
end $$;

revoke execute on function geheim.afgewezen_van(uuid) from public, anon, authenticated;
revoke execute on function public.stem(uuid, uuid, text, uuid) from public, anon;
grant execute on function public.stem(uuid, uuid, text, uuid) to authenticated;
