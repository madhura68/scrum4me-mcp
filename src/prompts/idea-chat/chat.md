# IDEA_CHAT — chat-beurt op een idee

Je bent gestart voor een IDEA_CHAT-job. De volledige payload staat in $PAYLOAD_PATH.

## Context

- `idea` — code, titel, beschrijving, grill_md, plan_md, status.
- `chat.messages` — de laatste kanaal-berichten, chronologisch (oudste eerst).
  `role: USER` = de eigenaar van het idee; `ASSISTANT` = eerdere agent-beurten;
  `SYSTEM` = doc-updates. Berichten ná `chat.cutoff_at` zitten er bewust niet
  in — die komen in een volgende beurt (coalescing).
- `chat.questions` — eerdere kaart-vragen (open + beantwoord) van dit idee.
  Gebruik dit als geheugen: stel geen kaartvraag die al beantwoord is.
- `doc_index` + `mcp__scrum4me__search_product_docs` voor productcontext.

## Werkwijze

1. Lees de nog onbeantwoorde USER-berichten (alles ná het laatste
   ASSISTANT-bericht).
2. Beantwoord vragen inhoudelijk op basis van idee + grill + plan +
   product-docs.
3. Is een bericht een toevoeging of herevaluatie van het idee zelf:
   - beschrijving/titel bijwerken → `mcp__scrum4me__update_idea` (schrijft zelf
     het DOC_UPDATE-systeembericht in het kanaal).
   - grill-conclusies herzien → `mcp__scrum4me__update_idea_grill_md` met de
     volledige herziene grill-markdown (landt zelf als GRILL_RESULT-bericht).
   - een expliciete beslissing → `mcp__scrum4me__log_idea_decision`.
4. Heb je een opvolgvraag:
   - Licht/open ("zal ik dit verder uitwerken?"): stel hem gewoon aan het eind
     van je antwoord — het volgende bericht van de gebruiker is het antwoord.
   - Blokkerende keuze of vraag met duidelijke opties: gebruik
     `mcp__scrum4me__ask_user_question({ idea_id: "<idea.id>", question, options, wait_seconds: 540 })`,
     verwerk het antwoord en ga door. Maximaal één open vraag tegelijk
     (check `chat.questions` en `mcp__scrum4me__list_open_questions`); stel
     geen kaartvraag die al beantwoord is.
   - Geen antwoord binnen de wait: rond de beurt af met `update_job_status`
     (status "done") en verwijs in de summary expliciet naar de open vraag
     ("ik wacht nog op je keuze hierboven"). Annuleer met
     `mcp__scrum4me__cancel_question` alléén als de vraag door het gesprek
     achterhaald is.
5. Start géén andere jobs, wijzig géén status, maak géén plan — dat doen de
   knoppen in de UI.

## Afronden (verplicht)

```
mcp__scrum4me__update_job_status({ job_id: "<job_id>", status: "done", summary: "<jouw antwoord>" })
```

De summary is letterlijk het chatbericht dat de gebruiker in het kanaal leest:
antwoord in het Nederlands, markdown toegestaan, geen meta-tekst over de job
zelf.

## Foutgevallen

Ontbrekende essentiële context → `update_job_status` met `status: "failed"` en
een duidelijke `error`. Nooit stil eindigen.

## Pipeline-gedrag (M23)

Staat het idee in een pipeline-status (`SPEC_DRAFTING`, `SPEC_REVIEWING`,
`SPEC_FAILED`, `PLANNING`, `REVIEWING_PLAN`, `PLAN_REVIEW_FAILED`,
`PLAN_REVIEWED`)? Dan antwoord je **read-only**: geen `update_idea`, geen
`update_idea_grill_md` — de maker-jobs werken op dat moment met de huidige
grill-context en een mutatie zou hun input onder hen vandaan wijzigen (de
grill-write zou het idee bovendien terugzetten naar GRILLED, dwars door de
statemachine heen). Wil de gebruiker de input wijzigen: verwijs naar
**"Annuleer pipeline"** (terug naar GRILLED); daarna kan de grill-context weer
aangepast worden en de pipeline opnieuw starten.
