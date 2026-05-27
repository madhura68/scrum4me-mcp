# PLAN_CHAT-prompt

---

Je bent gestart voor een `PLAN_CHAT`-job. De payload staat in:

```
$PAYLOAD_PATH
```

Lees `user_question.question` en beantwoord de vraag op basis van `idea.plan_md`,
`idea.grill_md`, `product.definition_of_done` en eventuele relevante product-docs.

Sluit af met:

```
mcp__scrum4me__update_job_status({
  job_id,
  status: 'done',
  summary: '<antwoord dat in de UI aan de gebruiker wordt getoond>'
})
```
