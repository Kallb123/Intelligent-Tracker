# History-based suggestions

Open **Tasks → Suggestions** (also available in the account menu), or send
`/suggestions` in the linked Telegram house group. The inbox is shared by the household.
Telegram shows up to five cards per request; resolve those and request the next ones, or
use the web inbox for the complete list. Telegram readers and button presses must be linked
to a member of that household.

Nothing changes automatically. Every card describes its proposed change and offers **Accept**
and **Dismiss**. Any household member can act, as with editing a task. A decision in one interface
also resolves the card in the other. Independent cards survive unrelated task edits and accepting
another kind of suggestion. If a card's relevant evidence or proposed change changes before a press,
the old card is refused: refresh the inbox or send `/suggestions` again.

## Rules

The rules use up to the latest 20 logged, completed occurrences per repeating task. They ignore
one-off tasks, skipped occurrences, future completions and completions without an activity entry.
Each kind uses only completions strictly after its latest accept or dismiss for that task.
Resolving lateness or snoozes therefore requires three fresh completions before that kind can
return; fairness requires five fresh completions in the current month. Decisions of other kinds
do not reset that history window.

- **Lateness:** each of the latest three completions must be at least a day late. Add the median
  delay, rounded up to whole weeks, to the current lead (zero when absent). Skip cycles under
  14 days and cap the proposed lead below the cycle's shortest safe interval, and at 3,650 days.
  Use the configured interval for after-completion tasks and conservative bounds for regular
  daily, weekly, monthly and yearly rules (including ordinal weekdays). Clustered or complex
  selectors and working-day shifts get no lateness card when a safe gap cannot be established.
  All-day dues use household calendar dates, so DST and completion on the due date do not create
  false lateness; timed dues use elapsed days. The card states the median and the new lead.
- **Snoozes:** each of the latest three completed occurrences must have at least two recorded
  snoozes. For tasks using the morning slot, propose the household evening slot. Custom reminder
  times and tasks already using the evening slot are left alone. Silent tasks get neither this
  suggestion nor a lateness suggestion.
- **Fairness:** for rotation tasks with at least two assignees and five recent completions this
  household-local calendar month, suggest a different next turn if one assignee did at least 70%
  of those completions. Count actual completers, rather than assigned members. Choose the least
  busy current assignee who is not away today, keeping assignee order to break ties. The card
  names both people and explicitly states the sample size; it is a per-series sample of at most
  20 completions, rather than a household-wide monthly report.

## Applying a decision

Accepting a lead suggestion recalculates future open occurrences' preparation starts using the
existing task rescheduling path. It preserves their due dates, completed history and started
occurrences. Accepting a reminder-slot suggestion changes the task's slot; the worker replans
its reminders on its next tick. Accepting fairness moves the task's rotation cursor and replans
not-started assignments using the existing away-aware rotation rules. Started jobs keep their
current assignee. Existing milestones and assignee lists are preserved.

Decisions are recorded as `suggestion.accepted` or `suggestion.dismissed` in the activity log,
with the actor, task, evidence fingerprint and accepted patch. The latest decision time is the
cutoff for that kind's new evidence, including after manual settings changes. Old completions
are never reused to renew a resolved suggestion. This keeps the rules explainable without a model,
external service, background suggestion queue or additional database migration.

Both interfaces use the same household-scoped database operation. It recomputes the suggestion
under the task lock, accepts no caller-supplied patch, and commits task changes and the audit
entry together. Repeated or simultaneous presses can apply a card only once.
