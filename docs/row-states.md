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
| Chat waits on you about the MR | `homebase status needs-you --mr`, else its open question names the MR first (*text*); a report counts only from a live chat no `/clear` replaced, until you answer it (a doing report: your next prompt; a needs-you report: also your answer to its question) | yes |
| Button clicked | the server's record of the send | yes (`sent.json`), for 30 minutes |
| Dismissed | `dismissed.json` | yes |
| Pinned to a group by hand | `pins.json`, with a fingerprint of the row's state; shown in the pinned group (marked *pinned*) until the fingerprint changes | yes |
| A died chat opened | `handled.json` (its last entry) | yes, on every device |
| Approved by | GitLab's approvals, asked for every open, non-draft MR GitLab doesn't already call unapproved | as the MR state |

## Precedence for an MR row

| # | When | Group | Text | Button |
|---|---|---|---|---|
| 1 | merged | Merged | Merged | none |
| 2 | closed | Closed without merging | Closed without merging | none |
| 3 | its chat waits on you about it | Needs you | `Asks: <question, or "see its chat"> · <what rules 4–6 and 8–10 say>` (a question beats the hold) | theirs (none while a helper runs) |
| 4 | a helper on it runs (it leads the row however quiet, over newer finished or stopped ones; of several, the first started) | Doing | the helper's current step | none |
| 5 | a chat on its branch works, or reported `doing` | Doing | the report, else the chat's current step | none |
| 6 | an open prompt names it and nothing runs yet (*text*) | Doing | Sent to Claude… | none |
| 7 | its button was clicked, the MR's own kind is still the one clicked (also checked while rules 4–6 show; a forge still checking counts as unchanged), under 30 min ago, and no helper on it stopped since (then rule 8) | Doing | Sent to Claude (time) [· Helper finished: (outcome), when one did since] · button back at (time) | none |
| 8 | the helper that last wrote on it stopped (a later finished helper supersedes it) | Needs you | why it stopped | Continue |
| 9 | the forge never answered, or its comments could never be read (rules 3–8 still apply; 5 by a report only while the forge never answered) | Not checked | why the lookup failed | none |
| 10 | the MR state, first blocker wins (below) | | | |

MR state, first match wins:

| Kind | When | Group | Button |
|---|---|---|---|
| changes | review comments to fix or answer, or changes requested, also on an approved MR (its text then starts Approved) | Needs you | Fix & reply |
| failing | pipeline failed | Needs you | Fix pipeline |
| conflict | conflicts, or behind its target with another blocker (draft, no approval, pipeline running, discussions to resolve) | Needs you | Rebase (GitLab, behind only: GitLab rebases it, "Rebasing on GitLab…" until done, the chat is asked only if GitLab fails; a real conflict asks the chat) |
| blocked | blocked by another MR or external checks | In review | Review |
| draft | nothing blocks it but the draft flag | Needs you | Mark ready |
| replied | not mergeable, and the threads open are ones you replied to (the project requires them resolved): waiting on the reviewer | In review | Review (none once approved) |
| pipeline | pipeline running | In review | Review |
| ready | mergeable and approved by someone (GitLab: also one whose only blocker is being behind its target; the text says so, and Merge has GitLab rebase it) (GitLab asks its approvals; GitHub: approved, or no review required), nothing unanswered; open threads the project lets stay open are counted in the text ("Approved by Børre — merge it · 2 open threads"), never a blocker | Ready to merge | GitLab: Merge (no confirm; the row shows queued at once and goes back with the error if refused; the server queues it only if the cached row still offers Merge at the head clicked, see Merge queue); GitHub: Merge + close issue (asks the chat to run the gate, then merge) |
| in-review | has reviewers, or approved but not mergeable yet ("Approved by Ann — not mergeable yet (GitLab: needs a passing pipeline)") | In review | Review (none once approved) |
| needs-reviewer | no reviewer | In review | Request review |

Review starts a read-only reviewer chat; it shows on every In review row that is not approved and has no button of its own.
Two chats on one MR: the one that reported wins, then the lower session id, so the text is the same every poll.

## A helper without an MR

| When | Group | Button |
|---|---|---|
| running | Doing | none |
| stopped (API error, rate limit, interrupted, chat closed, silent) | Needs you | Continue (a click holds it in Doing as rule 7 does) |
| stopped on a transient API error, or silent, and Homebase is continuing it (below) | Doing, "Retrying (2/3)…" or "Nudging (2/3)…" | none |

A helper's chat whose last turn failed on the API is a stopped helper too (API error, or rate limit), not a finished one.

### Automatic Continue

`server/autoretry.mjs`, on every poll, sends the canned Continue to a chat with a live Claude (never starts one):

| Stopped on | What happens | Then |
|---|---|---|
| a transient API error (overloaded, server error, "computer went to sleep"; not a login or request error) | Continue 30 s, 2 min and 5 min after the failure, one per failure; the row is Doing "Retrying (n/3)…" | after the third the row is Needs you with Continue and "retried 3 times"; the count starts again after 10 min without a failure |
| a rate limit | nothing, unless the message says when it resets ("resets 5pm", local zone): one Continue 30 s after | as before |
| silent (a subagent, no output for 10 to 30 min) | Continue at once, then every 60 s, at most 3 times; the row is Doing "Nudging (n/3)…" | Needs you, "nudged 3 times" |

Each send is in the send log (`sends.json`), so the feed, reports and holds treat it as Homebase's note; the counts are in `retries.json`.
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

## Merge queue

Merge on a GitLab MR (ready, or only behind its target) is the queue's button: it puts the MR in the queue at once, the row first shown queued by the page before the POST answers, (`server/queue.mjs`), and the row goes to Doing as "Queued to merge (n of m onto <target>) — <step>" with the same button reading Unqueue. There is no second button.
One MR per project and target branch moves at a time, the oldest first: behind its target → GitLab rebases it; running pipeline or GitLab still checking → waits; ready → merged at the commit seen.
A conflict or a failed pipeline does not drop it: when nothing else would stop it (approval, threads, draft) and the MR has a chat, that chat gets the row's own Rebase or Fix pipeline message once, and the MR stays queued as "waiting for its chat to fix the conflict / the pipeline" while the next MR of its line goes.
Clean again (no conflict, pipeline not failing) it takes its place in the line and merges in turn; if the problem is another one it asks again, at most 3 times per MR.
It leaves the queue, and the row says "Left the merge queue: <why>" while the MR is unchanged, on: conflicts or a failed pipeline with no chat to ask (or one that can't be asked), its chat going idle for 90 s (after 2 min) with the MR still broken ("its chat could not fix the pipeline"), or still broken after 6 hours, needs approval, unresolved discussions (changes requested, or the project requires them resolved), draft, closed (a merge elsewhere just ends it).

## Moving a row by hand

A click on a row's button is the only manual move: the row goes to Doing at once (rule 7) and stays there while its kind is the one clicked, across restarts, for at most 30 minutes.
When the kind changes the click is over, so the same failure coming back later shows its button again; after 30 minutes the button is back too, because the chat did nothing the forge can see.
Review, Send findings and Merge are not holds: Review shows Reviewing… on its row, Send findings hands the reviewer's findings to the chat, Merge puts the MR in the merge queue (Queued to merge, then Merged).
