# Decisions log

Every ambiguity resolved during the build, with the option chosen and why. The
master prompt (§22) requires this file; a reviewer must be able to reconstruct
why the code looks the way it does.

---

## Phase 01 — Foundation

### 1. Embedded Postgres (PGlite) instead of Supabase for local and CI
**Context.** The sandbox has no root access, so no system Postgres, and no
Supabase project. The RLS policies are the security backbone of the product and
must be *tested*, not asserted.
**Decision.** Ship the exact Supabase SQL (policies built on `auth.jwt()`), and run
it against PGlite for local dev and CI. `0000_local_auth_stub.sql` provides
`auth.jwt()` from a session setting; on Supabase that function already exists.
**Consequence.** 20 tests exercise real RLS on a real Postgres engine. The
production client swaps for `@supabase/supabase-js` behind `withTenant()` — same
signature, no caller changes.

### 2. Local auth adapter instead of Supabase magic links
**Context.** No Supabase project in this environment; the phase-01 gate requires
"signing up creates a workspace".
**Decision.** `users.auth_user_id` stores `local:<email>` and the session is a
signed JWT cookie (`jose`, HS256, 7 days, httpOnly). `createWorkspaceWithOwner()`
is provider-agnostic and already unit-tested, so the Supabase adapter only
replaces the identity step.
**Consequence.** Text on the login screen states the adapter is local. To be
removed in phase 06 (self-serve onboarding) — tracked in BACKLOG.md.

### 3. Append-only `audit_log` enforced by grants, not by convention
**Decision.** `revoke update, delete on audit_log from app_authenticated`.
**Consequence.** Two tests assert the permission error. A future migration that
grants them again would make those tests fail — which is the point.

### 4. Typed dictionary i18n instead of next-intl
**Context.** The master prompt names next-intl. Phase 01 has eight screens and no
pluralisation, dates or rich text.
**Decision.** `packages/i18n` exposes `t(locale, key)` over typed JSON, exported
through the same shape a `translator(locale)` returns. A missing key is a compile
error (`MessageKey`), which next-intl does not give by default.
**Consequence.** The swap is mechanical (one file, one hook). Documented as a
deviation, not an improvement: revisit in phase 06 when copy grows.

### 5. One owner per workspace, enforced by partial unique index
`create unique index users_single_owner_idx on users (workspace_id) where role = 'owner'`.
A transfer of ownership must therefore be transactional (demote then promote);
no endpoint does it yet.

### 6. `strict` mapping of `workspaces.plan` at signup = `growth`
Starter exists as a plan but the default trial is Growth (14 days), per the
master prompt §11. A signup without an explicit plan never lands on Starter,
because the Starter limits would break the calibration screen (30 proposals is
below the volume needed to show a meaningful "aha").

### 7. `holdout_rate` constrained in SQL, not in application code
`check (holdout_rate between 0.100 and 0.300)`. The invariant must survive a
direct SQL update; a test asserts it.

---

## Open items carried to later phases

| Item | Phase | Note |
|---|---|---|
| Replace local auth with Supabase magic link | 06 | `auth_user_id` format `local:` to migrate |
| Ownership transfer flow | 08 | Needs transactional demote/promote |
| `SENTRY_DSN`, real rate limiting (Redis/Postgres) | 08 | Env var present, unused |
| `/api/dev/seed` must be deleted or hard-gated | 06 | Currently gated by `NODE_ENV` + `RROS_DEV_SEED` |

## 8. 500-row fixture carries four date shapes, and a discount column

`parse.test.ts` used to test only `JJ/MM/AAAA`. Real exports mix ISO dates,
`JJ/MM/AAAA HH:MM`, seconds and dotted dates in the same column, and they carry
`12%` in the amount column when a discount slipped in. The fixture now contains
all four shapes plus `1,5k` and `12%`, so the acceptance criterion is tested on
the data rather than asserted in prose.

## 9. Silence is measured from the send date when `last_touch_at` is unknown

A CSV rarely carries "last time I actually spoke to them". Measuring silence
from the send date is the pessimistic reading, and the pessimistic reading is
the right one here: it surfaces a dossier that may have been worked instead of
hiding one that was abandoned. Documented in the report; no silent defaulting.

## 10. `watch` uses the real top-20 % threshold, not a catch-all

Master prompt §6.3 defines `watch` as "amount in the top 20 %". `classify` now
accepts `topValueThresholdCents` (computed by `topValueThreshold`, nearest-rank
on open amounts) and only says "top 20 %" when it is true; otherwise the reason
is `recently_touched`. Four states stay four states — the threshold changes the
wording, never the state machine.

## 11. Manually created proposals are randomised too

`assignArm(0.2)` is applied to hand-entered opportunities (`arm_method='manual'`).
Letting a user choose would let them keep every deal in the treatment arm, which
inflates the measured gain without anyone lying. The trade-off is that a user may
add three deals and see one land in the control group; the detail page says so
explicitly.

## 12. `buildQueue` writes nothing; persistence lives in `packages/db`

The prompt names a single file `packages/domain/queue/buildQueue.ts` that ranks,
caps and persists. Persisting inside the domain package would end three phases of
IO-freedom and make the golden vectors untestable in a millisecond. The split is:
`buildQueue` is pure (candidates in, items out), `packages/db/src/repo/queue.ts`
owns `generateQueue` / `persistQueue` / `readQueue`. Same contract, testable both
ways; the 5 000-dossier benchmark runs on the repository half.

## 13. The regeneration rate limit is in-memory, and that is a known ceiling

10/minute/workspace is held in a `Map` inside the Node process. Behind two
instances the effective limit doubles. Acceptable for a single-process MVP; phase
08 moves it to Redis or a Postgres counter. Written here so nobody discovers it
through an incident.

## 14. Gate 5 falls back to the send date when `last_touch_at` is unknown

Found by running the app, not by a test: a CSV carries "3 relances", never "last
called on the 12th". With `last_touch_at` null, `(days ?? 0) < 7` was true for
every dossier, so gate 5 rejected the whole imported portfolio with the sentence
"relancé il y a moins de 7 jours" — false, and it emptied the queue. The anchor is
now `lastTouchAt ?? sentAt`, consistent with decision #9. Gate 4 still guarantees
5 business days, so nothing fresh slips through.

## 15. An acted recommendation is immutable in the database

`recommendations` carries a trigger that refuses to change `rank` or `score_cents`
once `acted = true`. The day's generation replaces the non-acted rows only. This
is what lets us answer "why was this first on 12 March" six months later, even
after two recalibrations of the weights.

## 16. A 0 % reply history is not shown as a factor

After an import, nobody has ever been recorded as replying, so every client shows
"répond 0 % du temps d'habitude". That reads as an accusation, not an
explanation. The factor is only emitted when the rate is above zero; the signal
itself keeps using the 0.35 default when unknown.

## 17. `actions` is a lifecycle log, not a message table

Master prompt §5 says it; implementing it made the consequences visible. Sending
one follow-up writes **three** rows for one dossier: `draft_generated` (what the
model proposed, `status='draft'`), `approved` (the text the human validated,
`edit_ratio` pointing back at the draft) and `sent` (the event, with the provider
id). Overwriting a single row would have destroyed the draft the moment it was
edited — and with it the only honest measure of how much the product's text is
worth. Two partial unique indexes keep the log sane: one live draft per
opportunity, one approval per draft. A second click on *Approve* therefore fails
at the database, and the route turns that into a 409, not a 500.

A generation refused twice is written as `kind='draft_generated', status='failed'`
with `violation_codes` and no body. Criterion 3 asks for a `draft_generated` row;
keeping the same `kind` also means one place to look: "this dossier was attempted
and refused" reads in the same query as "this dossier has a draft".

## 18. The stop rules are evaluated twice, and opt-out outranks the arm

The job re-reads the dossier immediately before sending instead of trusting the
state at approval time: an hour may have passed, the client may have replied. The
order is fixed (`WORKSPACE_SUSPENDED → CONTACT_OPTED_OUT → HOLDOUT → REPLY_RECEIVED
→ OPPORTUNITY_CLOSED → TOUCH_LIMIT → RECENT_TOUCH → DAILY_CAP_REACHED`) and the
opt-out is deliberately checked *before* the holdout. A holdout dossier that asks
to be left alone must be recorded as an opt-out; "control group" is a measurement
concept, not an excuse to ignore a person.

## 19. Sandbox sends never touch `touch_count`

A trial workspace sends everything to its own owner with a `[SANDBOX]` prefix. Those
messages are real API calls, so they belong in `actions` and in `audit_log` with
`sandbox=true`; they are *not* a contact with the client, so incrementing
`touch_count` or `last_touch_at` would corrupt both the scoring inputs and the
holdout comparison. The two consequences are separated on purpose: the audit trail
records the send, the dossier is untouched.

## 20. The daily cap is 40, the workspace capacity is 8

`daily_capacity` (4–20) is a *product* promise: how many cards we put in front of a
person each morning. The send cap (40) is an *operational* guard rail against a bug
or a replay sending yesterday's queue. Conflating them would make a normal day look
like an incident, or make an incident look like a normal day.

## 21. Edit ratio is "similarity", and its name is a trap

§8.4 defines `edit_ratio = 1 - levenshtein / max(len)`, so **1.0 means untouched**
and **0.0 means fully rewritten**. The name suggests the opposite and cost an hour
of confusion in the tests. The definition is kept verbatim (it is normative and it
is what the acceptance criterion measures), the fixtures now say it out loud, and
the UI never shows the number: it says "Message modifié — l'écart est enregistré",
which is the only thing a user needs.

## 22. A failed draft degrades to a skeleton, not to an error

When the writer is refused twice — or when there is nothing specific to say — the
card shows the reason, the violation codes, and an editable skeleton (client,
object, amount, date, one question, a signature) stored as a normal draft with
`model='manual-skeleton'`. Approval, edit ratio and the audit trail therefore stay
on one code path, and the product still works with the writer switched off. The
alternative (a blank screen with "generation failed") makes the whole queue
unusable for one bad prompt.

## 23. Signature and greeting refuse to invent a person

Imported CSVs carry `contact@example.fr` and signup creates logins like `pbe863f`.
Greeting "Bonjour Contact0" or signing "pbe863f" is worse than the generic form.
`firstName()` returns null for shared inboxes and anything containing digits, and
the signature falls back to "L'équipe <workspace>". The draft then opens with
"Bonjour Madame, Monsieur," which the guardrails accept and a human can fix in one
keystroke.

## 24. No HTTP client can send: approval writes, the job sends

`/api/actions/:id/approve` has no path to a provider, and the job has no path to an
approval. The Playwright test asserts it the hard way: it intercepts
`/api/cron/send` during the click and expects zero calls. This is what makes a
double click, a refresh or a retried request harmless — and it is the only reason
the idempotency key on `send_attempts` is a belt rather than the trousers.

## 25. A snapshot is a week, not a rolling window

§10.1 asks for the "cohort of opportunities sent in the same period". Stacking
twelve weekly rows gives the trailing cohort the estimator needs, while keeping
each row frozen forever. The alternative — one row per week holding a rolling
12-week total — makes every past row change every Monday, which means the weekly
log can never be reconciled with what the customer was shown last month. The
chart's cumulative line is therefore the running sum of the same twelve rows, not a
second computation.

## 26. The bootstrap resamples opportunities, and only the relative interval narrows

Resampling aggregates gives an interval that is always too narrow and always looks
significant; resampling opportunities costs 200 M operations on a 20 000-dossier
cohort and is worth it. One consequence worth writing down: level A is a *total*
(n × mean difference), so its absolute interval **grows** with the cohort — a
bigger sample is a bigger number with a proportionally bigger interval. The
property "the interval narrows as the sample grows" is true of the relative
interval, which is what `relativeCi` exposes and what the screen shows as "+14,9 %".
Criterion 6 is asserted on that scale, and the absolute behaviour is asserted too
so that nobody "fixes" it later.

## 27. `requiredSample` returns null rather than a number when the effect is not positive

`ceil((1.96 × sd / |effect|)²)` on a null or negative effect produces a huge number
or infinity. Displaying it would say "only 40 000 dossiers to go" forever, which is
a lie dressed as a plan. The screen says *"effet non estimable"* instead, and the
progress bar stays at zero. A number we cannot defend is worse than a sentence that
admits it.

## 28. Attribution is precomputed into its own table, not stored in snapshot metadata

The §5 sketch allowed either. A dedicated `attribution_results` table wins on three
counts: `/results` reads one row (p95 7 ms on 5 000 dossiers, measured), the
internal coherence view queries it directly with SQL, and the history of the
estimate stays auditable week by week — which is what makes "the number changed"
a question with an answer.

## 29. The coherence check compares the frozen revenue to the recomputed estimate

Comparing two values computed in the same breath would make `|B − C − A|` always
zero and the check decorative. B and C come from the **stored snapshots**; A is
recomputed from the raw cohort. A deal corrected after its week was frozen — a
duplicate import, a fixed amount, a status changed by hand — therefore moves A
without moving B, and the gap is real. The tolerance (`25 % of |A| + 30 €`) keeps a
legitimate correction from raising an alarm, and the flag appears only in the
internal view (`/fr/internal/coherence`, allowlisted): the customer keeps seeing
raw B and C, we keep seeing the alarm.

## 30. The arm has a 403, not a 404

Nothing in the product may move a dossier between treatment and holdout. The
database trigger is the lock (invariant I2). The route
`/api/opportunities/:id/arm` exists only to answer 403 with a reason: a 404 would
read as "not implemented yet" and someone would implement it. The honesty test
imports the handler and asserts the refusal on POST, PUT and PATCH.

## 31. The weekly email is plain text on purpose

Three lines, no chart, no images, no tracking pixel: what happened, what it is
worth (the headline sentence, verbatim, even when it says "nous ne pouvons pas
démontrer de gain"), what to do today. An HTML email with a big green number is how
this category of product loses the argument in month four, when someone finally
divides B by the total revenue and asks what the difference was supposed to be.

## 32. The webhook is the only writer of billing state — even the fake posts through it

Every mutation of `workspaces` that money can cause goes through
`POST /api/stripe/webhook`: signature check, `stripe_events` gate, state
machine, patch. In the sandbox there is no Stripe account, so the "hosted
checkout" completes by POSTing a **signed** event to our own route
(`/api/billing/fake-pay` is a loopback, not a shortcut). One code path means
the fake exercises exactly what production runs; the only untested link is the
HTTP call to api.stripe.com, and it sits behind one interface
(`BillingGateway`). The state machine itself is a pure function that returns a
patch — the repo applies it — and an unknown event type returns `ignored`,
because a 500 would make Stripe retry forever.

## 33. Lookup keys are the contract; price ids never appear in code

`rrs_<plan>_<interval>` is parsed in one place (`parseLookupKey`); the six
prices live in one catalog that both the fake Stripe and the pricing screen
read. Hard-coded price ids would break on every Stripe environment change and
would let the front-end drift from what is actually billed — the prompt's trap
about VAT display divergence starts there.

## 34. Entitlements have one door, and it reads the plan from the database

`assertEntitlement(db, workspaceId, action)` re-reads `workspaces.plan` on
every call — never the client, never a cache beyond the request — and records
every refusal in `audit_log`. The downgrade test (Scale → Starter with 250
dossiers) shows why the audit row matters: the refusal must be explainable to
the customer *and* to us. Enforcement lives in the action **and** in the job;
the send cron computes access from the workspace row on every run.

## 35. past_due and trial expiry are computed from dates, not flipped by a cron

`accessFor()` derives what a workspace may do from `past_due_at`,
`trial_ends_at`, `cancel_at_period_end`. No job has to "pause" anyone and,
more importantly, no job has to remember to un-pause them. Sending pauses the
moment an invoice fails; the workspace freezes read-only after the 3-day
grace; an expired trial keeps the queue readable and the data exportable. The
banner always says exactly which two features stop — no dark pattern, no data
held hostage.

## 36. Demo data is a different `source`, and never mixes with real imports

Demo rows carry `source = 'demo'`, so "remplacer les données de démonstration"
deletes exactly those rows and a downgrade bug cannot eat customer data. The
guard refuses to seed a workspace that already holds real imports; the
confirmation is explicit. The login-screen demo ("voir une démo") gets its own
workspace, step 5 pre-ticked, sandbox sending.

## 37. The coach-mark is shown once, ever — server-side

A dismissal in localStorage dies with the browser profile. The flag lives in
`onboarding_state`; a refresh, a second device and a reinstall all agree. The
wizard state itself is server-side for the same reason: criterion 8 (a refresh
at step 3 must not lose the file or the mapping) is what "resumable" means
when it is taken seriously.

## 38. The onboarding walked in a real browser caught what unit tests could not

The RLS policies of the three new tables were written against
`current_setting('app.workspace_id')` while the rest of the schema resolves
the tenant through `app.current_workspace_id()` (the JWT claim). Every vitest
passed — they run as superuser or with the claim set directly. The first
browser run hit a 500 at step 1. The lesson is the phase's argument for
criterion 7: policies are only proven at the boundary the product actually
uses. The migration now uses the schema helper everywhere.

## 39. One mailbox per run — and one explicit override, not a loophole

The cron syncs a single mailbox per invocation, round-robin by least-recent
sync, because a slow IMAP server must never starve the others. Dev and ops
needed to aim at one tenant's box, so the route accepts `?workspaceId=` —
but the invocation still syncs exactly one mailbox. The guarantee is
"one per run", not "everything you can reach"; the parameter narrows the
candidate set, it never widens the work.

## 40. `error_code='bounce'` lives on the actions, not on the contact

The prompt is literal about the bounce marker, so the sent actions of the
dossier carry `error_code='bounce'` — an audit of "what did we send and what
happened to it" reads the reason where the sends are. The contact carries
`bounced_at` and the stop rule `CONTACT_BOUNCED`, which is what actually
blocks a resend; three records, one fact, each where its reader looks.

## 41. The privacy audit view shows facts, never contents

The prompt demands opt-outs be "visible in the settings audit view". The
settings page therefore grew an audit card: the twelve last opt-outs, bounces,
disconnections and purges, each a labelled fact with a timestamp. No subject
lines, no snippets — the view a user shows a worried client must not become
a second inbox.

## 42. Undo needs client state; the 10-second clock stays in SQL

The first close button used a plain `<form action={serverAction}>`: the server
revalidated, the client had no way to know a close happened, and the undo
toast never rendered. Both actions moved to `useActionState`, so the client
sees the result and renders the toast. The window itself never trusted the
browser: the SQL guard on `closed_at > now() - interval '10 seconds'` is the
clock, and past ten seconds the undo is a no-op. The toast is the visible
half; the deadline is the server's.

## 43. Retention is its own nightly route, not a rider on the sync

Purging bodies every ten minutes inside the sync would run a delete job 144
times a day to catch a boundary that moves once per day. The prompt calls
retention a nightly job, so it got its own bearer-protected route
(`/api/cron/retention`), logged as counts — the same "logs are counts, never
contents" rule as everything else in the phase.

## 44. The sandbox mailbox is a provider, not a mock of one

Demo flows need replies that arrive without a mail server. Rather than
bypassing the engine, the sandbox implements the exact `MailProvider`
interface Gmail and IMAP implement, and the cron path treats it like any
other mailbox — so the end-to-end proof (deliver → sync → sequence stops →
one-click close) exercises the real matching, real stop rules, real cursor.
The dev endpoint that feeds it is disabled unless `RROS_DEV_SEED=1` in a
non-production run.

## 45. Normalise at the provider boundary, tolerate at the match layer

Gmail returns `to` as a string, IMAP as an array; ids arrive with or without
angle brackets; `References` can be a string or a list. The provider
`normalise()` coerces the shapes once, and `match.ts` additionally tolerates
both on its side (`string | string[]`, canonical id stripping applied to
refs and sent ids alike). Two layers of tolerance cost less than one
malformed header slipping through a single gate.

## 46. ANALYZE after bulk inserts — the PGlite planner has no statistics to guess with

After a bulk insert the planner picks catastrophic nested loops (a two-table
`count` took 7.2 s; 134 ms after `ANALYZE`; the queue read went 7.4 s → 14 ms).
`commitImport` refreshes statistics after any import of ≥ 500 rows, and the
load seed does it too. On Supabase autovacuum covers this; the rule is written
down because nothing else in the codebase depends on planner statistics being
fresh — a future bulk writer must remember, or the whole workspace slows down
300× for no visible reason.

## 47. The queue cache needs the dataset to have someone to write to

`/api/queue` regenerated and returned zero items on every call: the load
dataset had no contacts (nothing to draft) and every row freshly sent at the
touch ceiling — 5 000 rejections, empty table, regenerate, repeat. The load
seed now attaches contacts to 80 % of the rows and calibrates eligibility to a
realistic day (~80 % candidates, ~10 % TOO_SOON, ~10 % TOUCH_LIMIT). A benchmark
dataset that exercises zero interesting rows is not a benchmark; it is a lie
with a stopwatch.

## 48. Authorization holes found by writing the matrix flow as HTTP, not by re-reading code

Three routes either gated the wrong action or none: `queue/regenerate`
checked `read:queue` (a viewer could rewrite the day's queue), and
`billing/checkout` + `billing/portal` (+ fake-pay) checked nothing at all.
All three now go through `can()` like everything else, and `flow_matrix.py`
replays 16 HTTP assertions per run — 403 for viewer on every write route,
no billing for member/admin, owner alone passes. Lesson: the matrix was pure
and correct; the holes lived where code simply forgot to call it.

## 49. The webhook test flow verifies the HMAC over the raw body, or it verifies nothing

The receiver now logs the exact body string it was sent, and the flow recomputes
`t=<ts>,v1=<hmac>` against it with `hmac.compare_digest`. The previous proof
was a placeholder that always printed False — a green-ish output proving no
signature ever. Verification code that cannot fail is not verification.

## 50. The API client fires each request once — mutative flows must not double-run

`flow_team.py`'s `api()` ran curl twice (status, then body). Reads don't care;
the reply POST cancelled the pending actions on call one and reported 0 on call
two — an invented bug that sent us reading the wrong repo function for an
hour. The client now dumps headers to a file and reads the body from the same
response. A test harness that double-executes mutations manufactures regressions.

## 51. Gate 7 closes windows with a status and an event, not by silently dropping

`WINDOW_CLOSED` used to be an eternal rejection: the dossier stayed `open`
forever while never appearing in any queue. The daily queue cron now expires
past-window opportunities (`status='expired'`, `closed_at`), emits
`opportunity.expired` per closing, and `expireWindows` is repo-level and
tested: idempotent (a retried cron re-enqueues nothing), tenant-bounded,
touches nothing inside the window. The customer's CRM keeps the history; the
webhook subscriber learns why the dossier vanished.

## 52. The export ZIP is a format contract, tested byte by byte

The builder wrote the entry offset at byte 16 of the LOCAL header — a field
that does not exist there, silently clobbering the CRC and size fields while
Python's lenient name listing stayed green. The strict test (signature, store
method, CRC32, sizes, central offsets, EOCD) and the real `zipfile.testzip()`
check both pin the contract now. Lesson: green because your reader is forgiving
is not green.

## 53. A11y is five colors and one missing label away from failing

The axe pass found exactly one critical (a `<select>` without an accessible
name) and one systemic serious (#98a2b3 on white, ratio 2.57, used everywhere
as "muted"). Fixing the token fixed all five screens; Lighthouse went to 100
across the board. Design tokens are accessibility infrastructure: choose them
once, at AA, and the screens inherit compliance instead of accumulating debt.

## 54. The launch gate walks a production build — and asserts the gates instead of bypassing them

`/internal/funnel` is open in development and locked behind `INTERNAL_EMAILS`
in production. The onboarding walk used to read the funnel numbers; on a prod
build it now asserts the redirect instead. A walk that flips env vars to see
its numbers proves nothing about what a customer gets — assert the lock, and
read the numbers where they legitimately live (a staging build with the
allowlist set).

## 55. A contactless dossier gets a facts skeleton, not a fake letter

Importing a messy CSV (no title column, no contact e-mail) produces dossiers
whose generation is refused twice — and the editor then shows the manual facts
skeleton (~177 chars), clearly not a polished letter. The launch gate first
called this a failure, then recognised it is the product's honesty rule: a bad
draft costs more than a missing one. The walk now requires ONE dossier with a
real ≥ 350-char draft — which a real export (with an object column) provides —
and accepts skeletons elsewhere. Datasets for demos must include the columns a
real agency exports; the product should not bend to thin ones.

## 56. The four launch invariants each get an adversary, not an assertion

I1 is attacked through six invented send routes, an API body carrying
`send:true`, and a forged cookie; I2 through four paths including direct SQL
with the tenant role (the `holdout.test.ts` suite did not exist — the trigger
was protecting the product untested); I3 through a job-level test that approves
three actions in a row; I4 through 200 real generations scanned with the
product's own commitment classes AND an independent regex. The gate's rule:
every "cannot happen" is demonstrated by trying to make it happen.

## 57. The dependency audit is triaged in writing, not silenced

`xlsx` was a direct dependency imported by nothing — the master scope is
CSV-only. It carried a prototype-pollution advisory: deleted, no replacement
needed. What remains in production (postcss via next, zod) requires breaking
majors (next@16, zod@4) and is documented instead of `audit fix --force`d:
postcss only processes OUR build-time CSS, zod validates bodies whose size the
routes already cap. The two dev-only criticals (tinypool/vitest chain) stay
test-runner-only. CI runs `npm audit --omit=dev --audit-level=high` as a
warning until the majors land — the report names them every time.

## 58. CI exists as a file before it exists as a runner

`.github/workflows/ci.yml` wires everything the acceptance criteria demanded
and that ran locally until now: typecheck, lint, the full vitest suite (RLS
coverage and the launch-gate invariants inside), the perf benchmark that fails
above 2× threshold, the production build, the dependency audit, and gitleaks
over the full history. The runner is the only missing piece — the contract is
already executable, which is exactly how a phase should hand work over.

## 59. Licensing manual-first: the payment declaration never opens anything

Migration 0009 (`products`, `users.is_platform_admin`, `subscriptions`, `payments`)
is additive: no existing table is rewritten, the Stripe billing stack is kept
and untouched (coexistence documented in the licensing report). `workspaces` is
left as the source of trial state; the new `subscriptions` row for product
`revenue_recovery_os` is the only source of paid truth. The customer declares a
transfer/Chariow/Maketou payment; the declaration inserts a `pending` payment
row and, at most, a `pending` subscription — never access.

## 60. Validity is computed, never stored-and-trusted

`getCurrentEntitlement` requires ALL of: `active`, `starts_at <= now`,
`expires_at > now`, product enabled — the status column alone proves nothing.
The 14-day trial branch is preserved verbatim (existing funnel keeps working);
an out-of-trial workspace with no subscription is `no_subscription`. Expiry is
flipped lazily on read (`status='expired'` + audited `subscription.expired`).
`now == expires_at` is already expired: no grace day, by construction.

## 61. One connection, one lock: confirmation is serialized by the mutex

PGlite is a single connection; two overlapping multi-statement transactions
interleave silently (a second `begin` just joins the first). `withExclusive`
(client.ts) routes `confirmPaymentAndActivateSubscription` and
`submitPaymentDeclaration` through the same chain as the tenant helpers. Inside
the exclusive window the payment row is re-read `for update`, an amount that
does not match the pegged price is auto-rejected (`amount_mismatch`, audited),
and the calendar extension (`+ interval '1 month'`, PG arithmetic: Jan 31 →
Feb 28) extends from `expires_at` when still active, from `now` otherwise. Any
failure rolls the whole confirmation back. On multi-connection Postgres the
same invariants come from the row lock + the `pending` state check.

## 62. Platform admin is a database fact with a column-scoped write path

`users.is_platform_admin` (default false) is read from the DB on every check
(`isPlatformAdmin`), never cached, never carried in the JWT. The app role's
UPDATE grant on users is column-scoped (`email, full_name, role, last_seen_at`)
— the application cannot grant itself platform rights even through a bug.
Dev seed sets the flag for the walk-through owner; in production it is SQL only.

## 63. XAF is a fixed peg, prices are minor units, Chariow/Maketou stay display-only

EUR prices ×100 are the source of truth; XAF is `round(eur × 655.957)` with no
subunit. The confirmation compares the DECLARED amount against this pegged
expectation per (plan, currency) — a mismatch rejects the payment instead of
activating. Chariow/Maketou are payment METHODS with instructions shown to the
customer only; no API integration was invented because none was verified.

## 64. Licensing gates every surface at its own layer

The `(app)` layout redirects to `/subscription` (navigation filter), the API-v1
`withApiKey` returns 403 `SUBSCRIPTION_REQUIRED`, the send cron skips with
`license_<reasonCode>` per workspace (observed live: `skipped:license_expired`
after a backdated expiry), and `/api/license` exposes the computed state
(401 without session, no-store). Layout filtering is never the enforcement —
each server surface checks the entitlement itself.

## 65. The recipe runs through dev-only mirrors, not curl-able server actions

Next 15 server actions cannot be driven by curl, so `POST /api/dev/licensing`
(op: declare/confirm/suspend/reactivate/entitlement/end-trial/expire/revoke-admin,
gated by `RROS_DEV_SEED=1` like the seed route) mirrors the actions one-to-one
for the automated flows; `tools/flow_licensing.py` walks the real journey
(14 checks): out-of-trial denial, declaration-without-access, admin console
confirmation, /api/license agreement, idempotent double confirmation,
amount-mismatch rejection, suspend/reactivate.

## 66. Stripe is gone: no payment processor in the architecture at all

Removed with this change: the gateway layer (`lib/billing.ts` gateway selection,
`domain/billing/restStripe.ts`, `domain/billing/fakeStripe.ts`, `priceFor`,
`catalog`), the checkout/portal/fake-pay routes, the `/api/stripe/webhook`
route and its signed-payload verification (`signature.ts`), the event state
machine (`stateMachine.ts`, `handleStripeEvent`, `applyPatch`), all the
checkout/portal server actions and UI pages, and `flow_billing.py`. There was
never an npm `stripe` dependency — the "SDK" was a hand-rolled REST wrapper —
so nothing to uninstall. Kept because they are NOT Stripe: the 14-day trial
lifecycle (`domain/billing/access.ts`, `runTrialJob`), the usage metering and
plan limits (`assertEntitlement`, `getUsage`, `resetUsage`), the funnel events,
the holdout control (moved to `lib/actions/holdout.ts`), and the licensing
module that now owns activation end to end. Non-destructive rule: the
`stripe_events` table and the `workspaces.stripe_customer_id /
stripe_subscription_id / billing_interval` columns remain in the schema,
unread and unwritten; dropping them is a future, explicit, destructive
migration. The "confirmed payment starts a clean meter" semantic survived the
removal: `confirmPaymentAndActivateSubscription` now calls `resetUsage`.

## 67. One money door: /subscription is the only activation surface

After the removal there is exactly one way to open the product: the manual
licensing page (declaration → admin confirmation). The settings page became a
state + holdout panel pointing to it, the SubscriptionBanner links retargeted
to `/subscription`, and `flow_matrix.py` now asserts the removed Stripe routes
answer 404 (owner included) so they cannot silently come back. Trial, usage
overage and pause banners keep working — they describe entitlement state, not
a processor.

## 68. The suite runs on REAL multi-connection Postgres — same SQL, zero shim

`Db` is now an interface (parameterised query + exec), not the PGlite class.
`RROS_DB_DRIVER=pg` + `DATABASE_URL` boots the same migrations on a real
PostgreSQL server (local binaries via `tools/pg_local.sh`; Supabase becomes a
connection-string change plus a re-run of the same suite). On that driver,
`asWorkspace`/`asSuperuser` borrow a DEDICATED connection per block: the
tenant role and the JWT claims live on that connection only, so RLS is
enforced per connection — the production topology. The suite is GREEN on both
engines: 568 passed + 4 driver-gated skips on PGlite, 572/572 on real
Postgres. `pg_multi.test.ts` (pg-only) proves with RAW clients what no
serializer can fake: cross-connection tenant isolation, grants binding the
real role, `FOR UPDATE` blocking a confirmation across connections (observed
wait, then win), and one month granted under concurrent confirmation.
Two real-engine findings fixed: a perf test inserted integers into a
timestamptz column (PGlite tolerated, real PG refused — test data corrected),
and the bulk-insert path needed the post-import `ANALYZE` the import flow
already performs (p95 1834 ms → 93 ms).

## 69. Sessions are revocable: the row outranks the cookie

Migration 0010 (additive): `sessions` (sid, user, workspace, role, email,
locale, created/last_seen/expires/revoked/reason). Every issuer goes through
`mintSession` — rotation (a new session revokes the previous sid), row
insert, JWT carrying the sid. `getSession` verifies the signature AND the
row: revoked or expired or sid-less (pre-0010 cookie, forgery) → refused,
checked from the database on EVERY request. Signout revokes server-side
before destroying the cookie; the retention cron purges rows expired > 30
days. The tenant role gets SELECT (workspace-scoped by RLS) and NO write
grants — revocation is a service-path act. Proven live (`session_revocation_check.mjs`,
6/6): a STOLEN cookie replayed from another browser is refused the moment
the victim signs out. Two real bugs surfaced and fixed along the way: the
middleware's cookie-presence redirect dead-looped holders of a stale cookie
(login/signup pages now own that check), and the dev team route minted
sid-less tokens (now routed through mintSession).

## 70. The passwordless core is extracted and injected, not mocked

The magic-link semantics (atomic single-use consumption by SHA-256 lookup
with expiry, deterministic oldest-account resolution) live in
lib/auth_tokens.ts with the database as a parameter; /api/auth/verify keeps
only the HTTP redirect and the session call. This happened because (a) the
flow had ZERO automated coverage and (b) vi.mock does not propagate into a
route's module graph in this vitest setup — injection beats mocking here and
makes the security semantics testable on any driver. 7 auth_flow tests now
pin the contract; the cookie half is proven live (magic_link_live.mjs in dev
mode, session_revocation_check.mjs 6/6). Also fixed during the verification:
next dev was sharing .next with the production build and clobbered it —
NEXT_DEV_DIST=1 gives dev its own distDir.

## 71. The AR "risk" is a relance priority — renamed before it could lie

Building the Accounts-Receivable view surfaced a naming trap: the first
draft labelled the engine score a "risk score". The §7.2 score is an
EXPECTED RECOVERY VALUE × URGENCY — it ranks what is worth chasing now; the
schema holds no payment or due-date data, so no view may imply a default
probability. Renamed everywhere (PRIORITY_BANDS, priorityBand,
priorityIndex 0-100 workspace-normalized, priority_desc, view
priority_high, CSV priorite/indice_relance) and the UI footer states it
explicitly. Also fixed while wiring the page: the stage weights were
imported from signals.ts STAGE_SCORE (0.30–0.85) instead of a duplicated
invented table; KPIs are computed on the WHOLE workspace perimeter before
filtering; the CSV export passes pageSize 0 = the whole filtered set (the
first draft truncated at 100 rows); ArRow carries both the normalized index
(badge) and the raw engine score (tooltip/CSV). Proofs: 14 repo tests,
24 live API checks (401/400/403/CSV/isolation), 14 UI walk checks with
screenshots (tools/ar_api_live.mjs, tools/ar_page_walk.mjs).

## 72. Growth layer on a private-first app: public island, private noindex, measured funnel

Preparing commercial growth touched the routing contract, so it is written
down: `/` now lands cold visitors on the PUBLIC product page (`/fr/product`)
instead of a login wall — marketing pages live in a new `(public)` route
group (product, pricing, security) sharing the app's design tokens and
reading the REAL plan limits from entitlements/check.ts, so marketing cannot
drift from what the product enforces. Every private page group carries
`robots: noindex` (defense in depth; auth stays the lock), robots.txt
excludes /api and admin, the sitemap lists ONLY the 8 canonical public URLs
with reciprocal hreflang. `<html lang>` was hardcoded "fr" and is now driven
by an x-locale REQUEST header from the middleware. Funnel measurement is
first-party and finance-free by SCHEMA: analytics_events (0011) has no
column that could hold an amount or a client name, event names are a server
allowlist, crawlers are refused, activation milestones stay in the existing
funnel_events. Adding the table surfaced the RLS coverage invariant
(rls.test.ts) — satisfied by an explicit default-deny policy (0012) rather
than an exemption. Minimisation: committed imports now null out
staged_rows/headers (raw file copy not retained). Known blocker: the site
URL is localhost until a production domain exists (NEXT_PUBLIC_SITE_URL).
