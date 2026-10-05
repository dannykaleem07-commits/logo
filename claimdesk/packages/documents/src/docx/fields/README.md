# Merge fields, mappings and fill plans (`@ccguk/documents` → `docx/fields/`)

Design: `docs/TEMPLATES-VEHICLES-DESKTOP.md` §B (normative), §A.10, §C.1, Appendices 1–2.

```ts
import { buildFillPlan, builtinAssetBytes, builtinMapping, fillDocx, scanDocx } from '@ccguk/documents';

const bytes = builtinAssetBytes('agreement.ccguk_03_credit_hire');
const plan = buildFillPlan(scanDocx(bytes), builtinMapping('agreement.ccguk_03_credit_hire'), mergeSource, { values, confirm, variant });
// plan.rows → values form; plan.issues with severity 'block' → refuse generation (400)
const { docx } = fillDocx(bytes, plan.instructions, { removeBlocks: plan.removeBlocks, coreProps, now });
```

| File | What |
|---|---|
| `types.ts` | FieldDef, FieldValue, FillPolicy, mappings, PlanRow/FillPlan, BuiltinDocxTemplate (JSON-serialisable except `FieldDef.resolve`) |
| `source.ts` | `MergeSource` (built by the API) + `sampleMergeSource()` (claim CCG-2026-00012; no bank details) |
| `derive.ts` | pure resolver helpers (Europe/London dates, open-record rules, record selection) |
| `dictionary.ts` | `FIELD_DEFS` (every Appendix 1 key), `getFieldDef` (aliases), `listFieldGroups` |
| `resolve.ts` | `resolveField(key, src)` |
| `format.ts` | `formatForSlot` (§B.4) |
| `mapping.ts` | selectors, `mergeMappings`, `validateMapping`, `unmappedSlots` |
| `guards.ts` | `runTemplateGuards` (§B.7) |
| `plan.ts` | `buildFillPlan` (§B.9, never-auto-fill rules §B.5) |
| `automap.ts` | `suggestMapping` for uploaded templates (§B.8) |
| `letterhead.ts` | `composeLetterheadDocx` (§A.10) |
| `builtin/` | `BUILTIN_DOCX_TEMPLATES`, `builtinMapping`, `builtinAssetPath/Bytes`, the 10 `*.mapping.json` |
| `report.ts` | `pnpm --filter @ccguk/documents docx:mappings` → per-slot report + `out/docx/<id>.mapped.docx` / `.browser.pdf` |

## Decisions and additions to the design contract

- **Option blanks.** A blank printed inside a choice option (`☐ Other: ____`, `☐ YES — Part 2 signed on __/__/__`) is
  its own plan row with slot id `<choiceSlotId>|<optionSlug>`; its input goes in `PlanInputs.values` under that id
  and its confirmation in `confirm`. The mapping describes it with the additive `MappingEntry.optionBlanks`
  (`{ [optionSlugPrefix]: { key, policy, onlyIf, format, label, note } }`). Every option blank of an unmapped or
  handler choice gets a handler row too. Values are merged into the choice instruction's `blanks`.
- **Precedence of entries.** An entry or ignore that names a slot by exact id beats one that found it with a
  section/qualifier/label selector (that is how a stored override layer replaces curated selectors); two of the same
  specificity are `DUPLICATE_SLOT`. Ignore selectors may cover several slots.
- **Signature / office-use slots** are entries with `policy: 'signature'` (no key) or `policy: 'never'` with a note,
  so the values form can show why they stay blank; plain `ignore` is used only for slots with nothing to say.
- **Extra keys** (beyond Appendix 1, all documented in the dictionary): `doc.dateToday` (A; 08/09 headers, because a
  mapping may not make `doc.date` laxer than G), `recipient.addressLine1/2` (letterhead lines), `witness.exhibits[0].*`,
  `evidence.<row>.held|date|ref` (02 C1.5 cells), `storage.facilityOther`, `storage.personalItemsList`,
  `recovery.providerOther`, `engineer.outcomeReason`, `hire.fuelInPercent`, `hire.return.fuelShortfallAmount`,
  `hire.release/return.*` item keys, `hire.enfCheck.*` names, `means.creditCards[i].limit|balance`.
- **MergeSource additions (optional):** `recoveryAgent`, `thisDocument` (re-generation: signed/sent/reviewed dates),
  `MergeDocumentRef.approvedByName`, `MergeEvidenceRef.tags` (`release` / `return` photographs).
- **GuardContext additions (optional):** `variant`, `templateId`, `handlerKeys` (a handler-typed end date on an open
  record is the handler's statement, not a derived one).
- Choice matchers ending in `$` match an option slug exactly (salvage category `N` must not tick `n/a`).
- `doc.valediction` follows the salutation that will actually print (`Sir or Madam` → faithfully, else sincerely).
- Space-box dates (`        /         /       `) keep the printed width: each group is centred in its box.
- `composeLetterheadDocx` removes the Client / Vehicle / Date of Accident rows when those refs are absent;
  `privateAndConfidential: false` cannot remove the printed line (static text; the engine fills slots only).
