# Vehicle catalogue (unverified reference data)

Bundled make / model / generation / trim / engine data for the ClaimDesk vehicle picker, the fleet unit dialog and the
GTA group suggestion (design: `docs/TEMPLATES-VEHICLES-DESKTOP.md` §D.1–§D.6, Appendix 3). The loader and queries are
in `packages/kb/src/catalogue/`.

## Verification statement

**Compiled from general knowledge of the UK market 2000–2026 and not verified.** Confirm the make, model, generation,
trim, engine and transmission against the V5C, the DVLA record or Total Car Check before relying on them. Nothing here
is a manufacturer, DVLA, SMMT or GTA record, and every make file says `verification.status: "unverified"` with a
`sourceNote` saying so.

- No invented precision: engine strings give litres (and `cc` only where it is known); the 22 engines whose power is
  not known are written as objects without a power figure rather than with a guessed one.
- Where the UK trim names of a generation are not known, the model name stands in as the only trim and the generation
  `note` says so (123 generations). 58 van, pickup and minibus generations have an empty trim list for the same
  reason (§D.2 requires trims for cars only).
- A few entries added while closing coverage gaps were cross-checked against web search result summaries (for example
  the Aston Martin Valour / Valiant / V12 Speedster / DBR22, MGS6 EV, VW Grand California, BYD e6 and Shark, BMW
  Alpina, Daewoo-badged Musso and Korando, Alfa Romeo 4C, DS 9, SEAT Inca, Subaru Justy, Lexus LFA, Maxus eTerron 9).
  That does not make them verified; the weakest points are called out in generation notes.
- `gtaGroup` values (84, on models and generations) are ClaimDesk starting suggestions where there is a reason to
  differ from the segment default in `packages/kb/data/gta-segment-defaults.json` — not the GTA vehicle list.

## Totals

**75 makes, 1,061 models, 1,821 generations, 8,700 trims, 8,863 engines.** Models by type: 945 cars, 71 vans, 24 pickups, 18 minibuses, 3 campers; 242 models have at least one electric engine. `features.json`: 330 items in 15 categories.

| Make | Slug | Models | Generations | Trims | Engines | Types |
|---|---|---:|---:|---:|---:|---|
| Abarth | `abarth` | 7 | 10 | 38 | 19 | car |
| Alfa Romeo | `alfa-romeo` | 17 | 25 | 138 | 145 | car |
| Alpine | `alpine` | 3 | 4 | 22 | 8 | car |
| Aston Martin | `aston-martin` | 19 | 27 | 89 | 53 | car |
| Audi | `audi` | 21 | 47 | 304 | 466 | car |
| Bentley | `bentley` | 8 | 17 | 95 | 46 | car |
| BMW | `bmw` | 41 | 115 | 345 | 627 | car |
| BYD | `byd` | 12 | 14 | 34 | 30 | car, pickup |
| Cadillac | `cadillac` | 7 | 8 | 17 | 16 | car |
| Caterham | `caterham` | 1 | 3 | 45 | 21 | car |
| Chery | `chery` | 4 | 4 | 7 | 6 | car |
| Chevrolet | `chevrolet` | 16 | 18 | 49 | 54 | car |
| Chrysler | `chrysler` | 11 | 16 | 51 | 47 | car |
| Citroen | `citroen` | 36 | 60 | 325 | 374 | car, van, minibus |
| Cupra | `cupra` | 7 | 7 | 36 | 38 | car |
| Dacia | `dacia` | 7 | 11 | 55 | 39 | car |
| Daewoo | `daewoo` | 10 | 11 | 24 | 22 | car |
| Daihatsu | `daihatsu` | 9 | 13 | 23 | 20 | car |
| Dodge | `dodge` | 4 | 4 | 13 | 12 | car |
| DS Automobiles | `ds` | 6 | 11 | 64 | 57 | car |
| Ferrari | `ferrari` | 28 | 30 | 74 | 42 | car |
| Fiat | `fiat` | 33 | 58 | 255 | 266 | car, van, minibus, pickup |
| Ford | `ford` | 40 | 80 | 436 | 507 | car, van, minibus, pickup |
| Genesis | `genesis` | 7 | 7 | 19 | 14 | car |
| Great Wall | `great-wall` | 1 | 1 | 2 | 1 | pickup |
| GWM | `gwm` | 3 | 4 | 14 | 7 | car |
| Honda | `honda` | 18 | 38 | 167 | 93 | car |
| Hyundai | `hyundai` | 38 | 54 | 206 | 196 | car, van |
| Ineos | `ineos` | 2 | 2 | 8 | 4 | car, pickup |
| Infiniti | `infiniti` | 8 | 12 | 55 | 31 | car |
| Isuzu | `isuzu` | 3 | 5 | 23 | 11 | car, pickup |
| Iveco | `iveco` | 3 | 13 | 74 | 88 | van, minibus, pickup |
| Jaecoo | `jaecoo` | 4 | 4 | 10 | 7 | car |
| Jaguar | `jaguar` | 10 | 18 | 146 | 112 | car |
| Jeep | `jeep` | 8 | 20 | 95 | 80 | car |
| Kia | `kia` | 25 | 48 | 225 | 174 | car, van |
| Lamborghini | `lamborghini` | 8 | 13 | 57 | 28 | car |
| Land Rover | `land-rover` | 8 | 22 | 179 | 157 | car |
| LDV | `ldv` | 21 | 24 | 13 | 38 | van, minibus, pickup, car |
| Leapmotor | `leapmotor` | 3 | 3 | 3 | 5 | car |
| LEVC | `levc` | 5 | 5 | 9 | 5 | car, van |
| Lexus | `lexus` | 15 | 27 | 114 | 56 | car |
| Lotus | `lotus` | 11 | 16 | 78 | 41 | car |
| Maserati | `maserati` | 9 | 13 | 71 | 43 | car |
| Mazda | `mazda` | 24 | 36 | 217 | 125 | car, pickup |
| McLaren | `mclaren` | 18 | 19 | 38 | 21 | car |
| Mercedes-Benz | `mercedes-benz` | 47 | 95 | 409 | 662 | car, camper, van, minibus, pickup |
| MG | `mg` | 19 | 28 | 99 | 65 | car |
| MINI | `mini` | 9 | 18 | 164 | 120 | car, van |
| Mitsubishi | `mitsubishi` | 18 | 30 | 144 | 83 | car, pickup, van |
| Morgan | `morgan` | 9 | 16 | 38 | 19 | car |
| Nissan | `nissan` | 33 | 54 | 258 | 200 | car, van, pickup |
| Omoda | `omoda` | 4 | 5 | 11 | 8 | car |
| Perodua | `perodua` | 4 | 4 | 4 | 4 | car |
| Peugeot | `peugeot` | 33 | 52 | 301 | 377 | car, van, minibus |
| Polestar | `polestar` | 3 | 4 | 25 | 14 | car |
| Porsche | `porsche` | 7 | 23 | 203 | 207 | car |
| Proton | `proton` | 8 | 9 | 16 | 16 | car, pickup |
| Renault | `renault` | 28 | 56 | 358 | 374 | car, van, minibus |
| Rolls-Royce | `rolls-royce` | 8 | 13 | 34 | 19 | car |
| Rover | `rover` | 6 | 9 | 60 | 41 | car |
| Saab | `saab` | 3 | 8 | 39 | 49 | car |
| SEAT | `seat` | 13 | 23 | 170 | 209 | car, van |
| Skoda | `skoda` | 15 | 25 | 195 | 218 | car |
| smart | `smart` | 6 | 9 | 51 | 47 | car |
| SsangYong | `ssangyong` | 11 | 21 | 49 | 42 | pickup, car |
| Subaru | `subaru` | 13 | 29 | 92 | 76 | car |
| Suzuki | `suzuki` | 17 | 26 | 85 | 76 | car |
| Tata | `tata` | 2 | 2 | 1 | 2 | car, pickup |
| Tesla | `tesla` | 5 | 8 | 53 | 31 | car |
| Toyota | `toyota` | 40 | 71 | 305 | 219 | car, pickup, van |
| Vauxhall | `vauxhall` | 33 | 63 | 418 | 454 | car, van, minibus |
| Volkswagen | `volkswagen` | 45 | 85 | 495 | 654 | car, van, camper, minibus, pickup |
| Volvo | `volvo` | 21 | 35 | 253 | 317 | car |
| Xpeng | `xpeng` | 2 | 3 | 8 | 8 | car |
| **Total (75 makes)** | | **1061** | **1821** | **8700** | **8863** | |

## Files

| File | What it is |
|---|---|
| `makes/<slug>.json` | One file per make in the §D.2 schema (compact form; the loader normalises it). |
| `index.json` | Generated: one summary row per make. Do not edit — run `node packages/kb/scripts/build-catalogue-index.mjs`. |
| `features.json` | Features and extras vocabulary (§D.3): `schemaVersion: 1`, the 15 fixed categories, 330 items, each with `id`, `label`, optional `aliases` and `kind` = `feature` (usually standard), `extra` (option or after-market fit) or `both`. |
| `reference/uk-licensing-models.json` | Coverage reference only, never loaded at runtime (see *Coverage* below). |

## Schema summary (§D.2)

- **Make:** `make` (display name as on the V5C), `slug` (= file name), `dvlaNames` (upper-case DVLA spellings, e.g.
  `MERCEDES-BENZ`, `LAND ROVER`, `CITROEN`, `SSANGYONG` + `KGM`, `LDV` + `MAXUS`, `GWM` + `ORA`), `aliases` (other
  spellings and former names), `verification` (`status: "unverified"`, `sourceNote`), `models`.
- **Model:** `name`, `slug` (unique in the make), `aliases` (used by `matchCatalogue`; unique across the make's models),
  `vehicleType` (`car` `van` `pickup` `minibus` `camper`), `segment` (the 19 §D.2 segments), `years` (UK new-sale
  years, `from` ≥ 2000 = the earliest generation, `to: null` = still on sale), optional `gtaGroup`, `generations`.
- **Generation:** `name` (code + real years, e.g. `Mk7 (2012–2020)`), optional `id`, `from`/`to` (UK sale years inside
  the model range), `bodies` (`body`, `doors` ⊂ {2,3,4,5}, `seats` 1–9, a `minibus` up to 17), `trims` (strings, or
  objects with `name`, `from`/`to`, `bodies`, `engines`, `features` (ids from `features.json`), `gtaGroup`),
  `engines`, `fuels` (= the union of the engine fuels), `transmissions` (all-electric generations are `automatic`
  only), optional `gtaGroup` (`/^[A-Z]{1,3}\d{0,2}$/`) and `note`.
- **Engine strings:** `[<litres>] <name words…> <power>PS <fuel>`, fuel last (`mild-hybrid petrol|diesel` as the last
  two tokens), e.g. `1.0 EcoBoost 125PS petrol`, `2.0 EcoBlue 130PS mild-hybrid diesel`, `1.4 TSI 204PS
  plug-in-hybrid`, `77kWh Pro 204PS electric`. Electric engines omit litres and may carry `<n>kWh`. Object engines
  (`label`, `fuel`, optional `cc`, `powerPs`, `powerKw`, `batteryKwh`, `transmissions`, `from`/`to`) are used where a
  string cannot be written without inventing a figure. A diesel plug-in hybrid keeps `diesel` as a name word
  (`2.0 diesel 306PS plug-in-hybrid`); a range extender (BMW i3 REx, LEVC TX) is a `plug-in-hybrid` because §D.2 has
  no range-extender fuel.
- **Limits:** slugs match `/^[a-z0-9]+(-[a-z0-9]+)*$/` and equal `slugify(name)` unless deliberately different
  (`ds` for DS Automobiles, `ds-no8` for DS N°8, `smart-1`/`smart-3`/`smart-5` for smart #1/#3/#5 — the checker
  reports these 5 as warnings); file size ≤ 600 KB per make.

## Conventions

- Scope (§D.4): cars and light commercials ≤ 3.5 t sold new in the UK in 2000–2026, UK-market right-hand drive only,
  no grey imports. Models sold here in left-hand drive only are left out and named in the make's `sourceNote`
  (Alfa Romeo 8C, Porsche 918 and Carrera GT, Chevrolet Camaro and Corvette C6/C7, Jeep Gladiator, Polestar 1, the 2007
  Opel GT roadster under Vauxhall, VW XL1, Fiat barchetta).
- Range Rover models are models of Land Rover; Opel is not a UK make (Vauxhall).
- Maxus is part of the LDV file (`dvlaNames` LDV, MAXUS); the 2021+ Maxus Deliver 9, T60 and eTerron 9 continue the
  LDV models.
- GWM and Ora share the `gwm` file; the Great Wall Steed pickup is `great-wall`. DS models sold as Citroën
  (DS3/DS4/DS5 to 2015) are in `citroen`; DS Automobiles (2015+) is `ds` (alias "DS Automobiles").
- The classic Mini sold new in 2000 is a Rover model; the 2001-on MINI is the `mini` make. Daewoo-badged SsangYong
  Musso and Korando (2000–2002) are Daewoo models.
- Chery (slug `chery`; UK launch 2025) is the one make outside Appendix 3.
- Van-based minibuses with more than nine seats are separate `minibus` models (`Relay Minibus`, `Daily Minibus` …).
- Doorless cars (Caterham Seven, Morgan 3 Wheeler, Lotus 3-Eleven) record doors as 2 with a note.
- Lynk & Co is not included: it was sold in Europe in left-hand drive only.
- Aliases also carry DVLA/DfT model spellings seen in the licensing data, so `matchCatalogue` finds them: `5` / `4`
  (Renault 5 / 4 E-Tech), `AMG C 63`, `AMG GLE 53`, `G450`, `S450`, `V300` (Mercedes-Benz), `FPCE` / `FPC` (Jaguar
  F-Pace), `Discovry` (Land Rover), `Sovereign` (Jaguar XJ), `First`, `Paddy Hopkirk Edition`, `Inspired by Goodwood`
  (MINI Hatch).

## Checks

```
node packages/kb/scripts/check-catalogue.mjs                       # schema + per-make counts; exit 1 on any error
node packages/kb/scripts/check-catalogue.mjs --reference reference/uk-licensing-models.json   # + coverage report
node packages/kb/scripts/build-catalogue-index.mjs [--check]       # (re)build or verify index.json
pnpm --filter @ccguk/kb exec vitest run src/catalogue/data.test.ts
```

At the last run the checker exited 0 with no schema errors (5 slug warnings, listed above), `index.json` was up to
date, every make file passed `validateCatalogueMake` in strict mode, and `data.test.ts` passed. `data.test.ts` runs
both scripts, validates every make file, checks the Appendix 3 makes, the spot checks (Ford Fiesta 2000–2023, VW Golf
Mk4–Mk8, Vauxhall Corsa-e, Tesla Model 3 electric/automatic only, Range Rover Evoque under Land Rover, Toyota Hilux
pickup, Ford Transit Custom van) and the features vocabulary.

## Coverage against the DfT/DVLA licensing reference

`reference/uk-licensing-models.json` is `[MAKE, [[MODEL, firstYear, lastYear, vehicleTypes]]]` for years 2005–2025
(cars and goods vehicles), extracted once from `@meterapp/vehicle-db@2.14.0`, source `uk-dft-vehicle-licensing`:
UK Department for Transport / DVLA vehicle licensing statistics
(https://www.gov.uk/government/statistical-data-sets/vehicle-licensing-statistics-data-files), Open Government
Licence v3.0 (https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/).

**Contains public sector information licensed under the Open Government Licence v3.0.**

It is a licensing (registered-fleet) list, not a new-sales list: it also holds classics, grey imports, motorhome
converters, heavy trucks, plant and motorcycles recorded under car makes, and DVLA derivative strings in the model
column. A reference model counts as matched when its name, after the make prefix is dropped, equals or starts with a
catalogue model name or alias (whole-word for short names), as the runtime `matchCatalogue` does; the coverage check
also accepts a bare reference name that is the start of an alias (`AMG C` → `AMG C 63`).

**The §D.4 bar (≤ 5 % unmatched per priority make) is not met on the raw counts**: across the 33 priority makes 883 of 1,549 reference models match and 666 (43.0 %) do not, and 29 of the 33 makes are above 5 % (the other 42 makes with reference entries: 330 of 404 match). Every unmatched
entry of every catalogue make is listed below with its reason, and the checker's `--reference` mode reports any
unmatched entry that this README does not mention. Only 8 of the priority-make entries (0.5 % of their reference models; above 5 % of a make only for Mazda 2 of 35 and Mitsubishi 2 of 23) point at possible gaps in the catalogue; all
the others are outside the §D.4 scope or name no single model.

179 reference makes have no catalogue make at all and are not listed one by one: classic marques (Austin, Morris, Triumph, Hillman …), motorhome converters recorded as the make, truck, plant, motorcycle and quad makers, and a few UK-sold makes outside the Appendix 3 list (for example Daimler, Maybach, TVR, Noble, Reva, Piaggio and Fisker) that are candidates for a later extension.

### Coverage summary for the priority makes

| Make | Reference models | Matched | Unmatched | Unmatched % | Possible catalogue gaps¹ |
|---|---:|---:|---:|---:|---:|
| Ford | 105 | 39 | 66 | 62.9 % | 0 |
| Vauxhall | 57 | 42 | 15 | 26.3 % | 0 |
| Volkswagen | 81 | 46 | 35 | 43.2 % | 0 |
| BMW | 50 | 33 | 17 | 34.0 % | 0 |
| Mercedes-Benz | 150 | 108 | 42 | 28.0 % | 0 |
| Audi | 59 | 47 | 12 | 20.3 % | 1 (1.7 %) |
| Toyota | 58 | 28 | 30 | 51.7 % | 1 (1.7 %) |
| Nissan | 54 | 35 | 19 | 35.2 % | 0 |
| Kia | 29 | 27 | 2 | 6.9 % | 0 |
| Hyundai | 51 | 45 | 6 | 11.8 % | 0 |
| Peugeot | 97 | 50 | 47 | 48.5 % | 0 |
| Renault | 66 | 36 | 30 | 45.5 % | 1 (1.5 %) |
| Skoda | 17 | 13 | 4 | 23.5 % | 0 |
| Honda | 80 | 17 | 63 | 78.8 % | 0 |
| Citroen | 65 | 33 | 32 | 49.2 % | 1 (1.5 %) |
| Fiat | 198 | 39 | 159 | 80.3 % | 0 |
| MINI | 21 | 19 | 2 | 9.5 % | 0 |
| SEAT | 14 | 13 | 1 | 7.1 % | 0 |
| Mazda | 35 | 21 | 14 | 40.0 % | 2 (5.7 %) |
| Land Rover | 12 | 10 | 2 | 16.7 % | 0 |
| Volvo | 57 | 24 | 33 | 57.9 % | 0 |
| MG | 22 | 17 | 5 | 22.7 % | 0 |
| Tesla | 5 | 5 | 0 | 0.0 % | 0 |
| Dacia | 10 | 9 | 1 | 10.0 % | 0 |
| Suzuki | 30 | 18 | 12 | 40.0 % | 0 |
| Jaguar | 19 | 13 | 6 | 31.6 % | 0 |
| Lexus | 42 | 42 | 0 | 0.0 % | 0 |
| Cupra | 6 | 6 | 0 | 0.0 % | 0 |
| Mitsubishi | 23 | 17 | 6 | 26.1 % | 2 (8.7 %) |
| Porsche | 12 | 9 | 3 | 25.0 % | 0 |
| BYD | 10 | 9 | 1 | 10.0 % | 0 |
| Polestar | 5 | 4 | 1 | 20.0 % | 0 |
| DS Automobiles | 9 | 9 | 0 | 0.0 % | 0 |
| **All 33 priority makes** | **1549** | **883** | **666** | **43.0 %** | **8 (0.5 %)** |

Other makes: 330 of 404 reference models matched (74 unmatched, 18.3 %).

¹ Entries whose reason is *possibly sold new in the UK in 2000 or later* or *UK-sold model not yet in the catalogue* — the only
reasons that point at missing catalogue data. Every other unmatched entry is outside the §D.4 scope (pre-2000, conversion,
heavy, non-car, grey import, left-hand drive only, limited run) or is a source string that names no single model.

### Reasons

- **Pre-2000** — Pre-2000 only: a classic, or a model whose UK new sales ended before 2000.
- **Conversion** — Converter, coachbuilder or conversion range recorded as the model (motorhome, campervan, wheelchair-accessible vehicle, taxi, hearse, horsebox, minibus).
- **Heavy / plant** — Heavy commercial over 3.5 t, or plant / construction machinery.
- **Non-car** — Motorcycle, scooter, quad / ATV or utility side-by-side recorded under the car make.
- **Grey import** — Grey or personal import: a model for another market that was never sold new in the UK.
- **LHD only** — Left-hand drive only in the UK, or UK right-hand-drive supply not confirmed (§D.4 lists UK-market RHD models only).
- **Limited run** — Limited-run special or continuation car, not catalogued as a model (§D.4: not every limited run).
- **Derivative string** — Derivative, trim, edition, body or engine string with no model name that can be resolved to one catalogue model.
- **Typo / truncation** — Typo or truncation of a model that is in the catalogue.
- **Other make** — Another make, or the make itself, recorded in the model column.
- **To check** — Possibly sold new in the UK in 2000 or later; not added because the UK sale years could not be confirmed from general knowledge (to check).
- **Missing** — UK-sold model not yet in the catalogue (to add after checking the UK specification).
- **Unidentified** — Unidentified source string: no UK-market model of that name is known (most look like converter, edition or engine names).

### Unmatched reference models of the priority makes, with reasons

**Audi** (`audi`, 12 of 59):

- *Pre-2000* — 100, 200, 60, 70, 80, 90, COUPE, QUATTRO, V8
- *Derivative string* — AVANT
- *To check* — CABRIOLET (the B4-based Cabriolet ended in 2000)
- *Unidentified* — C

**BMW** (`bmw`, 17 of 50):

- *Pre-2000* — 1502, 1600, 1602, 1800, 2000, 2002, 2500, 3.0 CS, 3.0 S, 3.3 L, 3000, M1
- *Non-car* — K SERIES, R SERIES
- *Limited run* — 3.0 CSL (2023 3.0 CSL, 50 built)
- *Derivative string* — M SERIES (an M model without the model number), M7 SERIES (there is no M7; probably a 7 Series M Sport)

**BYD** (`byd`, 1 of 10):

- *LHD only* — ETP (ETP3 small electric van: a few came in through UK dealers 2023–24, but a UK right-hand-drive version could not be confirmed; gap-fill decision, add it if BYD UK confirms RHD)

**Citroen** (`citroen`, 32 of 65):

- *Pre-2000* — 2CV, AX, BX, CX, D SAFARI, D SPECIAL, D SUPER, DS, DS20, DS21, DYANE, G SPECIAL, GS, GSA, SAFARI, SM, VISA, ZX
- *Conversion* — ADRIA, ALLIED ELUNAR, ALLIED FLEXILITE, ALLIED HORIZON, ALLIED LUNAR, BURSTNER, CAPRON CARADO A132 AUTO, DETHLEFFS, HYMER, PILOTE, PLA, WILDAX
- *To check* — XM (production ended in 2000; UK sales probably ended in 1999–2000)
- *Unidentified* — 1800

**Dacia** (`dacia`, 1 of 10):

- *Grey import* — PICK-UP (Dacia was not sold new in the UK before 2013)

**Fiat** (`fiat`, 159 of 198):

- *Pre-2000* — 1100, 127, 128, 130, 132, 850, ARGENTA, CINQUECENTO, DINO, REGATA, TEMPRA, UNO
- *Conversion* — ADRIA, ADRIA CORAL 60Y 670 DL AUTO, ADRIA CORAL PLUS, ADRIA CORAL SUPREME, AUTO SLEEPERS, AUTO TRAIL, AUTO TRAIL EXPEDITION, AUTO TRAIL FRONTIER, AUTO TRAIL IMALA, AUTO TRAIL V LINE, AUTO-SLEEP BROADWAY EK TB LP A, AUTO-SLEEPERS, AUTO-SLEEPERS ACTIVE, AUTO-SLEEPERS FG635, AUTO-TRAIL, AUTO-TRAIL EXPEDITION 54, AUTOCRUISE, AUTOSLEEPERS BROADWAY EK TB LP, AUTOTRAIL, BAVARIA, BENIMAR, BENIMAR B144PS, BENIMAR OCARSA, BENIMAR OCARSA PRIMERO, BESSACARR, BURSTNER, C-COMPACTLINE, C1TOUR, CAPRON CARADO, CAPRON SUNLIGHT, CARADO, CARTHAGO C-COMPACTLINEI141LE A, CARTHAGO C-TOURER I 144 QB A, CARTHAGO MALIBU, CARTHAGO MALIBU VAN 600DB GT A, CHAUSSON, CHIC C-LINE I, CHIC C-LINE T, CHIC E-LINE I, CI, COMPASS, DELFIN, DETHLEFFS, DREAMER, ELDDIS, ELDDIS WHIRLWIND, ELISEO, ERWIN HYMER ELDDIS XPLORE CX5, ERWNHYMR ELDDS AUTOQST APX 185, ESCAPE, ETRUSCO, FLEURETTE, FUSION 330, GIOTTILINE 350 AUTOMATIC, GIOTTIVAN 54T AUTOMATIC, GIOTTIVAN 60T AUTOMATIC, HOBBY, HYMER, HYMER ELDDIS ACCORDO 105, HYMER ELDDIS AUTOQUEST 115, HYMER ELDDIS AUTQST APEXCV20 A, HYMER ELDDIS AVALON 250, HYMER ELDDIS CHATSWORTH 115, HYMER ELDDIS EVOLUTION 105, HYMER ELDDIS MAGNUM GT 115, HYMER ELDDIS PLATINUM 115, HYMER ELDDIS SORENTO 115, HYMERCAR, ITINEO, K-YACHT TEKNO LINE 59 UK, KABE TRAVELMASTER, KEA P 80 UK, KNAUS, KNAUS BOXLFE PLATNM SELCT540MQ, KNAUS BOXLIFE 540 MQ, KNAUS BOXLIFE 600 DQ, KNAUS BOXLIFE 630 ME AUTO, KNAUS BOXLIFE PRO 600 LIFETIME, KNAUS LVETI PLATNM SELCT 650MF, KNAUS SUN I 700 LEG AUTO, KNAUS VAN I 550 MF AUTO, LAIKA ECOVIP 540, LAIKA ETRUSCO, LAIKA ETRUSCO 540 DB AUTO, LAIKA ETRUSCO 600 DB AUTO, LAIKA KOSMO 50, LAIKA KREOS 5009 AUTO, LINER-FOR-TWO, LUANO CAMP, LUANO CAMP RIMOR HORUS 12, LUANO CAMP RIMOR HORUS 40, LUANO CAMP RIMOR SARUS 3, LUANO CAMP RIMOR SUPERBRG 687A, LYSEO, MALIBU I, MALIBU T, MALIBU VAN 540 DB, MALIBU VAN 600, MCLOUIS FUSION, MIZAR, MOBILVETTA, NEXXO, NIESMANN, NIESMANN BISCHOFF ISMOVE 6.9EA, NIESMANN+BISCHOFF, PILOTE, PILOTE 54G JOA AUTO, PRIMERO, RAPIDO, RIMOR, ROLLER, ROLLER TEAM, ROLLER TEAM LIVINGSTNE2 SPRT A, ROLLER TEAM LIVINGSTONE6 SPORT, ROLLER TEAM PEGASO 590, ROLLER TEAM T LINE 590, SUN LIVING, SUNLIGHT, SWIFT, SWIFT CARRERA, SWIFT EDGE, SWIFT ESCAPE, SWIFT HI-STYLE, SWIFT KON-TIKI, TRIBUTE, TRIGANO, TRIGANO VDL, WEINSBERG, WEINSBERG CARABS ED FRE600DQ A, WEINSBERG CARABUS, WEINSBERG CARACORE 650 MEG, WEINSBERG CARATOUR 540 MQ, WEINSBERG CRCMPCT ED PEPR600MF, WESTFALIA, WILDAX AURORA, WILDAX CONSTELLATION, WILDAX EUROPA, WILDAX PULSAR, WILDAX SOLARIS
- *LHD only* — BARCHETTA (barchetta was built in left-hand drive only)
- *Derivative string* — NON-CAR DERIVED VAN
- *Typo / truncation* — ULYSEE (Ulysse)
- *Unidentified* — 252, 5, CITIVAN, FREEDOM, TREND

**Ford** (`ford`, 66 of 105):

- *Pre-2000* — 12M/15M, 17M/20M, ANGLIA, CLASSIC, CONSUL, CORSAIR, CORTINA, GRANADA, ORION, POPULAR, SAPPHIRE, SCORPIO, SIERRA, ZEPHYR
- *Conversion* — ADRIA A 70 DK, ADRIA S 72 DC, ALLIED, AUTO SLEEPERS, AUTO TRAIL, AUTO TRAIL EXCEL, AUTO TRAIL F LINE F60, AUTO-TRAIL, AUTO-TRAIL EXCEL 620G, AUTO-TRAIL F60, BAILEY, BAILEY ADAMO, BENIMAR, BENIMAR OCARSA, CAPRON CARADO T338T, CARDINAL HEARSE, CHAUSSON, CI, COLEMAN MILNE, DETHLEFFS, DREAMER, ETRUSCO, GIOTTILINE, ITINEO PS700, ITINEO PS700 AUTOMATIC, LAIKA, PILOTE A656D ATLAS AUTO, RAPIDO, RIMOR, ROLLER TEAM, SUNLIGHT, SWIFT, TRIGANO, TRIGANO VDL CHAUSSON S695, WELLHOUSE, WESTFALIA, WILDAX, WILDAX METEOR, WILDAX METEOR AUTOMATIC
- *Grey import* — CROWN VICTORIA, F150, TAURUS, THUNDERBIRD
- *Derivative string* — V6
- *Unidentified* — CUSONA, DORCHESTER, EXECUTIVE, FREEDOM, INDEPENDENCE, JOURNEY, MONARCH, PROCAB

**Honda** (`honda`, 63 of 80):

- *Pre-2000* — CONCERTO, CRX, TN360
- *Non-car* — C50, C50E, C90, CB, CBF, CBR, CBX, CF70C, CR125R, CR250R, CR480R, CR500R, CR80R, CT125C, FT500D, GL1100C, GL1100D, GL1200A, GL500D, H100S, MTX80RF, NC50A, NC750, NS50D, NXR125, PF50MR2, PXR50, RS125R, SES125, SH50, ST50J, SXS 700, TRX, TRX250R, TRX250T, TRX300FW, TRX350F, TRX350G, TRX350T, TRX420F, TRX420T, TRX500F, TRX680F, VF750C, VF750S, XBR500G, XL125K, XL125S, XR250R, XR500A, XR600R
- *Grey import* — ACTY, FIT, INSPIRE, N-VAN, ODYSSEY, S660, SHUTTLE (Japanese-market Shuttle / Fit Shuttle), STEPWAGON
- *Unidentified* — SPORTS

**Hyundai** (`hyundai`, 6 of 51):

- *Pre-2000* — PONY
- *Grey import* — STARIA (not sold by Hyundai UK)
- *Unidentified* — 1200, 1400, PICK UP, X2

**Jaguar** (`jaguar`, 6 of 19):

- *Pre-2000* — 3.8, E TYPE, MK IX, MK VII
- *Limited run* — EAGLE (Eagle E-Type restorations and continuation cars)
- *Typo / truncation* — FP RD (probably F-Pace R-Dynamic; "FP" is too short to be a safe alias)

**Kia** (`kia`, 2 of 29):

- *Pre-2000* — PRIDE
- *Typo / truncation* — STRINGER (Stinger)

**Land Rover** (`land-rover`, 2 of 12):

- *Pre-2000* — 109 (Series I–III), 88 (Series I–III)

**Mazda** (`mazda`, 14 of 35):

- *Pre-2000* — 1000, 1300, 1400, 600, 800, MONTROSE, RX-7
- *Grey import* — BONGO FRIENDEE A, EUNOS, FAMILIA, MILLENIA
- *Derivative string* — MPS (Mazda3 MPS or Mazda6 MPS)
- *To check* — 121 (the Fiesta-based 121 ended around 2000), XEDOS (the Xedos 9 was built until 2002)

**Mercedes-Benz** (`mercedes-benz`, 42 of 150):

- *Pre-2000* — 190 (W201 190 ended 1993), 200 (bare W123/W124-era type number with no class letter), 300 (bare W123/W124/W126-era type number with no class letter), 400 (bare type number with no class letter), 500 (bare type number with no class letter)
- *Conversion* — ADRIA, AUTO SLEEPERS, AUTO-SLEEPERS, BOECKER SPRINTER, BURSTNER, C1-TOUR I143, C1-TOUR T143, C1TOUR I, C1TOUR T, C2-TOUR, C2TOUR, CARTHAGO, CHIC C-LINE, CHIC E-LINE, COLEMAN MILNE, COLEMAN MILNE AUTO, DETHLEFFS, HYMER, HYMER VENTURE S AUTO, KABE, LUNAR, MALIBU, NIESMANN UND BISCHOFF ARTO 78, PILOTE HERITAGE, RAPIDO, RAPIDO I166M ALDE AUTO, THEAULT SPRINTER AUTO, WEINBRG CRCMPCT MBEDPEPR640MEG, WEINSBERG XPEDITION 600MQ AUTO, WESTFALIA
- *Heavy / plant* — ACTROS, EACTROS 600, ECONIC, UNIMOG
- *Derivative string* — AMG CLASS (no class letter; the AMG C/E/GLC/GLE/SL/EQE/G/A strings now match through aliases such as "AMG C 63"), NON-CAR DERIVED VAN
- *Unidentified* — M8

**MG** (`mg`, 5 of 22):

- *Pre-2000* — MGA, MGB, MIDGET, ROADSTER (probably MGB / RV8 roadsters), TD/TF

**MINI** (`mini`, 2 of 21):

- *Derivative string* — CHALLENGE, GT

**Mitsubishi** (`mitsubishi`, 6 of 23):

- *Pre-2000* — SIGMA, STARION
- *Grey import* — DELICA, MINICAB TRUCK
- *To check* — L300 (later examples are imported Japanese-market vans)
- *Missing* — I CITY (probably the kei-based Mitsubishi i city car, sold in the UK from 2007; not added because the UK specification could not be confirmed)

**Nissan** (`nissan`, 19 of 54):

- *Pre-2000* — BLUEBIRD, CHERRY, D21, DATSUN, PRAIRIE, SUNNY, URVAN
- *Conversion* — LUNAR
- *Grey import* — ELGRAND, FAIRLADY, MARCH, NT100 CLIPPER TRUCK 4WD 5MT A, SERENA (Japanese-market Serena built 2005–2023; the European Serena ended around 2001; gap-fill decision), SILVIA, SKYLINE, STAGEA, VANETTE (Japanese-market Vanette, a rebadged Mazda Bongo, built 2006–2015; the European Vanette Cargo ended before 2005 and its LDV Cub twin is in ldv.json; gap-fill decision)
- *Derivative string* — SINGLE CAB
- *Other make* — INFINITI (Infiniti is its own catalogue make, infiniti.json)

**Peugeot** (`peugeot`, 47 of 97):

- *Pre-2000* — 104, 204, 205, 304, 309, 403, 404, 405, 504, 505, 604, 605
- *Conversion* — ALLIED, AUTO SLEEPERS, AUTO TRAIL, AUTOCRUISE, BAILEY, BAILEY AUTOGRAPH, CAPRON CARADO CV 640 AUTO, CAPRON ELDDIS, CHAUSSON, COMPASS, E7, ELDDIS, EUROTAXI, GIOTTILINE, GIOTTIVAN, ITINEO, MCLOUIS, PEUGEOT RAPIDO, PLA, SUNLIGHT, THEAULT
- *Non-car* — BUXY, JET FORCE, METAL X, SATELIS, TWEET
- *Unidentified* — 253, AUTOHAUS, BARON 530, COMPACT, EUROBUS, HORIZON, INDEPENDENCE, PREMIER, S8

**Polestar** (`polestar`, 1 of 5):

- *LHD only* — 1 (Polestar 1 was built in left-hand drive only)

**Porsche** (`porsche`, 3 of 12):

- *Pre-2000* — 928
- *LHD only* — 918 (918 Spyder: left-hand drive only, with no official UK price; see the make sourceNote), GT (probably the Carrera GT, left-hand drive only; see the make sourceNote)

**Renault** (`renault`, 30 of 66):

- *Pre-2000* — 10, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 25, 30, 6, 8, 9, B110, CARAVELLE, EXTRA, FUEGO
- *Conversion* — ADRIA, BURSTNER, LUNAR, RIMOR, THEAULT, WILDAX
- *Derivative string* — GORDINI (the Gordini badge was used on the R8 and R12 classics and on Twingo / Clio editions)
- *To check* — SAFRANE (production ended in 2000)
- *Unidentified* — 50 SERIES, 7CWT

**SEAT** (`seat`, 1 of 14):

- *Pre-2000* — MALAGA

**Skoda** (`skoda`, 4 of 17):

- *Pre-2000* — FAVORIT, MB, S100, S110

**Suzuki** (`suzuki`, 12 of 30):

- *Pre-2000* — CAPPUCCINO, SUPERCARRY
- *Non-car* — AY 50, GS 500, GSF 600, GSXR, KING QUAD, TU 250
- *Grey import* — CARRY, ESCUDO, HUSTLER
- *Typo / truncation* — SX (probably SX4)

**Toyota** (`toyota`, 30 of 58):

- *Pre-2000* — CARINA, CORONA, LITE ACE, MODEL F, STARLET, TERCEL
- *Grey import* — 4-RUNNER, ALPHARD, ALTEZZA, AQUA, AVALON, CAVALIER, CELSIOR, CENTURY, CROWN, ESTIMA, FJ CRUISER, GRANVIA, HARRIER, IPSUM, MARK II, NOAH, SIENTA, SOARER, SPRINTER, TOWNACE, VELLFIRE, VISTA, VITZ
- *To check* — DYNA (most Dyna trucks are over 3.5 t)

**Vauxhall** (`vauxhall`, 15 of 57):

- *Pre-2000* — BELMONT, CALIBRA, CARLTON, CAVALIER, CHEVETTE, CRESTA, FIRENZA, MAGNUM, MONTEREY, NOVA, VELOX, VICTOR
- *Conversion* — ALLIED, ALLIED VENTURE
- *LHD only* — GT (the 2007 Opel GT roadster was built in left-hand drive only and was not in the Vauxhall UK range)

**Volkswagen** (`volkswagen`, 35 of 81):

- *Pre-2000* — 1200, 1300, 1303, 1500, 1600, 181, 411, 412, CLIPPER, CORRADO, DERBY, K 70, KARMANN GHIA, KOMBI, MICROBUS, SANTANA, VENTO
- *Conversion* — 640 MEG VANSATION A, ADRIA COMPACT MAX DL, AUTO SLEEPERS, ERIBA 0 AUTOMATIC, JERBA, KNAUS TIPLS PLATNM SELCT650MEG, KNAUS TOURER VANSATION 500LT A, KNAUS VAN TIVW VANSATION640MEG, KNAUS WAVE VANSATION 640 MEG, MELLOR CRAFTER, MOTOR CARAVAN, WEINSBERG, WESTFALIA
- *LHD only* — XL1 (XL1 was built in left-hand drive only)
- *Derivative string* — PICK-UP, T-SPORTR T32 COMM PRO TDI 4M A
- *Typo / truncation* — CADY MXI C20 CM PRO TSI PHV SA (Caddy)
- *Unidentified* — OBSVW7J0

**Volvo** (`volvo`, 33 of 57):

- *Pre-2000* — 131, 144, 145, 164, 221, 240, 244, 245, 260, 264, 340, 343, 360, 363, 365, 440, 460, 480, 740, 760, 850, 940, 960
- *Heavy / plant* — A SERIES, EW SERIES, FE, FH SERIES, FL, FM SERIES, L SERIES, VESTERGAARD
- *Derivative string* — T5 R-DESIGN (engine + trim with no model), T6 OCEAN RACE AWD AUTO (2012 Ocean Race edition, sold on several models)

### Unmatched reference models of the other makes, with reasons

**Alfa Romeo** (`alfa-romeo`, 2 of 19):

- *Pre-2000* — 33
- *LHD only* — 8C (8C Competizione and 8C Spider were left-hand drive only; see the make sourceNote)

**Aston Martin** (`aston-martin`, 5 of 27):

- *Pre-2000* — DB4 (classic; later years are continuation or restored cars), DB5 (classic; later years are continuation or restored cars)
- *Derivative string* — VOLANTE, ZAGATO
- *Unidentified* — DB1

**Cadillac** (`cadillac`, 2 of 7):

- *To check* — ESCALADE, XLR

**Caterham** (`caterham`, 1 of 1):

- *Pre-2000* — 21

**Chevrolet** (`chevrolet`, 1 of 14):

- *LHD only* — CAMARO (sold in the UK in left-hand drive only; see the make sourceNote)

**Chrysler** (`chrysler`, 3 of 13):

- *Grey import* — CHARGER, TOWN & COUNTRY, VIPER

**Daihatsu** (`daihatsu`, 4 of 11):

- *Grey import* — EXTOL, MIRA, MOVE
- *To check* — HI-JET

**Dodge** (`dodge`, 5 of 9):

- *Grey import* — DURANGO, RAM 1500
- *Derivative string* — SRT
- *Unidentified* — 1100, S35

**Ferrari** (`ferrari`, 1 of 25):

- *Limited run* — SA APERTA

**Great Wall** (`great-wall`, 1 of 2):

- *Other make* — FUNKY CAT (the Ora Funky Cat / Ora 03 is in gwm.json)

**GWM** (`gwm`, 1 of 11):

- *To check* — POER300

**Isuzu** (`isuzu`, 1 of 6):

- *Grey import* — BIGHORN

**Iveco** (`iveco`, 15 of 19):

- *Conversion* — CARTHAGO, CARTHAGO LINER FOR TWO I53 L A, DETHLEFFS, KON-TIKI, LINER-FOR-TWO I 53 AUTO, LINER-FOR-TWO I 53 L AUTO, NIESMANN BISCHOFF FLAIR 880 A, NIESMANN+BISCHOFF, SWIFT
- *Heavy / plant* — EUROCARGO, S-WAY, STRALIS, TRAKKER, X-WAY, EUROTRAKKER

**Jeep** (`jeep`, 1 of 9):

- *Typo / truncation* — G-CHEROKEE (Grand Cherokee)

**Lamborghini** (`lamborghini`, 2 of 10):

- *Pre-2000* — COUNTACH
- *Limited run* — CENTENARIO

**Lotus** (`lotus`, 2 of 11):

- *Pre-2000* — ELAN, SEVEN

**Maserati** (`maserati`, 3 of 15):

- *Pre-2000* — KHAMSIN
- *Limited run* — GT2 STRADALE S-A, MC12

**Morgan** (`morgan`, 2 of 10):

- *Limited run* — MIDSUMMER AUTO
- *Unidentified* — SPORTS

**Proton** (`proton`, 3 of 9):

- *Derivative string* — GLS
- *Typo / truncation* — GE
- *To check* — SUPRIMA

**Rolls-Royce** (`rolls-royce`, 1 of 7):

- *Other make* — ROLLS ROYCE (the make repeated as the model)

**Rover** (`rover`, 8 of 14):

- *Pre-2000* — 200 SERIES, 2000 SERIES, 60, 800 SERIES, 95, METRO, MONTEGO
- *Other make* — RANGE ROVER (Range Rover models are in land-rover.json)

**Saab** (`saab`, 3 of 6):

- *Pre-2000* — 900, 9000, SONETT

**smart** (`smart`, 1 of 18):

- *Limited run* — CROSSBLADE

**Subaru** (`subaru`, 5 of 17):

- *Pre-2000* — SVX
- *Grey import* — SAMBAR TRUCK AWD
- *Derivative string* — 4WD
- *Typo / truncation* — C-TREK TORING EBXR SYM AWD CVT (probably Crosstrek Touring)
- *Unidentified* — PICK UP

**Tata** (`tata`, 1 of 3):

- *Unidentified* — LOADBETA

### Gap-fill decisions recorded in the data

- Added: Aston Martin Valour, V12 Speedster, Valiant and DBR22; Daewoo Musso and Korando (SsangYong-built,
  2000–2002); MG MGS6 EV (and `Magnette` as an alias of the MG6, sold as the MG6 Magnette saloon from 2011);
  Volkswagen Grand California (the 680 is plated at 3.88 t, above the ≤ 3.5 t scope; the 600 is 3.5 t); BYD e6 and
  Shark; BMW Alpina (21 generations by base platform); the classic Rover Mini (2000); Alfa Romeo 4C (2014–2018) and
  Giulia GTA/GTAm trims; DS 9 (2021–2025); SEAT Inca; LDV/Maxus eTerron 9; Subaru Justy (2007–2011); Lexus LFA;
  `McLaren` / `McLaren SLR` aliases on the Mercedes-Benz SLR McLaren.
- Trim lists filled: VW Golf Cabriolet (2000–2002), Nissan Kubistar, Primastar and Interstar, LDV Deliver 9.
- Left out, with the reason in the lists above: BYD ETP (UK RHD not confirmed), Alfa Romeo 8C and Porsche 918 /
  Carrera GT (left-hand drive only), Nissan Serena and Vanette (Japanese-market grey imports).

### Open items

- The 8 *To check* / *Missing* entries above.
- Ferrari Enzo and LaFerrari are in `ferrari.json` although both are believed to have been built in left-hand drive
  only, which would put them outside the RHD rule applied to the 8C, 918 and Carrera GT; to decide.
- Placeholder or empty trim lists remain where the UK grades are not known (e.g. VW Caddy Mk2, Transporter T4, LT,
  Crafter Mk1, Caravelle T4, Mercedes-Benz Vaneo and T-Class, most LDV vans).
