# Row states

How a Work-tab row gets its group, its text and its button.
One model, read top to bottom: the first rule that matches wins.
Same inputs give the same group and the same order, on every start and every device.
`tests/unit/states.mjs` checks every line of the MR and helper tables and the order; the Work browser tests check the chats' own rows and Dismiss.

## Inputs

Only structured facts place a row.
Free text (how a reply is worded) may fill a row's text, never its group, except where marked *text* below.

| Input | From | Kept across a restart |
|---|---|---|
| MR state (open, merged, closed, draft, pipeline, conflicts, approvals, threads) | the forge (`glab`, `gh`), comments included | asked again at start: the first poll waits for the answer; a failed lookup keeps the last answer (marked stale) while the server runs, and without one the row is Not checked |
| Helper status (running, stopped + why, done) | its transcript and tmux | yes (transcript) |
| Chat status (working, asking, idle) | turn markers in its transcript, the asking hook's marker | yes (transcript) |
| Chat works on the MR | the chat's folder has the MR's branch checked out, or `homebase status doing --mr` | yes (git, `reports.json`) |
| Chat waits on you about the MR | `homebase status needs-you --mr`, else its open question names the MR first (*text*) | yes |
| Button clicked | the server's record of the send | yes (`sent.json`), for 30 minutes |
| Dismissed | `dismissed.json` | yes |
| A died chat opened | `handled.json` (its last entry) | yes, on every device |
| Approved by | GitLab's approvals, asked once the MR is mergeable | as the MR state |

## Precedence for an MR row

| # | When | Group | Text | Button |
|---|---|---|---|---|
| 1 | merged | Merged | Merged | none |
| 2 | closed | Closed without merging | Closed without merging | none |
| 3 | its chat waits on you about it | Needs you | `Asks: <question> · <what rules 4–10 say>` | theirs (none while a helper runs) |
| 4 | a helper on it runs (it leads the row however quiet, over newer finished or stopped ones) | Doing | the helper's current step | none |
| 5 | a chat on its branch works, or reported `doing` | Doing | the report, else the chat's current step | none |
| 6 | an open prompt names it and nothing runs yet (*text*) | Doing | Sent to Claude… | none |
| 7 | its button was clicked, the MR's own kind is still the one clicked (also checked while rules 4–6 show), under 30 min ago | Doing | Sent to Claude (time) · button back at (time) | none |
| 8 | a helper on it stopped | Needs you | why it stopped | Continue |
| 9 | the forge never answered (rules 3, 5 by a report, and 8 still apply) | Not checked | why the lookup failed | none |
| 10 | the MR state, first blocker wins (below) | | | |

MR state, first match wins:

| Kind | When | Group | Button |
|---|---|---|---|
| changes | review comments to fix or answer, or changes requested, also on an approved MR (its text then starts Approved) | Needs you | Fix & reply |
| failing | pipeline failed | Needs you | Fix pipeline |
| conflict | conflicts, or needs a rebase | Needs you | Rebase |
| blocked | blocked by another MR or external checks | In review | Review |
| draft | nothing blocks it but the draft flag | Needs you | Mark ready |
| threads | approved, replied threads still open | In review: Approved — waiting for (reviewer) to resolve N threads | none (approved needs no reviewer) |
| replied | replied to threads, waiting on the reviewer | In review | Review |
| pipeline | pipeline running | In review | Review |
| ready | mergeable and approved by someone (GitLab asks its approvals; GitHub: approved, or no review required), nothing unanswered | Ready to merge | GitLab: Merge (Homebase merges after a confirm); GitHub: Merge + close issue (asks the chat to run the gate, then merge) |
| in-review | has reviewers | In review | Review |
| needs-reviewer | no reviewer | In review | Request review |

Review starts a read-only reviewer chat; it shows on every In review row that is not approved and has no button of its own.
Two chats on one MR: the one that reported wins, then the lower session id, so the text is the same every poll.

## A helper without an MR

| When | Group | Button |
|---|---|---|
| running | Doing | none |
| stopped (API error, rate limit, interrupted, chat closed, silent) | Needs you | Continue (a click holds it in Doing as rule 7 does) |
| done, under 2 hours ago | Recently finished | Dismiss |

## A chat's own row (main chats)

| When | Group |
|---|---|
| asking (question, permission prompt), or its last reply says `needs you` (*text*: the topic line or a Waiting on you block), and no MR row stands for it | Needs you |
| its turn died mid-way and you haven't opened it | Needs you |
| working | Doing |
| working, and its running or queued prompt names an issue (`#N`, *text*) no row covers yet | Doing, as `#N · starting…` instead of its working row |

## Order inside a group

Newest work first, never by last activity: an MR by when it was opened on the forge (else when Homebase first saw it), a helper by when it started, a chat by when it started; ties by key.
A group lists its work rows first, then the chats' own rows.
A row never moves inside its group; it only moves when its group changes.

## Moving a row by hand

A click on a row's button is the only manual move: the row goes to Doing at once (rule 7) and stays there while its kind is the one clicked, across restarts, for at most 30 minutes.
When the kind changes the click is over, so the same failure coming back later shows its button again; after 30 minutes the button is back too, because the chat did nothing the forge can see.
Review and Merge are not holds: Review shows Reviewing… on its row, Merge turns the row Merged.
