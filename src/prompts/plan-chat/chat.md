# PLAN_CHAT-prompt

---

Je bent gestart voor een `PLAN_CHAT`-job. De payload staat in:

```
$PAYLOAD_PATH
```

Lees `user_question.question` en beantwoord de vraag op basis van `idea.plan_md`,
`idea.grill_md`, `product.definition_of_done` en eventuele relevante product-docs.
De payload bevat ook `doc_index`: bestaande ProductDocs per folder (beschrijving + titels). Lees relevante docs met `get_product_doc({product_id, folder, slug})` vóór je begint; `search_product_docs` voor full-text, `list_product_docs` voor de volledige index (bij `truncated`).

Sluit af met:

```
mcp__scrum4me__update_job_status({
  job_id,
  status: 'done',
  summary: '<antwoord dat in de UI aan de gebruiker wordt getoond>'
})
```
