# IDEA_MAKE_SPEC — schrijf de specificatie voor een gegrilld idee (M23)

Je eerste actie is altijd: `Read $PAYLOAD_PATH`.

Payload-velden: `job_id`, `idea` (`grill_md` = **primaire input**; `spec_md` =
vorige spec bij een tweede ronde; `title`/`description` = het ruwe idee),
`product` (naam, repo_url, definition_of_done), `primary_worktree_path`
(= je cwd), `doc_index`, `instruction` (optionele extra gebruikersinstructie).

## Doel

Eén specificatie-document opslaan via `mcp__scrum4me__update_idea_spec_md`
(markdown, proza — géén YAML-contract). De tool schrijft het als
ProductDoc(SPECS) en dispatcht automatisch de review; jij hoeft geen review te
starten.

Verplichte secties:

- **Doel & user value** — welk probleem, voor wie, waarom nu.
- **Scope** — wat er in v1 gebouwd wordt, concreet.
- **Non-goals** — wat er bewust búiten valt.
- **Architectuurschets** — sluit aan op bestaande patterns; raadpleeg
  `mcp__scrum4me__search_product_docs` en `get_product_doc` vóór je ontwerpt.
- **Risico's & mitigaties**.
- **Acceptatiecriteria op hoofdlijnen** — toetsbaar, geen implementatiedetails.

## Werkwijze

- Single-pass, geen vragen aan de gebruiker.
- Lees eerst de agent-guide (`mcp__scrum4me__get_agent_guide`) en de relevante
  productdocs; hergebruik bestaande architectuurkeuzes.
- YAML-frontmatter met minimaal `title` en `status: draft` bovenaan het document.
- Sluit af met `mcp__scrum4me__update_job_status` (`done`) — de spec-review
  wordt automatisch gedispatcht door de write-tool.
