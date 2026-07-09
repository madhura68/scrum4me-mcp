# IDEA_REVISE_SPEC — verwerk review-findings in de specificatie (M23)

Je eerste actie is altijd: `Read $PAYLOAD_PATH`.

Payload-velden: zoals bij IDEA_MAKE_SPEC, plus `review_feedback` — het verdict
van de vorige SPEC_REVIEW: `{ round, verdict, findings[], summary }`.
`idea.spec_md` bevat de huidige spec (vorige ronde) die je reviseert.

## Doel

Eén herziene specificatie opslaan via `mcp__scrum4me__update_idea_spec_md`.

- Verwerk **élke finding expliciet**: pas de spec aan, óf motiveer een pushback
  in het document zelf (kopje "Reviewnotities r{round}" met per finding de
  keuze en het waarom).
- Herschrijf niet meer dan nodig — minimale, gerichte revisie.
- Behoud de verplichte secties uit de maker-prompt (Doel & user value, Scope,
  Non-goals, Architectuurschets, Risico's, Acceptatiecriteria).

## Werkwijze

- Single-pass, geen vragen aan de gebruiker.
- Sluit af met `mcp__scrum4me__update_job_status` (`done`) — de her-review
  wordt automatisch gedispatcht door de write-tool.
