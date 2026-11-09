# Laat je niet ontdekken!

Installeerbare web-app (PWA) waarin iedereen aan tafel een geheime missie krijgt. De app draait op GitHub Pages; Supabase is de backend (database, realtime en anonieme login).

De missies staan in `missies.json` in deze repository. **Open dat bestand niet als je zelf meespeelt.** Zodra het verandert, haalt de database het automatisch op (GitHub Action *Missies importeren*) en slaat het versleuteld op. Handmatig opnieuw importeren kan via Actions › Missies importeren › Run workflow.

## Wat zit erin (MVP voor kerst)

- Sessie aanmaken met thema (kerst/algemeen), moeilijkheid, context en punten aan/uit
- Deelnemen met 4-letterige code of QR-code; lobby met live spelerslijst
- Unieke missies per speler (geen dubbele families, spreiding over categorieën, doelwitten eerlijk verdeeld)
- Missie verborgen; vasthouden om te tonen, loslaten verbergt hem
- Joker in de eerste 10 minuten; host kan een extra joker geven
- Voltooien met optionele getuige
- Beschuldigen en meedoen met 15 seconden wachttijd (reset bij elke meedoener), daarna toegeven of afwijzen
- Punten volgens het framework, live zichtbaar
- Onthulling speler voor speler op het scherm van de host (ook op tv), stemmen met duim omhoog/omlaag
- Scorebord met titels
- Speluitleg en 3 uitlegkaarten bij de eerste keer
- Randgevallen: laatkomers, speler verwijderen (gratis wissel voor wie hem als doelwit had), host valt weg (hostrol schuift door), dubbele namen, telefoon leeg (overname met bevestiging van de host), geen reactie op een beschuldiging (host sluit na 2 minuten), pool raakt op (filters versoepelen + melding)

## Installeren: eenmalig

### 1. Supabase-project

1. Maak een gratis project op [supabase.com](https://supabase.com) (regio: Europa, bijv. Frankfurt).
2. **Anonieme login aanzetten:** Authentication › Sign In / Providers › *Allow anonymous sign-ins* aan.
3. **Limiet ophogen:** Authentication › Rate Limits › anonieme aanmeldingen per uur naar 100. Standaard is 30 per IP-adres per uur, en aan tafel zit iedereen op dezelfde wifi.
4. **Database:** SQL Editor › New query › plak de hele inhoud van `supabase/schema.sql` › Run.
   De laatste regel van de uitkomst is je **beheercode**. Bewaar die (bijv. in je wachtwoordmanager).
5. **Gegevens voor de app:** Project Settings › API. Kopieer de *Project URL* en de *anon public key* (in nieuwere projecten heet die de *publishable key*; die werkt ook).

### 2. App op GitHub Pages

1. Maak op GitHub een nieuwe **openbare** repository, bijv. `laat-je-niet-ontdekken`.
2. Zet de bestanden uit deze map erin (Add file › Upload files, of via git).
3. `config.js` bevat de Project URL en de anon key van je project. De anon key mag openbaar zijn: daarmee kun je de missies niet lezen.
4. Settings › Pages › Source: *Deploy from a branch*, branch `main`, map `/ (root)`.
5. Na een minuut staat de app op `https://<jouw-gebruikersnaam>.github.io/laat-je-niet-ontdekken/`.

### 3. Missies erin zetten

Zet `missies.json` in de hoofdmap van deze repository (Add file › Upload files). De GitHub Action *Missies importeren* zet ze binnen een minuut in de database; onder Actions zie je alleen aantallen. Alternatief zonder GitHub: `beheer.html` met je beheercode.

### 4. Installeren op telefoons

- Android (Chrome): open de link › menu › *App installeren*.
- iPhone (Safari): Deel-knop › *Zet op beginscherm*.

## Voor kerst

- Een gratis Supabase-project pauzeert na een week zonder gebruik. Zet het een paar dagen van tevoren weer aan (Dashboard › *Restore project*) en speel een testrondje met 3 telefoons.
- Een spel kan pas starten met minstens 3 spelers; maximaal 20.
- Wil je de onthulling op tv: cast het scherm van de host.

## Updates uitrollen

Pas bij een nieuwe versie in `sw.js` de regel `const VERSIE = 'tafelagent-v1'` aan (v2, v3, …), zodat telefoons de nieuwe bestanden ophalen.

## Opbouw

| Bestand | Wat |
| --- | --- |
| `index.html`, `app.js`, `app.css` | De app (geen build-stap nodig) |
| `beheer.html` | Missies importeren met de beheercode |
| `config.js` | Supabase-URL en anon key |
| `sw.js`, `manifest.webmanifest`, `icons/` | Installeerbaar en offline-schil |
| `lib/qrcode.js` | QR-code maken (MIT-licentie, Kazuhiko Arase) |
| `supabase/schema.sql` | Tabellen, beveiliging (RLS), realtime en alle spelregels als databasefuncties |
| `supabase/import_van_github.sql` | Laat de database `missies.json` zelf ophalen en importeren |
| `.github/workflows/missies.yml` | Start die import automatisch als `missies.json` verandert |

Alle spelregels worden op de server afgedwongen: de app kan geen missies van anderen lezen, geen wachttijd overslaan en geen punten zelf toekennen.
