# Row states

How a Work-tab row gets its group, its text and its button.
One model, read top to bottom: the first rule that matches wins.
Same inputs give the same group and the same order, on every start and every device.
`tests/unit/states.mjs` checks every line of the tables below.

## Inputs

Only structured facts place a row.
Free text (how a reply is worded) may fill a row's text, never its group, except where marked *text* below.

| Input | From | Kept across a restart |
|---|---|---|
| MR state (open, merged, closed, draft, pipeline, conflicts, approvals, threads) | the forge (`glab`, `gh`) | yes: the last answer is stored in `items.json` and served until the first new one |
| Helper status (running, stopped + why, done) | its transcript and tmux | yes (transcript) |
| Chat status (working, asking, idle) | turn markers in its transcript, the asking hook's marker | yes (transcript) |
| Chat works on the MR | the chat's folder has the MR's branch checked out, or `homebase status doing --mr` | yes (git, `reports.json`) |
| Chat waits on you about the MR | `homebase status needs-you --mr`, else its open question names the MR first (*text*) | yes |
| Button clicked | the server's record of the send | yes (`items.json`), for 30 minutes |
| Dismissed | `dismissed.json` | yes |

## Precedence for an MR row

| # | When | Group | Text | Button |
|---|---|---|---|---|
| 1 | merged | Merged | Merged | none |
| 2 | closed | Closed without merging | Closed without merging | none |
| 3 | its chat waits on you about it | Needs you | `Asks: <question> · <MR step>` | the MR step's |
| 4 | a helper on it runs | Doing | the helper's current step | none |
| 5 | a chat on its branch works, or reported `doing` | Doing | the report, else the chat's current step | none |
| 6 | an open prompt names it and nothing runs yet (*text*) | Doing | Sent to Claude… | none |
| 7 | its button was clicked, the MR state is unchanged, under 30 min ago | Doing | Sent to Claude (time) | none |
| 8 | a helper on it stopped | Needs you | why it stopped | Continue |
| 9 | the forge never answered | Not checked | why the lookup failed | none |
| 10 | the MR state, first blocker wins (below) | | | |

MR state, first match wins:

| Kind | When | Group | Button |
|---|---|---|---|
| changes | review comments to fix or answer (not approved) | Needs you | Fix & reply |
| failing | pipeline failed | Needs you | Fix pipeline |
| conflict | conflicts, or needs a rebase | Needs you | Rebase |
| blocked | blocked by another MR or external checks | In review | none |
| draft | nothing blocks it but the draft flag | Needs you | Mark ready |
| threads | approved, replied threads still open | In review | none |
| replied | replied to threads, waiting on the reviewer | In review | none |
| pipeline | pipeline running | In review | none |
| ready | approved and mergeable | Ready to merge | Merge |
| in-review | has reviewers | In review | Review (a reviewer chat) |
| needs-reviewer | no reviewer | In review | Ask for review |

## A helper without an MR

| When | Group | Button |
|---|---|---|
| running | Doing | none |
| stopped (API error, rate limit, interrupted, chat closed, silent) | Needs you | Continue |
| done, under 2 hours ago | Recently finished | Dismiss |

## A chat's own row (main chats)

| When | Group |
|---|---|
| asking (question, permission prompt), or its last reply says `needs you` (*text*: the topic line or a Waiting on you block), and no MR row stands for it | Needs you |
| its turn died mid-way and you haven't opened it | Needs you |
| working | Doing |

## Order inside a group

Newest work first, by when the row first appeared (an MR: first seen by Homebase; a helper: started), never by last activity.
A row never moves inside its group; it only moves when its group changes.

## Moving a row by hand

A click on a row's button is the only manual move: the row goes to Doing at once (rule 7) and stays there while the MR is unchanged, across restarts, for at most 30 minutes.
After that it comes back with its button, because the chat did nothing the forge can see.
