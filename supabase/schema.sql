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
insert into geheim.config values ('test_pin', '1994') on conflict do nothing;  -- pincode testomgeving

create table if not exists geheim.missies (
  id            text primary key,
  tekst_enc     bytea not null,
  uitleg_enc    bytea,
  categorie     text not null default 'overig',
  soort         text not null default 'praten',
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
  -- willekeurige sleutel, dus geen trage sleutel-rekking nodig
  select case when t is null then null else extensions.pgp_sym_encrypt(t, geheim.sleutel(), 's2k-mode=1, cipher-algo=aes128') end
$$;

-- soort (voor de spelopties) volgt uit de categorie
create or replace function geheim.soort_van(p_categorie text) returns text
language sql immutable set search_path = public as $$
  select case when p_categorie in ('beïnvloeden', 'beinvloeden') then 'sturen'
              when p_categorie in ('gedrag', 'tafel') then 'doen'
              else 'praten' end
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
  soorten        text[] not null default '{praten,sturen,doen}',
  punten_aan     boolean not null default true,
  status         text not null default 'lobby' check (status in ('lobby','spel','onthulling','einde','geannuleerd')),
  host_id        uuid,
  gestart_op     timestamptz,
  beeindigd_op   timestamptz,
  onthul_volgorde uuid[] not null default '{}',
  onthul_index   int not null default 0,
  onthul_stap    text not null default 'naam' check (onthul_stap in ('naam','missie')),
  host_melding   text,
  aangemaakt     timestamptz not null default now(),
  verloopt       timestamptz not null default now() + interval '3 days',
  ronde          int not null default 1,          -- W12: nog een ronde met dezelfde spelers
  gebruikte_missies text[] not null default '{}'  -- W12: al uitgedeeld in eerdere rondes
);
alter table public.sessies add column if not exists ronde int not null default 1;
alter table public.sessies add column if not exists gebruikte_missies text[] not null default '{}';
-- Testmodus (avondnaam "barry-test-spel"): nepspelers, nepmissies en wisselen van perspectief
alter table public.sessies add column if not exists test boolean not null default false;
alter table public.sessies add column if not exists test_eigenaar uuid;
alter table public.sessies add column if not exists test_als uuid;

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
  opdrachten_geflikt   int not null default 0,      -- W7: aantal geflikte opdrachten
  aangemaakt           timestamptz not null default now()
);
alter table public.spelers add column if not exists opdrachten_geflikt int not null default 0;
alter table public.spelers add column if not exists geslacht text check (geslacht in ('m', 'v'));   -- voor 'hij/zij'
alter table public.spelers add column if not exists avatar int check (avatar between 0 and 19);
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
  getuigen          uuid[] not null default '{}'   -- W2: meerdere getuigen
);
alter table public.toewijzingen add column if not exists getuigen uuid[] not null default '{}';
alter table public.toewijzingen add column if not exists woord_enc bytea;  -- ingevuld {woord}, apart getoond in het dossier
alter table public.toewijzingen drop column if exists getuige_id;

-- W7: geflikte opdrachten waarna de speler een nieuwe pakte. Kunnen niet meer betrapt worden.
create table if not exists public.afgeronde_opdrachten (
  id            uuid primary key default gen_random_uuid(),
  speler_id     uuid not null references public.spelers(id) on delete cascade,
  sessie_id     uuid not null references public.sessies(id) on delete cascade,
  missie_id     text not null,
  tekst_enc     bytea not null,
  toegewezen_op timestamptz not null,
  voltooid_op   timestamptz not null,
  getuigen      uuid[] not null default '{}',
  punten        int not null
);
create index if not exists afgeronde_sessie on public.afgeronde_opdrachten(sessie_id);
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
  afgerond_op            timestamptz,
  herinnerd_op           timestamptz,             -- W5: laatste trilherinnering
  missie_id              text,                    -- op welke opdracht betrapt (voor 'toch raak')
  toch_raak              boolean not null default false  -- host: "Mooi niet!" was toch raak
);
alter table public.beschuldigingen add column if not exists herinnerd_op timestamptz;
alter table public.beschuldigingen add column if not exists missie_id text;
alter table public.beschuldigingen add column if not exists toch_raak boolean not null default false;
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


create table if not exists public.overnames (
  id             uuid primary key default gen_random_uuid(),
  sessie_id      uuid not null references public.sessies(id) on delete cascade,
  speler_id      uuid not null references public.spelers(id) on delete cascade,
  nieuwe_user_id uuid not null,
  status         text not null default 'open' check (status in ('open','goed','geweigerd')),
  aangemaakt     timestamptz not null default now()
);
create index if not exists overnames_sessie on public.overnames(sessie_id);

-- W4: pushmeldingen (Web Push). Alleen via functies te lezen/schrijven.
create table if not exists public.push_abonnementen (
  endpoint   text primary key,
  speler_id  uuid not null references public.spelers(id) on delete cascade,
  sessie_id  uuid not null references public.sessies(id) on delete cascade,
  p256dh     text not null,
  auth       text not null,
  aangemaakt timestamptz not null default now()
);
create index if not exists push_sessie on public.push_abonnementen(sessie_id);

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
alter table public.overnames       enable row level security;
alter table public.aanwezig        enable row level security;
alter table public.afgeronde_opdrachten enable row level security;
alter table public.push_abonnementen    enable row level security;

drop policy if exists lid_leest on public.sessies;
create policy lid_leest on public.sessies for select to authenticated using (public.is_lid(id));
drop policy if exists lid_leest on public.spelers;
create policy lid_leest on public.spelers for select to authenticated using (public.is_lid(sessie_id));
drop policy if exists lid_leest on public.beschuldigingen;
create policy lid_leest on public.beschuldigingen for select to authenticated using (public.is_lid(sessie_id));
drop policy if exists lid_leest on public.deelnames;
create policy lid_leest on public.deelnames for select to authenticated using (public.is_lid(sessie_id));
drop policy if exists lid_leest on public.overnames;
create policy lid_leest on public.overnames for select to authenticated using (public.is_lid(sessie_id));
-- toewijzingen, afgeronde_opdrachten, push_abonnementen en aanwezig: geen policies = voor de app onleesbaar.

revoke insert, update, delete, truncate on public.sessies, public.spelers, public.toewijzingen,
  public.beschuldigingen, public.deelnames, public.overnames, public.aanwezig
  from anon, authenticated;
revoke select on public.toewijzingen, public.aanwezig from anon, authenticated;
revoke all on public.afgeronde_opdrachten, public.push_abonnementen from anon, authenticated;
-- Expliciet leesrecht (RLS bepaalt welke rijen); nieuwe projecten geven dit niet altijd automatisch.
grant usage on schema public to anon, authenticated;
grant select on public.sessies, public.spelers, public.beschuldigingen, public.deelnames,
  public.overnames to authenticated;
revoke select on public.sessies, public.spelers, public.beschuldigingen, public.deelnames,
  public.overnames from anon;

-- Realtime: alleen tabellen zonder missieteksten
do $$
declare t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  foreach t in array array['sessies','spelers','beschuldigingen','deelnames','overnames'] loop
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

-- W11: punten op basis van hoe snel je je opdracht flikt (vanaf het ontvangen)
create or replace function geheim.tijdpunten(p_van timestamptz, p_tot timestamptz) returns int
language sql immutable set search_path = public as $$
  select case when p_tot is null or p_van is null then 0
              when floor(extract(epoch from p_tot - p_van) / 60) <= 10 then 10
              when floor(extract(epoch from p_tot - p_van) / 60) <= 20 then 8
              when floor(extract(epoch from p_tot - p_van) / 60) <= 30 then 6
              when floor(extract(epoch from p_tot - p_van) / 60) <= 40 then 5
              else 4 end
$$;

-- W4/W5: pushmelding versturen via de Edge Function 'push' (pg_net). Zonder instellingen gebeurt er niets.
create or replace function geheim.push(p_sessie uuid, p_ontvangers uuid[], p_bericht jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare v_url text; v_geheim text;
begin
  if p_ontvangers is null or cardinality(p_ontvangers) = 0 then return; end if;
  select waarde into v_url from geheim.config where sleutel = 'push_url';
  select waarde into v_geheim from geheim.config where sleutel = 'push_geheim';
  if v_url is null or v_geheim is null or to_regproc('net.http_post') is null then return; end if;
  if not exists (select 1 from public.push_abonnementen where speler_id = any(p_ontvangers)) then return; end if;
  execute 'select net.http_post(url := $1, body := $2, headers := $3)'
    using v_url,
          jsonb_build_object('sessie_id', p_sessie, 'ontvangers', to_jsonb(p_ontvangers), 'bericht', p_bericht),
          jsonb_build_object('Content-Type', 'application/json', 'x-push-geheim', v_geheim);
exception when others then
  raise warning 'push mislukt: %', sqlerrm;  -- een melding mag het spel nooit blokkeren
end $$;

-- Sleutels voor de Edge Function 'push'; alleen de service-rol mag dit lezen.
create or replace function public.push_config()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_object_agg(sleutel, waarde), '{}'::jsonb) from geheim.config
   where sleutel in ('push_geheim', 'vapid_public', 'vapid_private', 'vapid_subject')
$$;
revoke all on function public.push_config() from public, anon, authenticated;
grant execute on function public.push_config() to service_role;

create or replace function geheim.mij(p_sessie uuid) returns public.spelers
language plpgsql security definer set search_path = public as $$
declare v public.spelers; s public.sessies;
begin
  select * into s from public.sessies where id = p_sessie;
  if s.test and s.test_als is not null and s.test_eigenaar = auth.uid() then
    select * into v from public.spelers where id = s.test_als and sessie_id = p_sessie and not verwijderd;
    if found then return v; end if;
  end if;
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
  v_levels int[]; v_kids boolean; v_used text[]; v_fams text[]; v_andere int; v_oud_soort text;
  v_stage int; v_doelwit uuid; v_doelwitnaam text; v_woord text; v_getal int;
  v_tekst text; v_uitleg text; v_oud public.toewijzingen;
begin
  select * into sp from public.spelers where id = p_speler;
  select * into s from public.sessies where id = sp.sessie_id;
  select * into v_oud from public.toewijzingen where speler_id = p_speler;

  if s.test then
    -- Nepmissie: de echte missies blijven geheim, ook voor de tester
    v_getal := 1 + (select count(*) + coalesce(sum(cardinality(gewisseld)), 0) from public.toewijzingen where sessie_id = s.id)::int;
    select x.id, x.naam into v_doelwit, v_doelwitnaam from public.spelers x
     where x.sessie_id = s.id and x.id <> p_speler and not x.verwijderd order by random() limit 1;
    -- M1: elke nepopdracht is echt anders (andere soort en tekst), niet alleen een ander doelwit
    v_tekst := 'Testopdracht ' || v_getal || ': ' || (array[
      'zeg twee keer het woord "testwoord".',
      'laat ' || coalesce(v_doelwitnaam, 'iemand') || ' iets over het weer zeggen.',
      'leg je servet drie keer opnieuw neer.',
      'stel twee mensen een vraag over vakantie.',
      'laat iemand hardop lachen om een grap van jou.',
      'tik met je vinger op het glas van je buurman.'])[1 + (v_getal - 1) % 6];
    if (v_getal - 1) % 6 <> 1 then v_doelwit := null; end if;
    v_uitleg := 'Dit is een nepopdracht voor de testavond; geen echte opdracht.';
    if v_oud.speler_id is null then
      insert into public.toewijzingen (speler_id, sessie_id, missie_id, moeilijkheid, categorie, tekst_enc, uitleg_enc, doelwit_id, woord_enc)
      values (p_speler, s.id, 'test-' || v_getal, 1 + v_getal % 3, (array['gesprek','beïnvloeden','woord','gedrag','tafel'])[1 + v_getal % 5],
              geheim.versleutel(v_tekst), geheim.versleutel(v_uitleg), v_doelwit, geheim.versleutel(v_woord));
    else
      update public.toewijzingen
         set gewisseld = gewisseld || v_oud.missie_id, missie_id = 'test-' || v_getal, moeilijkheid = 1 + v_getal % 3,
             categorie = (array['gesprek','beïnvloeden','woord','gedrag','tafel'])[1 + v_getal % 5],
             tekst_enc = geheim.versleutel(v_tekst), uitleg_enc = geheim.versleutel(v_uitleg), doelwit_id = v_doelwit,
             woord_enc = null, toegewezen_op = now(), voltooid_op = null, getuigen = '{}'
       where speler_id = p_speler;
    end if;
    return;
  end if;

  v_levels := case s.moeilijkheid when 'makkelijk' then array[1,2]
                                  when 'moeilijk'  then array[2,3]
                                  else array[1,2,3] end;
  v_kids := 'kinderen' = any(s.context);

  select coalesce(array_agg(x), '{}') into v_used from (
    select t.missie_id as x from public.toewijzingen t where t.sessie_id = s.id
    union select unnest(t.gewisseld) from public.toewijzingen t where t.sessie_id = s.id
    union select a.missie_id from public.afgeronde_opdrachten a where a.sessie_id = s.id
    union select unnest(s.gebruikte_missies)                     -- W12: eerdere rondes
  ) q;
  select coalesce(array_agg(distinct mi.familie), '{}') into v_fams
    from geheim.missies mi where mi.id = any(v_used) and mi.familie is not null;

  select count(*) into v_andere from public.spelers
   where sessie_id = s.id and id <> p_speler and not verwijderd;
  -- M1: een andere opdracht is ook een ander soort opdracht (als de avond meer soorten heeft)
  select mi.soort into v_oud_soort from geheim.missies mi where mi.id = v_oud.missie_id;

  v_stage := 0;
  loop
    v_stage := v_stage + 1;
    exit when v_stage > 4;
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
       and (v_stage >= 4 or mi.thema in (s.thema, 'algemeen'))
       and (v_stage >= 3 or mi.soort = any(s.soorten))
       and (v_oud_soort is null or cardinality(s.soorten) < 2 or mi.soort <> v_oud_soort or v_stage >= 4)
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
    update public.sessies set host_melding = 'De opdrachten zijn op. Niet iedereen kon een (nieuwe) opdracht krijgen.'
     where id = s.id;
    raise exception 'pool_op';
  end if;
  if v_stage > 1 then
    update public.sessies set host_melding = 'Er waren weinig opdrachten over, dus de filters zijn versoepeld'
      || case v_stage when 2 then ' (moeilijkheid).' when 3 then ' (moeilijkheid en soort).' else ' (moeilijkheid, soort en thema).' end
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
                                     tekst_enc, uitleg_enc, doelwit_id, woord_enc)
    values (p_speler, s.id, m.id, m.moeilijkheid, m.categorie,
            geheim.versleutel(v_tekst), geheim.versleutel(v_uitleg), v_doelwit, geheim.versleutel(v_woord));
  else
    update public.toewijzingen
       set gewisseld = gewisseld || v_oud.missie_id,
           missie_id = m.id, moeilijkheid = m.moeilijkheid, categorie = m.categorie,
           tekst_enc = geheim.versleutel(v_tekst), uitleg_enc = geheim.versleutel(v_uitleg),
           doelwit_id = v_doelwit, woord_enc = geheim.versleutel(v_woord),
           toegewezen_op = now(), voltooid_op = null, getuigen = '{}'
     where speler_id = p_speler;
  end if;
end $$;

-- Puntenstelsel voor betrappen (W11):
--  goed: wie Betrapt! riep +5, wie het ook zag +2
--  fout: wie het ook zag -1; wie Betrapt! riep -2, en elke volgende foute Betrapt! van dezelfde speler 1 meer (max -5)
create or replace function geheim.betrap_punten(p_rol text, p_goed boolean, p_speler uuid, p_sessie uuid, p_niet uuid)
returns int language sql stable security definer set search_path = public as $$
  select case
    when p_goed then case p_rol when 'eerste' then 5 else 2 end
    when p_rol <> 'eerste' then -1
    else -least(5, 2 + (select count(*) from public.deelnames d join public.beschuldigingen b on b.id = d.beschuldiging_id
                         where d.speler_id = p_speler and d.sessie_id = p_sessie and d.rol = 'eerste'
                           and d.punten < 0 and b.id <> p_niet)::int)
  end
$$;

-- Beschuldiging afsluiten met punten
create or replace function geheim.sluit_beschuldiging(p_id uuid, p_toegeven boolean, p_door_host boolean)
returns void language plpgsql security definer set search_path = public as $$
declare b public.beschuldigingen;
begin
  select * into b from public.beschuldigingen where id = p_id for update;
  if b.status <> 'open' then raise exception 'al_afgerond'; end if;

  update public.deelnames
     set punten = geheim.betrap_punten(rol, p_toegeven, speler_id, sessie_id, p_id)
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

  -- W8: is iedereen betrapt, dan is het spel direct voorbij
  if p_toegeven and not exists (select 1 from public.spelers
                                 where sessie_id = b.sessie_id and not verwijderd and not ontmaskerd) then
    perform geheim.beeindig(b.sessie_id);
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Functies voor de app (RPC)
-- ---------------------------------------------------------------------
drop function if exists public.maak_sessie(text, text, text, text, text[], boolean);
create or replace function public.maak_sessie(p_naam text, p_host_naam text, p_thema text default 'kerst',
  p_moeilijkheid text default 'gemengd', p_context text[] default '{}', p_punten boolean default true,
  p_soorten text[] default null)
returns json language plpgsql security definer set search_path = public as $$
declare s public.sessies; v_speler uuid; v_naam text := left(trim(coalesce(p_host_naam, '')), 20);
        v_soorten text[] := array(select distinct x from unnest(coalesce(p_soorten, '{}')) x where x in ('praten', 'sturen', 'doen'));
begin
  if auth.uid() is null then raise exception 'niet_ingelogd'; end if;
  if v_naam = '' then raise exception 'naam_leeg'; end if;
  perform geheim.opruimen();
  if cardinality(v_soorten) = 0 then v_soorten := '{praten,sturen,doen}'; end if;  -- minstens één soort
  insert into public.sessies (code, naam, thema, moeilijkheid, context, punten_aan, soorten, test, test_eigenaar)
  values (geheim.nieuwe_code(), coalesce(nullif(left(trim(p_naam), 40), ''), 'Betrapt!'),
          coalesce(nullif(lower(p_thema), ''), 'kerst'), coalesce(p_moeilijkheid, 'gemengd'),
          coalesce(p_context, '{}'), coalesce(p_punten, true), v_soorten,
          lower(trim(coalesce(p_naam, ''))) = 'barry-test-spel',
          case when lower(trim(coalesce(p_naam, ''))) = 'barry-test-spel' then auth.uid() end)
  returning * into s;
  insert into public.spelers (sessie_id, user_id, naam, volgnr)
  values (s.id, auth.uid(), v_naam, 1) returning id into v_speler;
  update public.sessies set host_id = v_speler where id = s.id;
  insert into public.aanwezig values (v_speler, now());
  if s.test then
    insert into public.spelers (sessie_id, user_id, naam, volgnr)
    select s.id, gen_random_uuid(), n, 1 + i
      from unnest(array['Anna','Bert','Cees']) with ordinality as t(n, i)
     where lower(n) <> lower(v_naam);
  end if;
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
    'toegewezen_op', t.toegewezen_op,
    'getuigen', to_json(t.getuigen),
    'punten', case when t.voltooid_op is not null then geheim.tijdpunten(t.toegewezen_op, t.voltooid_op) end,
    'eerdere', (select count(*) from public.afgeronde_opdrachten a where a.speler_id = v.id),
    'eerdere_punten', (select coalesce(sum(a.punten), 0) from public.afgeronde_opdrachten a where a.speler_id = v.id),
    'doelwit', (select x.naam from public.spelers x where x.id = t.doelwit_id),
    'woord', geheim.ontsleutel(t.woord_enc),
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

drop function if exists public.markeer_voltooid(uuid, uuid, boolean);
create or replace function public.markeer_voltooid(p_sessie uuid, p_getuigen uuid[] default '{}', p_ongedaan boolean default false)
returns void language plpgsql security definer set search_path = public as $$
declare v public.spelers; s public.sessies;
begin
  v := geheim.mij(p_sessie);
  select * into s from public.sessies where id = p_sessie;
  if s.status <> 'spel' then raise exception 'spel_loopt_niet'; end if;
  if v.ontmaskerd then raise exception 'ontmaskerd'; end if;
  if exists (select 1 from unnest(coalesce(p_getuigen, '{}')) g
              where not exists (select 1 from public.spelers x where x.id = g and x.sessie_id = p_sessie and x.id <> v.id)) then
    raise exception 'onbekende_speler';
  end if;
  if p_ongedaan then
    update public.toewijzingen set voltooid_op = null, getuigen = '{}' where speler_id = v.id;
  else
    update public.toewijzingen set voltooid_op = coalesce(voltooid_op, now()),
           getuigen = array(select distinct unnest(coalesce(p_getuigen, '{}')))
     where speler_id = v.id;
  end if;
end $$;

-- W7: na Geflikt! een nieuwe opdracht pakken. De geflikte opdracht is dan veilig (niet meer te betrappen).
create or replace function public.nieuwe_opdracht(p_sessie uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v public.spelers; s public.sessies; t public.toewijzingen;
begin
  v := geheim.mij(p_sessie);
  s := geheim.sessie_lock(p_sessie);
  if s.status <> 'spel' then raise exception 'spel_loopt_niet'; end if;
  if v.ontmaskerd then raise exception 'ontmaskerd'; end if;
  select * into t from public.toewijzingen where speler_id = v.id for update;
  if not found then raise exception 'geen_missie'; end if;
  if t.voltooid_op is null then raise exception 'niet_voltooid'; end if;
  if exists (select 1 from public.beschuldigingen where beschuldigde_id = v.id and status = 'open') then
    raise exception 'eerst_reageren';
  end if;
  insert into public.afgeronde_opdrachten (speler_id, sessie_id, missie_id, tekst_enc, toegewezen_op, voltooid_op, getuigen, punten)
  values (v.id, p_sessie, t.missie_id, t.tekst_enc, t.toegewezen_op, t.voltooid_op, t.getuigen,
          geheim.tijdpunten(t.toegewezen_op, t.voltooid_op));
  update public.spelers set opdrachten_geflikt = opdrachten_geflikt + 1 where id = v.id;
  perform geheim.wijs_toe(v.id);
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

  insert into public.beschuldigingen (sessie_id, beschuldigde_id, eerste_beschuldiger_id, missie_id)
  values (p_sessie, d.id, v.id, (select t.missie_id from public.toewijzingen t where t.speler_id = d.id)) returning * into b;
  insert into public.deelnames (beschuldiging_id, speler_id, sessie_id, rol)
  values (b.id, v.id, p_sessie, 'eerste');
  -- W4: pushmelding naar de betrapte en naar de rest van de tafel
  perform geheim.push(p_sessie, array[d.id], jsonb_build_object(
    'titel', 'Betrapt?!', 'tekst', v.naam || ' denkt je te hebben. Kies: Je hebt me! of Mooi niet!',
    'tag', 'betrapt-' || b.id, 'soort', 'betrapt'));
  perform geheim.push(p_sessie,
    array(select x.id from public.spelers x where x.sessie_id = p_sessie and not x.verwijderd and x.id not in (v.id, d.id)),
    jsonb_build_object('titel', 'Betrap!', 'tekst', v.naam || ' betrapt ' || d.naam || '! Zag jij het ook?',
                       'tag', 'betrap-' || b.id, 'soort', 'betrap'));
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

create or replace function geheim.echte_ik(p_sessie uuid) returns public.spelers
language plpgsql security definer set search_path = public as $$
declare v public.spelers;
begin
  select * into v from public.spelers
   where sessie_id = p_sessie and user_id = auth.uid() and not verwijderd;
  if not found then raise exception 'geen_speler'; end if;
  return v;
end $$;

create or replace function geheim.verwijder_speler(d public.spelers) returns void
language plpgsql security definer set search_path = public as $$
declare b record; v_volgende uuid;
begin
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

create or replace function public.host_verwijder(p_speler uuid)
returns void language plpgsql security definer set search_path = public as $$
declare d public.spelers; s public.sessies;
begin
  select * into d from public.spelers where id = p_speler;
  if not found then raise exception 'onbekende_speler'; end if;
  perform geheim.eis_host(d.sessie_id);
  s := geheim.sessie_lock(d.sessie_id);
  if s.host_id = d.id then raise exception 'host_niet_verwijderen'; end if;
  perform geheim.verwijder_speler(d);
end $$;

create or replace function public.annuleer_sessie(p_sessie uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v public.spelers; s public.sessies;
begin
  v := geheim.echte_ik(p_sessie);
  s := geheim.sessie_lock(p_sessie);
  if s.host_id is distinct from v.id and s.test_eigenaar is distinct from auth.uid() then
    raise exception 'niet_host';
  end if;
  update public.sessies set status = 'geannuleerd', verloopt = now() + interval '3 minutes'
   where id = p_sessie;
end $$;

create or replace function public.verlaat_sessie(p_sessie uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v public.spelers; s public.sessies;
begin
  v := geheim.echte_ik(p_sessie);
  s := geheim.sessie_lock(p_sessie);
  if s.host_id = v.id then
    perform public.annuleer_sessie(p_sessie);
    return;
  end if;
  if s.status in ('lobby', 'einde', 'geannuleerd') then
    delete from public.spelers where id = v.id;
  else
    perform geheim.verwijder_speler(v);
  end if;
  -- de anderen laten verversen (een DELETE komt niet via het sessiefilter binnen)
  update public.sessies set test_als = case when test_als = v.id then null else test_als end where id = p_sessie;
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

-- Testmodus: de eigenaar kiest als welke speler hij speelt (null = zichzelf)
create or replace function public.test_wissel(p_sessie uuid, p_speler uuid)
returns void language plpgsql security definer set search_path = public as $$
declare s public.sessies;
begin
  select * into s from public.sessies where id = p_sessie;
  if not found or not s.test or s.test_eigenaar is distinct from auth.uid() then raise exception 'geen_test'; end if;
  if p_speler is not null and not exists (select 1 from public.spelers where id = p_speler and sessie_id = p_sessie and not verwijderd) then
    raise exception 'onbekende_speler';
  end if;
  update public.sessies set test_als = case when p_speler = (select id from public.spelers where sessie_id = p_sessie and user_id = auth.uid() and not verwijderd) then null else p_speler end
   where id = p_sessie;
end $$;

-- Hartslag; neemt de hostrol over als de host 90 s weg is
create or replace function public.ping(p_sessie uuid)
returns json language plpgsql security definer set search_path = public as $$
declare v public.spelers; s public.sessies; v_host_gezien timestamptz; v_nieuw uuid;
begin
  perform geheim.opruimen();
  select * into s from public.sessies where id = p_sessie;
  if not found then return json_build_object('nu', now(), 'weg', true); end if;
  v := geheim.mij(p_sessie);
  insert into public.aanwezig values (v.id, now())
    on conflict (speler_id) do update set laatst_gezien = now();
  -- W8: na 45 minuten is het spel voorbij
  if s.status = 'spel' and s.gestart_op < now() - interval '45 minutes' then
    perform geheim.sessie_lock(p_sessie);
    perform geheim.beeindig(p_sessie);
  end if;
  if not s.test and s.status <> 'geannuleerd' and s.host_id is distinct from v.id then
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

-- Spel stoppen en naar de onthulling (host, 45 minuten voorbij, of iedereen betrapt)
create or replace function geheim.beeindig(p_sessie uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.beschuldigingen set status = 'vervallen', afgerond_op = now()
   where sessie_id = p_sessie and status = 'open';
  update public.sessies
     set status = 'onthulling', beeindigd_op = now(), verloopt = now() + interval '24 hours',
         onthul_index = 0, onthul_stap = 'naam',
         onthul_volgorde = (select coalesce(array_agg(x.id order by random()), '{}')
                              from public.spelers x join public.toewijzingen t on t.speler_id = x.id
                             where x.sessie_id = p_sessie and not x.verwijderd)
   where id = p_sessie and status = 'spel';
end $$;

create or replace function public.beeindig_spel(p_sessie uuid)
returns void language plpgsql security definer set search_path = public as $$
declare s public.sessies;
begin
  perform geheim.eis_host(p_sessie);
  s := geheim.sessie_lock(p_sessie);
  if s.status <> 'spel' then raise exception 'spel_loopt_niet'; end if;
  perform geheim.beeindig(p_sessie);
end $$;

-- ---------------------------------------------------------------------
-- Onthulling: per speler eerst de naam, dan de opdracht(en). Geen stemrondes meer (W9).
-- ---------------------------------------------------------------------
drop function if exists public.stem(uuid, uuid, text, uuid);
drop function if exists geheim.afgewezen_van(uuid);
drop table if exists public.stemrondes;
alter table public.sessies drop column if exists onthul_check;
alter table public.beschuldigingen drop column if exists alsnog;

create or replace function public.onthul_stap(p_sessie uuid, p_vooruit boolean default true)
returns void language plpgsql security definer set search_path = public as $$
declare s public.sessies; n int;
begin
  perform geheim.eis_host(p_sessie);
  s := geheim.sessie_lock(p_sessie);
  if s.status <> 'onthulling' then raise exception 'geen_onthulling'; end if;
  n := coalesce(array_length(s.onthul_volgorde, 1), 0);
  if n = 0 then return; end if;
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
      update public.sessies set onthul_index = onthul_index - 1, onthul_stap = 'missie' where id = p_sessie;
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
      'toegewezen_op', t.toegewezen_op,
      'punten', case when t.voltooid_op is not null and not x.ontmaskerd then geheim.tijdpunten(t.toegewezen_op, t.voltooid_op) else 0 end,
      'getuigen', (select coalesce(json_agg(g.naam order by g.volgnr), '[]') from public.spelers g where g.id = any(t.getuigen)),
      'ontmaskerd', x.ontmaskerd,
      'keer_verdacht', (select count(*) from public.beschuldigingen b where b.beschuldigde_id = x.id and b.status <> 'vervallen'),
      -- W10: wie betrapte (eerste + wie het ook zag)
      'betrapt_door', (select json_build_object('op', b.afgerond_op,
                          'eerste', (select e.naam from public.spelers e where e.id = b.eerste_beschuldiger_id),
                          'ook', (select coalesce(json_agg(e.naam order by d.tijdstip), '[]') from public.deelnames d
                                    join public.spelers e on e.id = d.speler_id where d.beschuldiging_id = b.id and d.rol = 'meedoener'),
                          'punten', (select coalesce(json_agg(json_build_object('naam', e.naam, 'rol', d.rol, 'punten', d.punten) order by d.tijdstip), '[]')
                                       from public.deelnames d join public.spelers e on e.id = d.speler_id where d.beschuldiging_id = b.id))
                         from public.beschuldigingen b where b.beschuldigde_id = x.id and b.status = 'toegegeven'
                         order by b.afgerond_op desc limit 1),
      'afgewezen', (select coalesce(json_agg(json_build_object(
                        'id', b.id,
                        'door', (select coalesce(json_agg(e.naam order by d.tijdstip), '[]') from public.deelnames d
                                   join public.spelers e on e.id = d.speler_id where d.beschuldiging_id = b.id),
                        'op', b.aangemaakt, 'door_host', b.door_host, 'toch_raak', b.toch_raak)
                        order by b.aangemaakt), '[]'::json)
                      from public.beschuldigingen b
                     where b.beschuldigde_id = x.id and b.status = 'afgewezen'),
      -- W7: eerder geflikte opdrachten van deze speler
      'eerdere', (select coalesce(json_agg(json_build_object('tekst', geheim.ontsleutel(a.tekst_enc),
                        'voltooid_op', a.voltooid_op, 'punten', a.punten,
                        'toch_betrapt', exists (select 1 from public.beschuldigingen o where o.beschuldigde_id = x.id and o.toch_raak and o.missie_id = a.missie_id),
                        'getuigen', (select coalesce(json_agg(g.naam), '[]') from public.spelers g where g.id = any(a.getuigen)))
                        order by a.voltooid_op), '[]'::json)
                    from public.afgeronde_opdrachten a where a.speler_id = x.id)
    ) order by x.volgnr), '[]'::json)
    from public.spelers x join public.toewijzingen t on t.speler_id = x.id
    where x.sessie_id = p_sessie and not x.verwijderd
  );
end $$;



create or replace function public.naar_scorebord(p_sessie uuid)
returns void language plpgsql security definer set search_path = public as $$
declare s public.sessies;
begin
  perform geheim.eis_host(p_sessie);
  s := geheim.sessie_lock(p_sessie);
  if s.status <> 'onthulling' then raise exception 'geen_onthulling'; end if;
  -- W11: punten per geflikte opdracht volgens tijd; de huidige opdracht telt niet als je erop betrapt bent
  update public.spelers x
     set missie_punten = q.punten,
         missie_gehaald = q.aantal > 0,
         opdrachten_geflikt = q.aantal,
         eindscore = x.punten_beschuldiging + q.punten
    from (
      select sp.id,
             coalesce((select sum(a.punten) from public.afgeronde_opdrachten a where a.speler_id = sp.id), 0)
             + case when t.voltooid_op is not null and not sp.ontmaskerd then geheim.tijdpunten(t.toegewezen_op, t.voltooid_op) else 0 end as punten,
             (select count(*) from public.afgeronde_opdrachten a where a.speler_id = sp.id)
             + case when t.voltooid_op is not null and not sp.ontmaskerd then 1 else 0 end as aantal
        from public.spelers sp left join public.toewijzingen t on t.speler_id = sp.id
       where sp.sessie_id = p_sessie
    ) q
   where q.id = x.id;
  update public.sessies set status = 'einde' where id = p_sessie;
end $$;

-- Host bij de onthulling: een "Mooi niet!" was toch raak (of dat terugdraaien).
-- Betrappers krijgen dan de punten van een goede betrapping; de opdracht waarop het ging levert niets op.
create or replace function public.host_toch_raak(p_beschuldiging uuid, p_raak boolean default true)
returns void language plpgsql security definer set search_path = public as $$
declare b public.beschuldigingen; s public.sessies; d record; v_nieuw int;
begin
  select * into b from public.beschuldigingen where id = p_beschuldiging;
  if not found then raise exception 'onbekend'; end if;
  perform geheim.eis_host(b.sessie_id);
  s := geheim.sessie_lock(b.sessie_id);
  if s.status <> 'onthulling' then raise exception 'geen_onthulling'; end if;
  select * into b from public.beschuldigingen where id = p_beschuldiging for update;
  if b.status <> 'afgewezen' or b.toch_raak = p_raak then return; end if;
  for d in select * from public.deelnames where beschuldiging_id = b.id loop
    v_nieuw := case when p_raak then geheim.betrap_punten(d.rol, true, d.speler_id, d.sessie_id, b.id)
                    else case d.rol when 'eerste' then -2 else -1 end end;
    update public.spelers set punten_beschuldiging = punten_beschuldiging - d.punten + v_nieuw where id = d.speler_id;
    update public.deelnames set punten = v_nieuw where beschuldiging_id = d.beschuldiging_id and speler_id = d.speler_id;
  end loop;
  update public.beschuldigingen set toch_raak = p_raak where id = b.id;
  -- de opdracht waarop het ging: eerder geflikt -> 0 punten; de huidige -> telt als betrapt
  if exists (select 1 from public.afgeronde_opdrachten a where a.speler_id = b.beschuldigde_id and a.missie_id = b.missie_id) then
    update public.afgeronde_opdrachten a
       set punten = case when p_raak then 0 else geheim.tijdpunten(a.toegewezen_op, a.voltooid_op) end
     where a.speler_id = b.beschuldigde_id and a.missie_id = b.missie_id;
  else
    update public.spelers x
       set ontmaskerd = p_raak or exists (select 1 from public.beschuldigingen o where o.beschuldigde_id = x.id and o.id <> b.id
                                                    and (o.status = 'toegegeven' or o.toch_raak) and o.missie_id is not distinct from b.missie_id),
           ontmaskerd_op = case when p_raak then coalesce(x.ontmaskerd_op, now()) else x.ontmaskerd_op end
     where x.id = b.beschuldigde_id;
  end if;
end $$;

-- W12: nog een ronde met dezelfde spelers. Uitgedeelde opdrachten komen niet terug.
create or replace function public.nieuwe_ronde(p_sessie uuid)
returns void language plpgsql security definer set search_path = public as $$
declare s public.sessies;
begin
  perform geheim.eis_host(p_sessie);
  s := geheim.sessie_lock(p_sessie);
  if s.status not in ('onthulling', 'einde') then raise exception 'spel_loopt_nog'; end if;
  update public.sessies
     set gebruikte_missies = array(select distinct x from (
             select unnest(s.gebruikte_missies) x
             union select t.missie_id from public.toewijzingen t where t.sessie_id = p_sessie
             union select unnest(t.gewisseld) from public.toewijzingen t where t.sessie_id = p_sessie
             union select a.missie_id from public.afgeronde_opdrachten a where a.sessie_id = p_sessie) q),
         status = 'lobby', ronde = ronde + 1, gestart_op = null, beeindigd_op = null,
         onthul_volgorde = '{}', onthul_index = 0, onthul_stap = 'naam', host_melding = null,
         verloopt = now() + interval '3 days'
   where id = p_sessie;
  delete from public.beschuldigingen where sessie_id = p_sessie;
  delete from public.afgeronde_opdrachten where sessie_id = p_sessie;
  delete from public.toewijzingen where sessie_id = p_sessie;
  update public.spelers
     set ontmaskerd = false, ontmaskerd_op = null, punten_beschuldiging = 0, missie_punten = null,
         missie_gehaald = null, eindscore = null, opdrachten_geflikt = 0
   where sessie_id = p_sessie;
end $$;

-- Testomgeving (pincode): controleren en een testavond met zelfgekozen aantal nepspelers maken
create or replace function public.test_pin(p_pin text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'niet_ingelogd'; end if;
  if coalesce(p_pin, '') = (select waarde from geheim.config where sleutel = 'test_pin') then return true; end if;
  perform pg_sleep(1);
  return false;
end $$;

create or replace function public.maak_testsessie(p_pin text, p_host_naam text, p_aantal int default 3,
  p_thema text default 'kerst', p_moeilijkheid text default 'gemengd', p_context text[] default '{}',
  p_punten boolean default true, p_soorten text[] default null)
returns json language plpgsql security definer set search_path = public as $$
declare r json; v_sid uuid; v_host text := left(trim(coalesce(p_host_naam, '')), 20);
begin
  if not public.test_pin(p_pin) then raise exception 'pin_fout'; end if;
  r := public.maak_sessie('Testavond', v_host, p_thema, p_moeilijkheid, p_context, p_punten, p_soorten);
  v_sid := (r->>'sessie_id')::uuid;
  update public.sessies set test = true, test_eigenaar = auth.uid() where id = v_sid;
  insert into public.spelers (sessie_id, user_id, naam, volgnr, geslacht, avatar)
  select v_sid, gen_random_uuid(), n.naam, 1 + row_number() over (order by n.nr), n.g, (n.nr * 7) % 20
    from (select * from (values (1, 'Anna', 'v'), (2, 'Bert', 'm'), (3, 'Cees', 'm'), (4, 'Daan', 'm'), (5, 'Eva', 'v'),
                                (6, 'Fleur', 'v'), (7, 'Gijs', 'm'), (8, 'Hanna', 'v'), (9, 'Joris', 'm'), (10, 'Kim', 'v')) t(nr, naam, g)
           where lower(t.naam) <> lower(v_host) order by nr limit greatest(2, least(9, coalesce(p_aantal, 3)))) n;
  return r;
end $$;

-- Profiel: man/vrouw en avatar. In testmodus krijgen de nepspelers er ook een.
create or replace function public.zet_profiel(p_sessie uuid, p_geslacht text, p_avatar int)
returns void language plpgsql security definer set search_path = public as $$
declare v public.spelers; s public.sessies;
begin
  v := geheim.echte_ik(p_sessie);
  if p_geslacht not in ('m', 'v') or p_avatar is null or p_avatar not between 0 and 19 then raise exception 'ongeldig_profiel'; end if;
  update public.spelers set geslacht = p_geslacht, avatar = p_avatar where id = v.id;
  select * into s from public.sessies where id = p_sessie;
  if s.test and s.test_eigenaar = auth.uid() then
    update public.spelers
       set geslacht = case naam when 'Anna' then 'v' else 'm' end, avatar = (volgnr * 7) % 20
     where sessie_id = p_sessie and id <> v.id and geslacht is null;
  end if;
end $$;

-- W4: pushabonnement van dit toestel koppelen aan je speler
create or replace function public.push_aanmelden(p_sessie uuid, p_endpoint text, p_p256dh text, p_auth text)
returns void language plpgsql security definer set search_path = public as $$
declare v public.spelers;
begin
  v := geheim.echte_ik(p_sessie);
  if coalesce(p_endpoint, '') !~ '^https://' or coalesce(p_p256dh, '') = '' or coalesce(p_auth, '') = '' then
    raise exception 'ongeldig_abonnement';
  end if;
  insert into public.push_abonnementen (endpoint, speler_id, sessie_id, p256dh, auth)
  values (p_endpoint, v.id, p_sessie, p_p256dh, p_auth)
  on conflict (endpoint) do update set speler_id = excluded.speler_id, sessie_id = excluded.sessie_id,
                                       p256dh = excluded.p256dh, auth = excluded.auth, aangemaakt = now();
end $$;

-- W5: de betrapte krijgt elke 15 seconden een trilmelding tot hij kiest (via pg_cron)
create or replace function geheim.herinner() returns void
language plpgsql security definer set search_path = public as $$
declare b record;
begin
  for b in select bb.*, (select naam from public.spelers e where e.id = bb.eerste_beschuldiger_id) as door
             from public.beschuldigingen bb
            where bb.status = 'open'
              and bb.aangemaakt < now() - interval '14 seconds'
              and (bb.herinnerd_op is null or bb.herinnerd_op < now() - interval '14 seconds') loop
    update public.beschuldigingen set herinnerd_op = now() where id = b.id;
    perform geheim.push(b.sessie_id, array[b.beschuldigde_id], jsonb_build_object(
      'titel', 'Je bent nog betrapt?!', 'tekst', coalesce(b.door, 'Iemand') || ' wacht op je antwoord: Je hebt me! of Mooi niet!',
      'tag', 'betrapt-' || b.id, 'soort', 'herinnering'));
  end loop;
end $$;

do $$ begin
  if to_regnamespace('cron') is not null then
    perform cron.unschedule(jobid) from cron.job where jobname = 'betrapt-herinnering';
    perform cron.schedule('betrapt-herinnering', '15 seconds', 'select geheim.herinner()');
  end if;
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
  if p_vervangen then delete from geheim.missies where true; end if;

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
                     when x like 'versier%' or x like 'decor%' then 'versiering'
                     else x end from unnest(v_vereist) x);

      v_doelwit := case jsonb_typeof(e->'doelwit')
                     when 'boolean' then (e->>'doelwit')::boolean
                     when 'string' then lower(e->>'doelwit') in ('ja','true','yes','1','j')
                     else false end
                   or position('{doelwit}' in v_tekst) > 0;

      v_leeftijd := lower(coalesce(nullif(trim(e->>'leeftijd'), ''), 'iedereen'));
      v_leeftijd := case when v_leeftijd like '%18%' then '18+' when v_leeftijd like 'kid%' or v_leeftijd like 'kind%' then 'kids' else 'iedereen' end;

      insert into geheim.missies (id, tekst_enc, uitleg_enc, categorie, soort, familie, moeilijkheid, thema,
                                  doelwit, heeft_woord, vereist, leeftijd, getal_min, getal_max)
      values (v_id, geheim.versleutel(v_tekst), geheim.versleutel(nullif(trim(e->>'uitleg'), '')),
              lower(coalesce(nullif(trim(e->>'categorie'), ''), 'overig')),
              case when lower(trim(e->>'soort')) in ('praten', 'sturen', 'doen') then lower(trim(e->>'soort'))
                   else geheim.soort_van(lower(trim(e->>'categorie'))) end,
              nullif(lower(trim(e->>'familie')), ''),
              v_moeil,
              lower(coalesce(nullif(trim(e->>'thema'), ''), 'algemeen')),
              v_doelwit,
              position('{woord}' in v_tekst) > 0,
              v_vereist, v_leeftijd,
              coalesce((e->>'getal_min')::int, 2), coalesce((e->>'getal_max')::int, 5))
      on conflict (id) do update set
        tekst_enc = excluded.tekst_enc, uitleg_enc = excluded.uitleg_enc, categorie = excluded.categorie, soort = excluded.soort,
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
    delete from geheim.woorden where true;
    insert into geheim.woorden (woord_enc, thema)
      select geheim.versleutel(trim(x)), 'algemeen' from jsonb_array_elements_text(p_woorden) x where trim(x) <> '';
  elsif p_woorden is not null and jsonb_typeof(p_woorden) = 'object' then
    delete from geheim.woorden where true;
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
    'maak_sessie(text,text,text,text,text[],boolean,text[])', 'join_sessie(text,text,text)',
    'overname_check(uuid)', 'host_overname(uuid,boolean)', 'start_spel(uuid)', 'mijn_missie(uuid)',
    'gebruik_joker(uuid)', 'markeer_voltooid(uuid,uuid[],boolean)', 'nieuwe_opdracht(uuid)', 'nieuwe_ronde(uuid)', 'host_toch_raak(uuid,boolean)', 'push_aanmelden(uuid,text,text,text)', 'zet_profiel(uuid,text,integer)', 'test_pin(text)', 'maak_testsessie(text,text,integer,text,text,text[],boolean,text[])', 'beschuldig(uuid,uuid)', 'meedoen(uuid)',
    'reageer(uuid,boolean)', 'host_sluit_beschuldiging(uuid)', 'host_verwijder(uuid)', 'host_extra_joker(uuid)',
    'host_melding_weg(uuid)', 'ping(uuid)', 'beeindig_spel(uuid)', 'onthul_stap(uuid,boolean)',
    'onthulling_data(uuid)', 'naar_scorebord(uuid)', 'is_lid(uuid)',
    'test_wissel(uuid,uuid)', 'annuleer_sessie(uuid)', 'verlaat_sessie(uuid)', 'beheer_overzicht(text)', 'beheer_import(text,jsonb,jsonb,boolean)'
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

-- Je beheercode voor de importpagina (bewaar hem, deel hem niet):
select waarde as beheercode from geheim.config where sleutel = 'beheer_token';
