-- =====================================================================
-- Laat je niet ontdekken! – Supabase-database
-- Plak dit hele bestand in Supabase > SQL Editor > New query > Run.
-- Opnieuw uitvoeren is veilig: bestaande missies en sleutels blijven staan.
--
-- Geheimhouding:
--  * Missies staan in het schema "geheim", dat niet via de app-API bereikbaar is,
--    en de teksten zijn versleuteld (pgcrypto). Open die tabellen nooit.
--  * Spelers kunnen alleen via de functies hieronder bij hun eigen missie.
--  * Realtime stuurt alleen statussen, nooit missieteksten.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------
-- Geheim schema: missies, woorden, sleutels
-- ---------------------------------------------------------------------
create schema if not exists geheim;
revoke all on schema geheim from public;
revoke all on schema geheim from anon, authenticated;

create table if not exists geheim.config (
  sleutel text primary key,
  waarde  text not null
);
insert into geheim.config values ('sleutel', encode(extensions.gen_random_bytes(32), 'hex'))
  on conflict do nothing;
insert into geheim.config values ('beheer_token', encode(extensions.gen_random_bytes(9), 'hex'))
  on conflict do nothing;

create table if not exists geheim.missies (
  id            text primary key,
  tekst_enc     bytea not null,
  uitleg_enc    bytea,
  categorie     text not null default 'overig',
  familie       text,
  moeilijkheid  int  not null default 2 check (moeilijkheid between 1 and 3),
  thema         text not null default 'algemeen',
  doelwit       boolean not null default false,
  heeft_woord   boolean not null default false,
  vereist       text[] not null default '{}',
  leeftijd      text not null default 'iedereen',
  getal_min     int not null default 2,
  getal_max     int not null default 5,
  geimporteerd  timestamptz not null default now()
);

create table if not exists geheim.woorden (
  id        bigserial primary key,
  woord_enc bytea not null
);
alter table geheim.woorden add column if not exists thema text not null default 'algemeen';

revoke all on all tables in schema geheim from public, anon, authenticated;

create or replace function geheim.sleutel() returns text
language sql stable as $$ select waarde from geheim.config where sleutel = 'sleutel' $$;

create or replace function geheim.versleutel(t text) returns bytea
language sql stable as $$
  select case when t is null then null else extensions.pgp_sym_encrypt(t, geheim.sleutel()) end
$$;

create or replace function geheim.ontsleutel(b bytea) returns text
language sql stable as $$
  select case when b is null then null else extensions.pgp_sym_decrypt(b, geheim.sleutel()) end
$$;

-- ---------------------------------------------------------------------
-- Openbare tabellen (alleen lezen via RLS, schrijven alleen via functies)
-- ---------------------------------------------------------------------
create table if not exists public.sessies (
  id             uuid primary key default gen_random_uuid(),
  code           text not null unique,
  naam           text not null,
  thema          text not null default 'kerst',
  moeilijkheid   text not null default 'gemengd' check (moeilijkheid in ('makkelijk','gemengd','moeilijk')),
  context        text[] not null default '{}',
  punten_aan     boolean not null default true,
  status         text not null default 'lobby' check (status in ('lobby','spel','onthulling','einde')),
  host_id        uuid,
  gestart_op     timestamptz,
  beeindigd_op   timestamptz,
  onthul_volgorde uuid[] not null default '{}',
  onthul_index   int not null default 0,
  onthul_stap    text not null default 'naam' check (onthul_stap in ('naam','missie')),
  host_melding   text,
  aangemaakt     timestamptz not null default now(),
  verloopt       timestamptz not null default now() + interval '3 days'
);

create table if not exists public.spelers (
  id                   uuid primary key default gen_random_uuid(),
  sessie_id            uuid not null references public.sessies(id) on delete cascade,
  user_id              uuid not null,
  naam                 text not null,
  volgnr               int  not null,
  ontmaskerd           boolean not null default false,
  ontmaskerd_op        timestamptz,
  verwijderd           boolean not null default false,
  punten_beschuldiging int not null default 0,
  missie_punten        int,
  missie_gehaald       boolean,
  eindscore            int,
  aangemaakt           timestamptz not null default now()
);
create index if not exists spelers_sessie on public.spelers(sessie_id);
create index if not exists spelers_user on public.spelers(user_id);
create unique index if not exists spelers_naam_uniek on public.spelers(sessie_id, lower(naam)) where not verwijderd;

create table if not exists public.toewijzingen (
  speler_id         uuid primary key references public.spelers(id) on delete cascade,
  sessie_id         uuid not null references public.sessies(id) on delete cascade,
  missie_id         text not null,
  moeilijkheid      int  not null default 2,
  categorie         text,
  tekst_enc         bytea not null,
  uitleg_enc        bytea,
  doelwit_id        uuid,
  gewisseld         text[] not null default '{}',
  joker_gebruikt    boolean not null default false,
  joker_extra       boolean not null default false,
  gratis_wissel     boolean not null default false,
  eerste_toewijzing timestamptz not null default now(),
  toegewezen_op     timestamptz not null default now(),
  voltooid_op       timestamptz,
  getuige_id        uuid
);
create index if not exists toewijzingen_sessie on public.toewijzingen(sessie_id);

create table if not exists public.beschuldigingen (
  id                     uuid primary key default gen_random_uuid(),
  sessie_id              uuid not null references public.sessies(id) on delete cascade,
  beschuldigde_id        uuid not null references public.spelers(id) on delete cascade,
  eerste_beschuldiger_id uuid references public.spelers(id) on delete set null,
  aangemaakt             timestamptz not null default now(),
  laatste_meedoen        timestamptz not null default now(),
  status                 text not null default 'open' check (status in ('open','toegegeven','afgewezen','vervallen')),
  door_host              boolean not null default false,
  afgerond_op            timestamptz
);
create index if not exists beschuldigingen_sessie on public.beschuldigingen(sessie_id);
create unique index if not exists een_open_per_speler on public.beschuldigingen(beschuldigde_id) where status = 'open';

create table if not exists public.deelnames (
  beschuldiging_id uuid not null references public.beschuldigingen(id) on delete cascade,
  speler_id        uuid not null references public.spelers(id) on delete cascade,
  sessie_id        uuid not null references public.sessies(id) on delete cascade,
  rol              text not null check (rol in ('eerste','meedoener')),
  tijdstip         timestamptz not null default now(),
  punten           int not null default 0,
  primary key (beschuldiging_id, speler_id)
);
create index if not exists deelnames_sessie on public.deelnames(sessie_id);

create table if not exists public.stemmen (
  sessie_id  uuid not null references public.sessies(id) on delete cascade,
  speler_id  uuid not null references public.spelers(id) on delete cascade,
  stemmer_id uuid not null references public.spelers(id) on delete cascade,
  duim       boolean not null,
  primary key (speler_id, stemmer_id)
);
create index if not exists stemmen_sessie on public.stemmen(sessie_id);

create table if not exists public.overnames (
  id             uuid primary key default gen_random_uuid(),
  sessie_id      uuid not null references public.sessies(id) on delete cascade,
  speler_id      uuid not null references public.spelers(id) on delete cascade,
  nieuwe_user_id uuid not null,
  status         text not null default 'open' check (status in ('open','goed','geweigerd')),
  aangemaakt     timestamptz not null default now()
);
create index if not exists overnames_sessie on public.overnames(sessie_id);

-- Aanwezigheid (hartslag) staat apart, zodat hij geen realtime-ruis geeft.
create table if not exists public.aanwezig (
  speler_id     uuid primary key references public.spelers(id) on delete cascade,
  laatst_gezien timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Toegang
-- ---------------------------------------------------------------------
create or replace function public.is_lid(p_sessie uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.spelers
                 where sessie_id = p_sessie and user_id = auth.uid() and not verwijderd)
$$;

alter table public.sessies         enable row level security;
alter table public.spelers         enable row level security;
alter table public.toewijzingen    enable row level security;
alter table public.beschuldigingen enable row level security;
alter table public.deelnames       enable row level security;
alter table public.stemmen         enable row level security;
alter table public.overnames       enable row level security;
alter table public.aanwezig        enable row level security;

drop policy if exists lid_leest on public.sessies;
create policy lid_leest on public.sessies for select to authenticated using (public.is_lid(id));
drop policy if exists lid_leest on public.spelers;
create policy lid_leest on public.spelers for select to authenticated using (public.is_lid(sessie_id));
drop policy if exists lid_leest on public.beschuldigingen;
create policy lid_leest on public.beschuldigingen for select to authenticated using (public.is_lid(sessie_id));
drop policy if exists lid_leest on public.deelnames;
create policy lid_leest on public.deelnames for select to authenticated using (public.is_lid(sessie_id));
drop policy if exists lid_leest on public.stemmen;
create policy lid_leest on public.stemmen for select to authenticated using (public.is_lid(sessie_id));
drop policy if exists lid_leest on public.overnames;
create policy lid_leest on public.overnames for select to authenticated using (public.is_lid(sessie_id));
-- toewijzingen en aanwezig: geen policies = voor de app onleesbaar.

revoke insert, update, delete, truncate on public.sessies, public.spelers, public.toewijzingen,
  public.beschuldigingen, public.deelnames, public.stemmen, public.overnames, public.aanwezig
  from anon, authenticated;
revoke select on public.toewijzingen, public.aanwezig from anon, authenticated;
-- Expliciet leesrecht (RLS bepaalt welke rijen); nieuwe projecten geven dit niet altijd automatisch.
grant usage on schema public to anon, authenticated;
grant select on public.sessies, public.spelers, public.beschuldigingen, public.deelnames,
  public.stemmen, public.overnames to authenticated;
revoke select on public.sessies, public.spelers, public.beschuldigingen, public.deelnames,
  public.stemmen, public.overnames from anon;

-- Realtime: alleen tabellen zonder missieteksten
do $$
declare t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  foreach t in array array['sessies','spelers','beschuldigingen','deelnames','stemmen','overnames'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Hulpfuncties (niet aanroepbaar door de app)
-- ---------------------------------------------------------------------
create or replace function geheim.opruimen() returns void
language sql security definer set search_path = public as $$
  delete from public.sessies where verloopt < now();
$$;

create or replace function geheim.mij(p_sessie uuid) returns public.spelers
language plpgsql security definer set search_path = public as $$
declare v public.spelers;
begin
  select * into v from public.spelers
   where sessie_id = p_sessie and user_id = auth.uid() and not verwijderd;
  if not found then raise exception 'geen_speler'; end if;
  return v;
end $$;

create or replace function geheim.sessie_lock(p_sessie uuid) returns public.sessies
language plpgsql security definer set search_path = public as $$
declare s public.sessies;
begin
  select * into s from public.sessies where id = p_sessie for update;
  if not found then raise exception 'sessie_onbekend'; end if;
  return s;
end $$;

create or replace function geheim.eis_host(p_sessie uuid) returns public.spelers
language plpgsql security definer set search_path = public as $$
declare v public.spelers; s public.sessies;
begin
  v := geheim.mij(p_sessie);
  select * into s from public.sessies where id = p_sessie;
  if s.host_id is distinct from v.id then raise exception 'niet_host'; end if;
  return v;
end $$;

create or replace function geheim.nieuwe_code() returns text
language plpgsql as $$
declare abc text := 'ABCDEFGHJKMNPQRSTUVWXYZ'; c text; i int;
begin
  loop
    c := '';
    for i in 1..4 loop
      c := c || substr(abc, 1 + floor(random() * length(abc))::int, 1);
    end loop;
    exit when not exists (select 1 from public.sessies where code = c);
  end loop;
  return c;
end $$;

-- Missie kiezen en invullen voor één speler. De sessie moet al vergrendeld zijn.
create or replace function geheim.wijs_toe(p_speler uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  sp public.spelers; s public.sessies; m geheim.missies;
  v_levels int[]; v_kids boolean; v_used text[]; v_fams text[]; v_andere int;
  v_stage int; v_doelwit uuid; v_doelwitnaam text; v_woord text; v_getal int;
  v_tekst text; v_uitleg text; v_oud public.toewijzingen;
begin
  select * into sp from public.spelers where id = p_speler;
  select * into s from public.sessies where id = sp.sessie_id;
  select * into v_oud from public.toewijzingen where speler_id = p_speler;

  v_levels := case s.moeilijkheid when 'makkelijk' then array[1,2]
                                  when 'moeilijk'  then array[2,3]
                                  else array[1,2,3] end;
  v_kids := 'kinderen' = any(s.context);

  select coalesce(array_agg(x), '{}') into v_used from (
    select t.missie_id as x from public.toewijzingen t where t.sessie_id = s.id
    union select unnest(t.gewisseld) from public.toewijzingen t where t.sessie_id = s.id
  ) q;
  select coalesce(array_agg(distinct mi.familie), '{}') into v_fams
    from geheim.missies mi where mi.id = any(v_used) and mi.familie is not null;

  select count(*) into v_andere from public.spelers
   where sessie_id = s.id and id <> p_speler and not verwijderd;

  v_stage := 0;
  loop
    v_stage := v_stage + 1;
    exit when v_stage > 3;
    with cat as (
      select t.categorie, count(*) c
        from public.toewijzingen t join public.spelers x on x.id = t.speler_id
       where t.sessie_id = s.id and t.speler_id <> p_speler and not x.verwijderd
       group by t.categorie
    )
    select mi.* into m
      from geheim.missies mi left join cat on cat.categorie = mi.categorie
     where not (mi.id = any(v_used))
       and (mi.familie is null or not (mi.familie = any(v_fams)))
       and (v_stage >= 3 or mi.thema in (s.thema, 'algemeen'))
       and (v_stage >= 2 or mi.moeilijkheid = any(v_levels))
       and (mi.leeftijd <> '18+' or not v_kids)
       and (mi.leeftijd <> 'kids' or v_kids)
       and mi.vereist <@ s.context
       and (not mi.doelwit or v_andere > 0)
       and (not mi.heeft_woord or exists (select 1 from geheim.woorden))
     order by coalesce(cat.c, 0), random()
     limit 1;
    exit when m.id is not null;
  end loop;

  if m.id is null then
    update public.sessies set host_melding = 'De missies zijn op. Niet iedereen kon een (nieuwe) missie krijgen.'
     where id = s.id;
    raise exception 'pool_op';
  end if;
  if v_stage > 1 then
    update public.sessies set host_melding = 'Er waren weinig missies over, dus de filters zijn versoepeld'
      || case when v_stage = 2 then ' (moeilijkheid).' else ' (moeilijkheid en thema).' end
     where id = s.id;
  end if;

  v_tekst := geheim.ontsleutel(m.tekst_enc);
  v_uitleg := geheim.ontsleutel(m.uitleg_enc);

  if m.doelwit then
    select x.id, x.naam into v_doelwit, v_doelwitnaam
      from public.spelers x
     where x.sessie_id = s.id and x.id <> p_speler and not x.verwijderd
     order by (select count(*) from public.toewijzingen t
                where t.sessie_id = s.id and t.doelwit_id = x.id and t.speler_id <> p_speler) >= 2,
              (select count(*) from public.toewijzingen t
                where t.sessie_id = s.id and t.doelwit_id = x.id and t.speler_id <> p_speler),
              random()
     limit 1;
    v_tekst := replace(v_tekst, '{doelwit}', v_doelwitnaam);
    v_uitleg := replace(v_uitleg, '{doelwit}', v_doelwitnaam);
  end if;

  if m.heeft_woord then
    -- woord uit de lijst van het thema van de missie (anders uit alle lijsten)
    select geheim.ontsleutel(w.woord_enc) into v_woord from geheim.woorden w
     order by (w.thema = m.thema) desc, random() limit 1;
    v_tekst := replace(v_tekst, '{woord}', v_woord);
    v_uitleg := replace(v_uitleg, '{woord}', v_woord);
  end if;

  v_getal := m.getal_min + floor(random() * (greatest(m.getal_max, m.getal_min) - m.getal_min + 1))::int;
  v_tekst := replace(v_tekst, '{getal}', v_getal::text);
  v_uitleg := replace(v_uitleg, '{getal}', v_getal::text);

  if v_oud.speler_id is null then
    insert into public.toewijzingen (speler_id, sessie_id, missie_id, moeilijkheid, categorie,
                                     tekst_enc, uitleg_enc, doelwit_id)
    values (p_speler, s.id, m.id, m.moeilijkheid, m.categorie,
            geheim.versleutel(v_tekst), geheim.versleutel(v_uitleg), v_doelwit);
  else
    update public.toewijzingen
       set gewisseld = gewisseld || v_oud.missie_id,
           missie_id = m.id, moeilijkheid = m.moeilijkheid, categorie = m.categorie,
           tekst_enc = geheim.versleutel(v_tekst), uitleg_enc = geheim.versleutel(v_uitleg),
           doelwit_id = v_doelwit, toegewezen_op = now(), voltooid_op = null, getuige_id = null
     where speler_id = p_speler;
  end if;
end $$;

-- Beschuldiging afsluiten met punten
create or replace function geheim.sluit_beschuldiging(p_id uuid, p_toegeven boolean, p_door_host boolean)
returns void language plpgsql security definer set search_path = public as $$
declare b public.beschuldigingen;
begin
  select * into b from public.beschuldigingen where id = p_id for update;
  if b.status <> 'open' then raise exception 'al_afgerond'; end if;

  update public.deelnames
     set punten = case when p_toegeven then (case rol when 'eerste' then 2 else 1 end)
                       else (case rol when 'eerste' then -2 else -1 end) end
   where beschuldiging_id = p_id;

  update public.spelers x
     set punten_beschuldiging = x.punten_beschuldiging + d.punten
    from public.deelnames d
   where d.beschuldiging_id = p_id and d.speler_id = x.id;

  if p_toegeven then
    update public.spelers set ontmaskerd = true, ontmaskerd_op = now() where id = b.beschuldigde_id;
  end if;

  update public.beschuldigingen
     set status = case when p_toegeven then 'toegegeven' else 'afgewezen' end,
         door_host = p_door_host, afgerond_op = now()
   where id = p_id;
end $$;

-- ---------------------------------------------------------------------
-- Functies voor de app (RPC)
-- ---------------------------------------------------------------------
create or replace function public.server_tijd() returns timestamptz
language sql stable as $$ select now() $$;

create or replace function public.maak_sessie(p_naam text, p_host_naam text, p_thema text default 'kerst',
  p_moeilijkheid text default 'gemengd', p_context text[] default '{}', p_punten boolean default true)
returns json language plpgsql security definer set search_path = public as $$
declare s public.sessies; v_speler uuid; v_naam text := left(trim(coalesce(p_host_naam, '')), 20);
begin
  if auth.uid() is null then raise exception 'niet_ingelogd'; end if;
  if v_naam = '' then raise exception 'naam_leeg'; end if;
  perform geheim.opruimen();
  insert into public.sessies (code, naam, thema, moeilijkheid, context, punten_aan)
  values (geheim.nieuwe_code(), coalesce(nullif(left(trim(p_naam), 40), ''), 'Laat je niet ontdekken!'),
          coalesce(nullif(lower(p_thema), ''), 'kerst'), coalesce(p_moeilijkheid, 'gemengd'),
          coalesce(p_context, '{}'), coalesce(p_punten, true))
  returning * into s;
  insert into public.spelers (sessie_id, user_id, naam, volgnr)
  values (s.id, auth.uid(), v_naam, 1) returning id into v_speler;
  update public.sessies set host_id = v_speler where id = s.id;
  insert into public.aanwezig values (v_speler, now());
  return json_build_object('sessie_id', s.id, 'code', s.code, 'speler_id', v_speler);
end $$;

-- p_keuze: null (eerste poging), 'nieuw' (andere naam met nummer), 'overname' (ik ben die speler)
create or replace function public.join_sessie(p_code text, p_naam text, p_keuze text default null)
returns json language plpgsql security definer set search_path = public as $$
declare s public.sessies; v_bestaand public.spelers; v_naam text; v_basis text; v_n int; v_id uuid; v_ov uuid;
begin
  if auth.uid() is null then raise exception 'niet_ingelogd'; end if;
  perform geheim.opruimen();
  select * into s from public.sessies where code = upper(trim(p_code)) for update;
  if not found then raise exception 'code_onbekend'; end if;

  select * into v_bestaand from public.spelers
   where sessie_id = s.id and user_id = auth.uid() and not verwijderd;
  if found then
    return json_build_object('status', 'ok', 'sessie_id', s.id, 'speler_id', v_bestaand.id);
  end if;

  if s.status not in ('lobby', 'spel') then raise exception 'sessie_gesloten'; end if;

  v_basis := left(regexp_replace(trim(coalesce(p_naam, '')), '\s+', ' ', 'g'), 20);
  if v_basis = '' then raise exception 'naam_leeg'; end if;

  select * into v_bestaand from public.spelers
   where sessie_id = s.id and lower(naam) = lower(v_basis) and not verwijderd;
  if found then
    if p_keuze is null then
      return json_build_object('status', 'naam_bestaat', 'naam', v_bestaand.naam);
    elsif p_keuze = 'overname' then
      update public.overnames set status = 'geweigerd'
       where speler_id = v_bestaand.id and status = 'open' and nieuwe_user_id <> auth.uid();
      select id into v_ov from public.overnames
       where speler_id = v_bestaand.id and nieuwe_user_id = auth.uid() and status = 'open';
      if v_ov is null then
        insert into public.overnames (sessie_id, speler_id, nieuwe_user_id)
        values (s.id, v_bestaand.id, auth.uid()) returning id into v_ov;
      end if;
      return json_build_object('status', 'overname_aangevraagd', 'overname_id', v_ov);
    end if;
  end if;

  if (select count(*) from public.spelers where sessie_id = s.id and not verwijderd) >= 20 then
    raise exception 'sessie_vol';
  end if;

  v_naam := v_basis; v_n := 1;
  while exists (select 1 from public.spelers where sessie_id = s.id and lower(naam) = lower(v_naam) and not verwijderd) loop
    v_n := v_n + 1;
    v_naam := left(v_basis, 17) || ' ' || v_n;
  end loop;

  insert into public.spelers (sessie_id, user_id, naam, volgnr)
  values (s.id, auth.uid(), v_naam,
          (select coalesce(max(volgnr), 0) + 1 from public.spelers where sessie_id = s.id))
  returning id into v_id;
  insert into public.aanwezig values (v_id, now()) on conflict (speler_id) do update set laatst_gezien = now();

  if s.status = 'spel' then
    perform geheim.wijs_toe(v_id);
  end if;
  return json_build_object('status', 'ok', 'sessie_id', s.id, 'speler_id', v_id, 'naam', v_naam);
end $$;

-- Nieuw toestel vraagt of de host de overname al heeft bevestigd
create or replace function public.overname_check(p_overname uuid)
returns json language plpgsql security definer set search_path = public as $$
declare o public.overnames;
begin
  select * into o from public.overnames where id = p_overname and nieuwe_user_id = auth.uid();
  if not found then raise exception 'onbekend'; end if;
  return json_build_object('status', o.status, 'sessie_id', o.sessie_id, 'speler_id', o.speler_id);
end $$;

create or replace function public.host_overname(p_overname uuid, p_akkoord boolean)
returns void language plpgsql security definer set search_path = public as $$
declare o public.overnames;
begin
  select * into o from public.overnames where id = p_overname for update;
  if not found or o.status <> 'open' then raise exception 'onbekend'; end if;
  perform geheim.eis_host(o.sessie_id);
  if p_akkoord then
    update public.spelers set user_id = o.nieuwe_user_id where id = o.speler_id;
    update public.overnames set status = 'goed' where id = o.id;
  else
    update public.overnames set status = 'geweigerd' where id = o.id;
  end if;
end $$;

create or replace function public.start_spel(p_sessie uuid)
returns void language plpgsql security definer set search_path = public as $$
declare s public.sessies; r record;
begin
  perform geheim.eis_host(p_sessie);
  s := geheim.sessie_lock(p_sessie);
  if s.status <> 'lobby' then raise exception 'al_gestart'; end if;
  if (select count(*) from public.spelers where sessie_id = s.id and not verwijderd) < 3 then
    raise exception 'te_weinig_spelers';
  end if;
  for r in select id from public.spelers where sessie_id = s.id and not verwijderd order by random() loop
    perform geheim.wijs_toe(r.id);
  end loop;
  update public.sessies set status = 'spel', gestart_op = now() where id = s.id;
end $$;

create or replace function public.mijn_missie(p_sessie uuid)
returns json language plpgsql security definer set search_path = public as $$
declare v public.spelers; t public.toewijzingen; s public.sessies;
begin
  v := geheim.mij(p_sessie);
  select * into s from public.sessies where id = p_sessie;
  select * into t from public.toewijzingen where speler_id = v.id;
  if not found then return json_build_object('heeft_missie', false); end if;
  return json_build_object(
    'heeft_missie', true,
    'tekst', geheim.ontsleutel(t.tekst_enc),
    'uitleg', geheim.ontsleutel(t.uitleg_enc),
    'moeilijkheid', t.moeilijkheid,
    'categorie', t.categorie,
    'voltooid', t.voltooid_op is not null,
    'voltooid_op', t.voltooid_op,
    'getuige_id', t.getuige_id,
    'ontmaskerd', v.ontmaskerd,
    'joker_gebruikt', t.joker_gebruikt,
    'joker_tot', t.eerste_toewijzing + interval '10 minutes',
    'joker_extra', t.joker_extra,
    'gratis_wissel', t.gratis_wissel
  );
end $$;

create or replace function public.gebruik_joker(p_sessie uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v public.spelers; t public.toewijzingen; s public.sessies;
begin
  v := geheim.mij(p_sessie);
  s := geheim.sessie_lock(p_sessie);
  if s.status <> 'spel' then raise exception 'spel_loopt_niet'; end if;
  if v.ontmaskerd then raise exception 'ontmaskerd'; end if;
  select * into t from public.toewijzingen where speler_id = v.id for update;
  if not found then raise exception 'geen_missie'; end if;
  if t.voltooid_op is not null then raise exception 'al_voltooid'; end if;

  if t.gratis_wissel then
    update public.toewijzingen set gratis_wissel = false where speler_id = v.id;
  elsif t.joker_extra then
    update public.toewijzingen set joker_extra = false, joker_gebruikt = true where speler_id = v.id;
  elsif not t.joker_gebruikt and now() <= t.eerste_toewijzing + interval '10 minutes' then
    update public.toewijzingen set joker_gebruikt = true where speler_id = v.id;
  else
    raise exception 'geen_joker';
  end if;
  perform geheim.wijs_toe(v.id);
end $$;

create or replace function public.markeer_voltooid(p_sessie uuid, p_getuige uuid default null, p_ongedaan boolean default false)
returns void language plpgsql security definer set search_path = public as $$
declare v public.spelers; s public.sessies;
begin
  v := geheim.mij(p_sessie);
  select * into s from public.sessies where id = p_sessie;
  if s.status <> 'spel' then raise exception 'spel_loopt_niet'; end if;
  if v.ontmaskerd then raise exception 'ontmaskerd'; end if;
  if p_getuige is not null and not exists (select 1 from public.spelers where id = p_getuige and sessie_id = p_sessie) then
    raise exception 'onbekende_speler';
  end if;
  if p_ongedaan then
    update public.toewijzingen set voltooid_op = null, getuige_id = null where speler_id = v.id;
  else
    update public.toewijzingen set voltooid_op = coalesce(voltooid_op, now()), getuige_id = p_getuige
     where speler_id = v.id;
  end if;
end $$;

-- Beschuldigen. Loopt er al een beschuldiging tegen deze speler, dan doe je mee.
create or replace function public.beschuldig(p_sessie uuid, p_beschuldigde uuid)
returns json language plpgsql security definer set search_path = public as $$
declare v public.spelers; s public.sessies; d public.spelers; b public.beschuldigingen;
begin
  v := geheim.mij(p_sessie);
  s := geheim.sessie_lock(p_sessie);
  if s.status <> 'spel' then raise exception 'spel_loopt_niet'; end if;
  select * into d from public.spelers where id = p_beschuldigde and sessie_id = p_sessie and not verwijderd;
  if not found then raise exception 'onbekende_speler'; end if;
  if d.id = v.id then raise exception 'jezelf'; end if;
  if d.ontmaskerd then raise exception 'al_ontmaskerd'; end if;

  select * into b from public.beschuldigingen where beschuldigde_id = d.id and status = 'open';
  if found then
    if not exists (select 1 from public.deelnames where beschuldiging_id = b.id and speler_id = v.id) then
      insert into public.deelnames (beschuldiging_id, speler_id, sessie_id, rol)
      values (b.id, v.id, p_sessie, 'meedoener');
      update public.beschuldigingen set laatste_meedoen = now() where id = b.id;
    end if;
    return json_build_object('beschuldiging_id', b.id, 'rol', 'meedoener');
  end if;

  insert into public.beschuldigingen (sessie_id, beschuldigde_id, eerste_beschuldiger_id)
  values (p_sessie, d.id, v.id) returning * into b;
  insert into public.deelnames (beschuldiging_id, speler_id, sessie_id, rol)
  values (b.id, v.id, p_sessie, 'eerste');
  return json_build_object('beschuldiging_id', b.id, 'rol', 'eerste');
end $$;

create or replace function public.meedoen(p_beschuldiging uuid)
returns void language plpgsql security definer set search_path = public as $$
declare b public.beschuldigingen; v public.spelers;
begin
  select * into b from public.beschuldigingen where id = p_beschuldiging;
  if not found then raise exception 'onbekend'; end if;
  v := geheim.mij(b.sessie_id);
  perform geheim.sessie_lock(b.sessie_id);
  select * into b from public.beschuldigingen where id = p_beschuldiging for update;
  if b.status <> 'open' then raise exception 'al_afgerond'; end if;
  if b.beschuldigde_id = v.id then raise exception 'jezelf'; end if;
  if exists (select 1 from public.deelnames where beschuldiging_id = b.id and speler_id = v.id) then
    return;
  end if;
  insert into public.deelnames (beschuldiging_id, speler_id, sessie_id, rol)
  values (b.id, v.id, b.sessie_id, 'meedoener');
  update public.beschuldigingen set laatste_meedoen = now() where id = b.id;
end $$;

create or replace function public.reageer(p_beschuldiging uuid, p_toegeven boolean)
returns void language plpgsql security definer set search_path = public as $$
declare b public.beschuldigingen; v public.spelers;
begin
  select * into b from public.beschuldigingen where id = p_beschuldiging;
  if not found then raise exception 'onbekend'; end if;
  v := geheim.mij(b.sessie_id);
  perform geheim.sessie_lock(b.sessie_id);
  select * into b from public.beschuldigingen where id = p_beschuldiging for update;
  if b.beschuldigde_id <> v.id then raise exception 'niet_beschuldigd'; end if;
  if b.status <> 'open' then raise exception 'al_afgerond'; end if;
  if now() < b.laatste_meedoen + interval '15 seconds' then raise exception 'nog_wachten'; end if;
  perform geheim.sluit_beschuldiging(b.id, p_toegeven, false);
end $$;

-- Beschuldigde reageert niet: host sluit na 2 minuten als afgewezen
create or replace function public.host_sluit_beschuldiging(p_beschuldiging uuid)
returns void language plpgsql security definer set search_path = public as $$
declare b public.beschuldigingen;
begin
  select * into b from public.beschuldigingen where id = p_beschuldiging;
  if not found then raise exception 'onbekend'; end if;
  perform geheim.eis_host(b.sessie_id);
  perform geheim.sessie_lock(b.sessie_id);
  select * into b from public.beschuldigingen where id = p_beschuldiging for update;
  if b.status <> 'open' then raise exception 'al_afgerond'; end if;
  if now() < b.laatste_meedoen + interval '2 minutes' then raise exception 'nog_wachten'; end if;
  perform geheim.sluit_beschuldiging(b.id, false, true);
end $$;

create or replace function public.host_verwijder(p_speler uuid)
returns void language plpgsql security definer set search_path = public as $$
declare d public.spelers; s public.sessies; b record; v_volgende uuid;
begin
  select * into d from public.spelers where id = p_speler;
  if not found then raise exception 'onbekende_speler'; end if;
  perform geheim.eis_host(d.sessie_id);
  s := geheim.sessie_lock(d.sessie_id);
  if s.host_id = d.id then raise exception 'host_niet_verwijderen'; end if;

  update public.spelers set verwijderd = true where id = d.id;
  -- missies met hem als doelwit krijgen een gratis wissel
  update public.toewijzingen set gratis_wissel = true
   where sessie_id = d.sessie_id and doelwit_id = d.id and voltooid_op is null;
  -- beschuldigingen tegen hem vervallen
  update public.beschuldigingen set status = 'vervallen', afgerond_op = now()
   where beschuldigde_id = d.id and status = 'open';
  -- zijn deelname aan open beschuldigingen vervalt
  for b in select bb.id from public.beschuldigingen bb join public.deelnames dd on dd.beschuldiging_id = bb.id
            where bb.sessie_id = d.sessie_id and bb.status = 'open' and dd.speler_id = d.id loop
    delete from public.deelnames where beschuldiging_id = b.id and speler_id = d.id;
    select speler_id into v_volgende from public.deelnames where beschuldiging_id = b.id order by tijdstip limit 1;
    if v_volgende is null then
      update public.beschuldigingen set status = 'vervallen', afgerond_op = now() where id = b.id;
    else
      update public.deelnames set rol = 'eerste' where beschuldiging_id = b.id and speler_id = v_volgende;
      update public.beschuldigingen set eerste_beschuldiger_id = v_volgende where id = b.id;
    end if;
  end loop;
end $$;

create or replace function public.host_extra_joker(p_speler uuid)
returns void language plpgsql security definer set search_path = public as $$
declare d public.spelers;
begin
  select * into d from public.spelers where id = p_speler;
  if not found then raise exception 'onbekende_speler'; end if;
  perform geheim.eis_host(d.sessie_id);
  update public.toewijzingen set joker_extra = true where speler_id = d.id;
end $$;

create or replace function public.host_melding_weg(p_sessie uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform geheim.eis_host(p_sessie);
  update public.sessies set host_melding = null where id = p_sessie;
end $$;

-- Hartslag; neemt de hostrol over als de host 90 s weg is
create or replace function public.ping(p_sessie uuid)
returns json language plpgsql security definer set search_path = public as $$
declare v public.spelers; s public.sessies; v_host_gezien timestamptz; v_nieuw uuid;
begin
  v := geheim.mij(p_sessie);
  insert into public.aanwezig values (v.id, now())
    on conflict (speler_id) do update set laatst_gezien = now();
  select * into s from public.sessies where id = p_sessie;
  if s.host_id is distinct from v.id then
    select laatst_gezien into v_host_gezien from public.aanwezig where speler_id = s.host_id;
    if v_host_gezien is null or v_host_gezien < now() - interval '90 seconds'
       or exists (select 1 from public.spelers where id = s.host_id and verwijderd) then
      select x.id into v_nieuw from public.spelers x join public.aanwezig a on a.speler_id = x.id
       where x.sessie_id = p_sessie and not x.verwijderd and x.id <> s.host_id
         and a.laatst_gezien > now() - interval '60 seconds'
       order by x.volgnr limit 1;
      if v_nieuw is not null then
        update public.sessies set host_id = v_nieuw where id = p_sessie and host_id = s.host_id;
      end if;
    end if;
  end if;
  return json_build_object('nu', now());
end $$;

create or replace function public.beeindig_spel(p_sessie uuid)
returns void language plpgsql security definer set search_path = public as $$
declare s public.sessies;
begin
  perform geheim.eis_host(p_sessie);
  s := geheim.sessie_lock(p_sessie);
  if s.status <> 'spel' then raise exception 'spel_loopt_niet'; end if;
  update public.beschuldigingen set status = 'vervallen', afgerond_op = now()
   where sessie_id = p_sessie and status = 'open';
  update public.sessies
     set status = 'onthulling', beeindigd_op = now(), verloopt = now() + interval '24 hours',
         onthul_index = 0, onthul_stap = 'naam',
         onthul_volgorde = (select coalesce(array_agg(x.id order by random()), '{}')
                              from public.spelers x join public.toewijzingen t on t.speler_id = x.id
                             where x.sessie_id = p_sessie and not x.verwijderd)
   where id = p_sessie;
end $$;

create or replace function public.onthul_stap(p_sessie uuid, p_vooruit boolean default true)
returns void language plpgsql security definer set search_path = public as $$
declare s public.sessies; n int;
begin
  perform geheim.eis_host(p_sessie);
  s := geheim.sessie_lock(p_sessie);
  if s.status <> 'onthulling' then raise exception 'geen_onthulling'; end if;
  n := coalesce(array_length(s.onthul_volgorde, 1), 0);
  if p_vooruit then
    if s.onthul_stap = 'naam' then
      update public.sessies set onthul_stap = 'missie' where id = p_sessie;
    elsif s.onthul_index < n - 1 then
      update public.sessies set onthul_stap = 'naam', onthul_index = onthul_index + 1 where id = p_sessie;
    end if;
  else
    if s.onthul_stap = 'missie' then
      update public.sessies set onthul_stap = 'naam' where id = p_sessie;
    elsif s.onthul_index > 0 then
      update public.sessies set onthul_stap = 'missie', onthul_index = onthul_index - 1 where id = p_sessie;
    end if;
  end if;
end $$;

-- Alle missies van de sessie, alleen tijdens onthulling en daarna
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
      'afgewezen', (select coalesce(json_agg(json_build_object(
                        'door', (select naam from public.spelers e where e.id = b.eerste_beschuldiger_id),
                        'mee', (select count(*) - 1 from public.deelnames dd where dd.beschuldiging_id = b.id),
                        'op', b.afgerond_op, 'door_host', b.door_host) order by b.aangemaakt), '[]'::json)
                      from public.beschuldigingen b
                     where b.beschuldigde_id = x.id and b.status = 'afgewezen')
    ) order by x.volgnr), '[]'::json)
    from public.spelers x join public.toewijzingen t on t.speler_id = x.id
    where x.sessie_id = p_sessie and not x.verwijderd
  );
end $$;

create or replace function public.stem(p_sessie uuid, p_speler uuid, p_duim boolean)
returns void language plpgsql security definer set search_path = public as $$
declare v public.spelers; s public.sessies;
begin
  v := geheim.mij(p_sessie);
  select * into s from public.sessies where id = p_sessie;
  if s.status <> 'onthulling' then raise exception 'geen_onthulling'; end if;
  if p_speler = v.id then raise exception 'jezelf'; end if;
  if not exists (select 1 from public.spelers where id = p_speler and sessie_id = p_sessie) then
    raise exception 'onbekende_speler';
  end if;
  insert into public.stemmen values (p_sessie, p_speler, v.id, p_duim)
    on conflict (speler_id, stemmer_id) do update set duim = excluded.duim;
end $$;

create or replace function public.naar_scorebord(p_sessie uuid)
returns void language plpgsql security definer set search_path = public as $$
declare s public.sessies;
begin
  perform geheim.eis_host(p_sessie);
  s := geheim.sessie_lock(p_sessie);
  if s.status <> 'onthulling' then raise exception 'geen_onthulling'; end if;
  update public.spelers x
     set missie_gehaald = q.gehaald,
         missie_punten = case when q.gehaald then q.moeilijkheid else 0 end,
         eindscore = x.punten_beschuldiging + case when q.gehaald then q.moeilijkheid else 0 end
    from (
      select t.speler_id, t.moeilijkheid,
             (t.voltooid_op is not null and not sp.ontmaskerd
              and (select count(*) filter (where not duim) from public.stemmen st where st.speler_id = t.speler_id)
                <= (select count(*) filter (where duim) from public.stemmen st where st.speler_id = t.speler_id)
             ) as gehaald
        from public.toewijzingen t join public.spelers sp on sp.id = t.speler_id
       where t.sessie_id = p_sessie
    ) q
   where q.speler_id = x.id;
  update public.spelers set eindscore = punten_beschuldiging, missie_gehaald = false, missie_punten = 0
   where sessie_id = p_sessie and eindscore is null;
  update public.sessies set status = 'einde' where id = p_sessie;
end $$;

-- ---------------------------------------------------------------------
-- Beheer: missies importeren zonder ze te zien
-- ---------------------------------------------------------------------
create or replace function geheim.eis_token(p_token text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_token is null or p_token <> (select waarde from geheim.config where sleutel = 'beheer_token') then
    perform pg_sleep(1);
    raise exception 'token_fout';
  end if;
end $$;

create or replace function public.beheer_overzicht(p_token text)
returns json language plpgsql security definer set search_path = public as $$
begin
  perform geheim.eis_token(p_token);
  return json_build_object(
    'totaal', (select count(*) from geheim.missies),
    'woorden', (select count(*) from geheim.woorden),
    'per_thema', (select coalesce(json_object_agg(thema, n), '{}') from (select thema, count(*) n from geheim.missies group by 1) q),
    'per_categorie', (select coalesce(json_object_agg(categorie, n), '{}') from (select categorie, count(*) n from geheim.missies group by 1) q),
    'per_moeilijkheid', (select coalesce(json_object_agg(moeilijkheid, n), '{}') from (select moeilijkheid, count(*) n from geheim.missies group by 1) q),
    'per_leeftijd', (select coalesce(json_object_agg(leeftijd, n), '{}') from (select leeftijd, count(*) n from geheim.missies group by 1) q),
    'met_doelwit', (select count(*) from geheim.missies where doelwit),
    'met_woord', (select count(*) from geheim.missies where heeft_woord),
    'families', (select count(distinct familie) from geheim.missies)
  );
end $$;

-- p_missies: json-array met missies volgens de velden uit het framework.
-- p_woorden: optioneel; json-array met woorden, of object per thema: {"algemeen": [...], "kerst": [...]}.
create or replace function public.beheer_import(p_token text, p_missies jsonb, p_woorden jsonb default null,
                                                p_vervangen boolean default false)
returns json language plpgsql security definer set search_path = public as $$
declare e jsonb; i int := 0; v_ok int := 0; v_fouten jsonb := '[]'; v_id text; v_tekst text;
        v_moeil int; v_vereist text[]; v_doelwit boolean; v_leeftijd text; v_m text;
begin
  perform geheim.eis_token(p_token);
  if jsonb_typeof(p_missies) <> 'array' then raise exception 'geen_lijst'; end if;
  if p_vervangen then delete from geheim.missies; end if;

  for e in select * from jsonb_array_elements(p_missies) loop
    i := i + 1;
    begin
      v_tekst := nullif(trim(e->>'tekst'), '');
      if v_tekst is null then raise exception 'tekst ontbreekt'; end if;
      v_id := coalesce(nullif(trim(e->>'id'), ''), 'imp-' || i);

      v_m := lower(coalesce(e->>'moeilijkheid', '2'));
      v_moeil := case when v_m ~ '^[0-9]+$' then least(3, greatest(1, v_m::int))
                      when v_m like 'mak%' then 1 when v_m like 'moei%' then 3 else 2 end;

      v_vereist := case jsonb_typeof(e->'vereist')
                     when 'array' then array(select lower(trim(x)) from jsonb_array_elements_text(e->'vereist') x where trim(x) <> '')
                     when 'string' then array(select lower(trim(x)) from regexp_split_to_table(e->>'vereist', '[,;/ ]+') x where trim(x) <> '' and lower(trim(x)) not in ('geen','nee','-'))
                     else '{}' end;
      -- synoniemen naar de context-waarden van de app
      v_vereist := array(select distinct case
                     when x like 'eet%' or x like 'eten%' then 'eten'
                     when x like 'drin%' then 'drinken'
                     when x like 'gast%' or x like 'host%' then 'gastheer'
                     when x like 'kind%' or x like 'kid%' then 'kinderen'
                     else x end from unnest(v_vereist) x);

      v_doelwit := case jsonb_typeof(e->'doelwit')
                     when 'boolean' then (e->>'doelwit')::boolean
                     when 'string' then lower(e->>'doelwit') in ('ja','true','yes','1','j')
                     else false end
                   or position('{doelwit}' in v_tekst) > 0;

      v_leeftijd := lower(coalesce(nullif(trim(e->>'leeftijd'), ''), 'iedereen'));
      v_leeftijd := case when v_leeftijd like '%18%' then '18+' when v_leeftijd like 'kid%' or v_leeftijd like 'kind%' then 'kids' else 'iedereen' end;

      insert into geheim.missies (id, tekst_enc, uitleg_enc, categorie, familie, moeilijkheid, thema,
                                  doelwit, heeft_woord, vereist, leeftijd, getal_min, getal_max)
      values (v_id, geheim.versleutel(v_tekst), geheim.versleutel(nullif(trim(e->>'uitleg'), '')),
              lower(coalesce(nullif(trim(e->>'categorie'), ''), 'overig')),
              nullif(lower(trim(e->>'familie')), ''),
              v_moeil,
              lower(coalesce(nullif(trim(e->>'thema'), ''), 'algemeen')),
              v_doelwit,
              position('{woord}' in v_tekst) > 0,
              v_vereist, v_leeftijd,
              coalesce((e->>'getal_min')::int, 2), coalesce((e->>'getal_max')::int, 5))
      on conflict (id) do update set
        tekst_enc = excluded.tekst_enc, uitleg_enc = excluded.uitleg_enc, categorie = excluded.categorie,
        familie = excluded.familie, moeilijkheid = excluded.moeilijkheid, thema = excluded.thema,
        doelwit = excluded.doelwit, heeft_woord = excluded.heeft_woord, vereist = excluded.vereist,
        leeftijd = excluded.leeftijd, getal_min = excluded.getal_min, getal_max = excluded.getal_max,
        geimporteerd = now();
      v_ok := v_ok + 1;
    exception when others then
      v_fouten := v_fouten || jsonb_build_object('nummer', i, 'id', e->>'id', 'reden', sqlerrm);
    end;
  end loop;

  if p_woorden is not null and jsonb_typeof(p_woorden) = 'array' and jsonb_array_length(p_woorden) > 0 then
    delete from geheim.woorden;
    insert into geheim.woorden (woord_enc, thema)
      select geheim.versleutel(trim(x)), 'algemeen' from jsonb_array_elements_text(p_woorden) x where trim(x) <> '';
  elsif p_woorden is not null and jsonb_typeof(p_woorden) = 'object' then
    delete from geheim.woorden;
    insert into geheim.woorden (woord_enc, thema)
      select geheim.versleutel(trim(w)), lower(kv.key)
        from jsonb_each(p_woorden) kv, jsonb_array_elements_text(case when jsonb_typeof(kv.value) = 'array' then kv.value else '[]' end) w
       where trim(w) <> '';
  end if;

  return json_build_object('geimporteerd', v_ok, 'fouten', v_fouten, 'overzicht', public.beheer_overzicht(p_token));
end $$;

-- ---------------------------------------------------------------------
-- Rechten op functies
-- ---------------------------------------------------------------------
revoke execute on all functions in schema geheim from public, anon, authenticated;

do $$
declare f text;
begin
  foreach f in array array[
    'server_tijd()', 'maak_sessie(text,text,text,text,text[],boolean)', 'join_sessie(text,text,text)',
    'overname_check(uuid)', 'host_overname(uuid,boolean)', 'start_spel(uuid)', 'mijn_missie(uuid)',
    'gebruik_joker(uuid)', 'markeer_voltooid(uuid,uuid,boolean)', 'beschuldig(uuid,uuid)', 'meedoen(uuid)',
    'reageer(uuid,boolean)', 'host_sluit_beschuldiging(uuid)', 'host_verwijder(uuid)', 'host_extra_joker(uuid)',
    'host_melding_weg(uuid)', 'ping(uuid)', 'beeindig_spel(uuid)', 'onthul_stap(uuid,boolean)',
    'onthulling_data(uuid)', 'stem(uuid,uuid,boolean)', 'naar_scorebord(uuid)', 'is_lid(uuid)',
    'beheer_overzicht(text)', 'beheer_import(text,jsonb,jsonb,boolean)'
  ] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- Vaste search_path voor de laatste hulpfuncties
alter function geheim.nieuwe_code() set search_path = public;
alter function geheim.sleutel() set search_path = public;
alter function geheim.versleutel(text) set search_path = public;
alter function geheim.ontsleutel(bytea) set search_path = public;
alter function public.server_tijd() set search_path = public;

-- Je beheercode voor de importpagina (bewaar hem, deel hem niet):
select waarde as beheercode from geheim.config where sleutel = 'beheer_token';
