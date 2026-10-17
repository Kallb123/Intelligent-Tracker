# UK templates and bank holidays

The task editor offers the UK template pack from PLAN.md section 4.6. Typing a
matching title suggests up to three templates. Select one to inspect its repeat
rule, prep window and milestones, then press **Apply template**. Suggestions never
change a task automatically. Check the resulting due date and settings before
saving the task.

Choose your own expiry date for renewals and collection date for bins. Self
Assessment, payments on account and clocks-change rules use their next matching
calendar date. Passport and contract renewals are one-off dates; photocard
renewals repeat every ten years. The passport and photocard prep windows use 90
and 60 days respectively. Car tax and bin night each have monthly/fortnightly
variants. For alternating bins, make two fortnightly tasks one week apart.
Bin templates remind in the evening before collection; the due stays the
collection date.

Under **Save or manage a household template**, save the current task settings and
optional comma-separated keywords. Templates belong to the household and can be
reused, replaced or deleted by any household member. They omit dates, assignments
and task history. To edit one, apply it to the editor, change its settings, then
choose **Replace selected template**. Built-ins cannot be edited or deleted.

## Working days only

Tick **Working days only** to move a due forward past Saturdays, Sundays and
cached bank holidays for the household's region. The repeat anchor stays fixed:
a monthly task keeps its monthly rule even if one occurrence moves. Timed tasks
keep their local time across BST/GMT changes, and prep starts move with their due.
Several dates that move to the same due become one occurrence. The editor's
preview uses the same cache and rules as the worker.

This option moves the due date, including deadlines: leave it off when the legal
expiry or payment date must stay fixed. It does not automatically reschedule bin
collections; local councils set those arrangements.

## Holiday cache and digest

The worker loads `https://www.gov.uk/bank-holidays.json` on its first tick, then
refreshes the `england-and-wales` division every seven days. The last success and
attempt are stored in Postgres, so restarts and worker replicas share the same
schedule. HTTP requests time out after ten seconds. A failed or malformed feed
keeps the last good cache and is retried after an hour; failures are logged.
Allow outbound HTTPS to `www.gov.uk` when deploying behind an egress firewall.
Other regions are not synced by this PR.

A successful refresh replaces the division's snapshot, including withdrawn dates,
and regenerates future unstarted occurrences of working-day tasks when dates
change. Started, completed, skipped and overdue occurrences are kept. The seed
command supplies offline England/Wales reference dates for 2025–2027 without
overwriting existing cached rows. After a successful sync, seeding is disabled so a restart cannot restore withdrawn dates. A fresh installation without a successful sync
or seed has weekend-only scheduling until a cache is available; the editor shows
a warning when its holiday cache is empty.

Send `/digest` in the linked household Telegram group for active jobs and cached
bank holidays over the coming week, with a bin-collection warning. Private and
unlinked chats are ignored. Main currently predates the wider PR 13 command and
automatic digest scheduler; this PR supplies the holiday-aware digest command and
shared query for that integration.

API routes require a session; writes also require the normal CSRF token:

- `GET /api/templates`: built-in and household templates.
- `POST /api/templates`: create a household template.
- `PATCH /api/templates/:id`: replace a household template with a complete body.
- `DELETE /api/templates/:id`: delete a household template, keeping existing tasks.
- `GET /api/bank-holidays`: the household region's cached dates and titles.

Database migrations run normally on API startup. The application version is
`0.7.0`.
