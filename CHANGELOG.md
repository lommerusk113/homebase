# Changelog

Notable changes to Homebase, newest first.

## Unreleased

* `homebase status --mr` is resolved once to the MR's URL by the chat's own forge (`!N` on GitLab, `'#N'` on GitHub, or a URL) and anything else is refused; a doing report ends at the next prompt that starts a turn, a needs-you report at any input from you (a prompt, a note typed while it works, an answered question or permission prompt), and "Load new rules" is recognised from Homebase's own send log, not its text.
* GitLab's and GitHub's last answers are kept with each MR in items.json, so a restart shows the board as it was at once and asks again in the background; while a forge is still checking, mergeability comes only from its last settled answer for the same commit (a new commit is unknown, never Merge), and the extra re-asks are gone.
* A forge that is still checking on a second lookup keeps a clicked row's hold too, and `homebase status --mr` with an MR URL plus `/diffs`, `#note_…` or `?tab=` matches its row (a URL naming no MR is refused).
* A GitLab MR's first lookup after a start asks again while GitLab is still checking, and a guess from a forge still checking never ends a clicked row's hold.
* An answer typed while a chat is still working now ends its `homebase status needs-you` report (a doing report stays while the chat works); a GitLab `--mr '#12'` (an issue) is refused with what to write instead, and an empty `--mr` says the `#` was read as a shell comment.
* `homebase status --mr !N` places GitHub rows too; an update without `--mr` keeps the MR the chat named before, a first report without one is refused, and `--mr` with no value (an unquoted `#12`) fails instead of reporting nothing.
* Clicking "Load new rules" in a chat no longer ends its `homebase status` report as if you had answered it.
* Saving several report or click changes at once no longer corrupts reports.json or sent.json; answering a chat's question ends only its needs-you report, not the doing report of a chat that keeps working; merged or closed GitHub PRs skip the extra mergeability lookup.
* A `homebase status` report from a chat that was cleared or closed no longer holds its MR row; an answered report stays over even once the answer scrolls out of the transcript; a GitHub PR's first lookup asks again instead of guessing while GitHub computes mergeability.
* A conflicted GitHub PR no longer flips to Ready to merge while GitHub recomputes it; answering a chat's question ends its needs-you report like a prompt does; `homebase status --mr '#12'` works for a GitHub PR (on GitLab `#12` is an issue and matches no MR), a malformed MR is refused, and a hand-edited reports.json can't take the board down.
* `homebase status needs-you --mr !N` without a question no longer breaks the whole board; the row reads "Asks: see its chat".
* Merge asks GitLab again before it merges, so a comment or a withdrawn approval from the last minute is seen first; an MR approved while GitLab rechecks reads "not mergeable yet (GitLab: still checking)".
* A row waiting on threads the project requires resolved no longer flips to "Needs a reviewer" for a minute while GitLab rechecks the MR, and on GitHub replied threads never stand in for a running pipeline or a missing review.
* A Review click on a requested MR no longer answers "not a merge request that asks you for a review" when the server's list was cold (after a restart) or its last refresh failed: it fetches the list first. The review chat now runs review-gate and then polish-loop, still read-only, and ends with a TLDR.
* Threads you replied to no longer stand in for what really stops an MR (no reviewer yet, a running pipeline); they count as the blocker only when the project requires them resolved, and are otherwise noted in the text ("· 1 open thread").
* An approved MR GitLab can merge shows Merge even with open threads ("Approved by Børre — merge it · 2 open threads"); only a project that requires resolved threads keeps it waiting on them.
* Merge merges only the commit the row showed when you clicked it: a push while the confirm was open is refused with "The MR changed since you clicked Merge".
* A clicked Continue on an MR row stays held while its own prompt runs, until the helper runs again.
* An approved MR GitLab won't merge yet says why ("needs a passing pipeline", "still checking"); Send findings no longer shows its row in Doing on the clicking device; the Issues tab no longer claims Homebase never writes to GitLab.
* A held row ("Sent to Claude") shows how a helper that finished since went, instead of hiding it until the button comes back.
* Send findings no longer parks its row in Doing for 30 minutes; a Not checked row says why the lookup failed before what its helper did; an unreviewed GitHub PR's stage reads Review, matching its Ready text.
* An MR approved by someone but not mergeable yet reads "Approved by Ann — not mergeable yet" instead of asking for a reviewer; "Approved —" on review comments only shows when someone approved it; an MR whose comments could not be read keeps its title and helpers while Not checked.
* Of several running helpers on one MR the first started leads its row, so text and Step in no longer swap; a helper that stopped after you clicked shows Continue instead of the hold.
* A failed comments lookup no longer places a row as if nobody had commented: it keeps the last answer, and an MR whose comments could never be read is Not checked (with why), never Ready to merge over unanswered threads.
* A running helper keeps its MR row in Doing however quiet it is; a failure that comes back while a chat worked on it shows its button again once the chat is idle; a held row says when its button comes back; a chat's report and a Continue count before the forge has answered; an MR approved while its pipeline runs stays Approved.
* Row texts say what the button does and who acts: "Helper stopped — Continue resumes it", and a GitHub PR that needs no review reads "Ready — merge it" instead of claiming it was approved.
* A clicked button's hold now outlives the chat's turn that handles it and the helper it starts; unanswered comments on an approved MR keep it in Needs you with Fix & reply (as before), and the row model doc says so.
* The first board after a Homebase start already counts review comments, so rows no longer start in one group and move a poll later; one failed approvals lookup keeps an MR's last state instead of dropping it out of Ready to merge.
* Opening a chat whose turn died clears its Needs you row on every device, not only in the browser that opened it.
* MR rows are ordered by when the MR was opened (the same on every install, not by when Homebase first saw it), and the chats' own rows by when the chat started, so they no longer swap as chats take turns writing.
* A clicked button's hold in Doing ends for good once the row's state changes, so a pipeline that fails again later shows Fix pipeline at once; Review no longer sends its row to Doing; a question about the MR beats the hold; a clicked Continue holds a helper row on every device; a working chat's own step shows instead of "Sent to Claude…".
* A GitLab MR is Ready to merge, with its Merge button, only once someone approved it ("Approved by Ann — merge it"); a mergeable MR nobody approved stays In review.
* Rows keep their place inside a group (newest work first) instead of reshuffling whenever a helper writes something, and two chats on one MR no longer swap the row's text from poll to poll.
* An MR row sits in Doing, with what runs ("Running tests") and no Rebase or other MR button, while a chat or helper works on it, also when only its background tests run: found by the branch its folder has checked out (no longer the folder it started in), or by what it reported.
* Chats report their MR work with `homebase status doing|needs-you|done --mr !N "<what>"`, and the board places rows from that instead of from how a reply is worded; the rules file tells chats to use it.
* Clicking a row's button (Rebase, Fix…) keeps it in Doing until the MR's state changes, instead of jumping back to Needs you as soon as the chat's turn ends; the hold survives a Homebase restart and ends after 30 minutes, when the button comes back.
* A chat or helper idle at its prompt while its own background commands, Monitors or subagents still run (browser tests, `npm run ship`) shows as working, not waiting, until their completion notice arrives (or they are silent for 30 minutes); `homebase helper wait` keeps waiting meanwhile.
* An approved GitLab MR goes straight to Ready to merge with a Merge button that asks first and merges it from Homebase; the Run gate step and the Review button are gone for approved MRs, and a row that can't merge yet says why.
* While a Review requested row's review chat, or a helper it started, is working, its Review button turns into a pulsing "Reviewing…" that opens that chat; Review comes back when they are idle.
* A "Review requested" row has a Review button that starts a new chat in that MR's project, reading the MR with `glab` and reviewing it read-only (no push, comment or approval), and opens it.
* A message sent while Claude's input box still holds text (a prompt Claude put back after an Esc before it answered) is no longer glued onto that text and sent as one; Homebase erases what it typed and says what is in the box, to send or clear in the terminal.
* A main chat that cd'd into an issue worktree stays the main chat and is never filed under that issue's milestone; "Start a fresh conversation" and "Restart chat" start Claude in the folder the chat was started in, not the worktree.
* A helper started from a chat that has cd'd into a linked worktree now runs in the project's main checkout (and new worktrees are made under it, still branching from the chat's own HEAD), so its row is no longer filed under that worktree's issue milestone.
* A helper saved without a branch keeps its worktree path, so the milestone filter places its row by its issue instead of showing it under every milestone after a restart.

* A chat asking about an MR ("MR !1856 … force-push?") puts that MR's row in Needs you, also from a main chat checked out on another issue; a chat waiting on you is never hidden by the milestone filter
* The Token saver now turns itself on at 90% of the five-hour (session) limit, ignoring the weekly one, and the switch shows ON with a note like "auto, 91% used"; switching it off holds until session usage drops back under 90%.
* Switching to a project with a stored milestone now holds the board back until its issues load, like a page load does, instead of flashing rows outside the milestone and then dropping them
* Opening a helper's chat from its row no longer fails with "Homebase hit an error" when its parent chat was cleared or compacted after the helper started; a vanished helper transcript now answers 404.
* A helper titled "MR 1849 …" now counts as work on that MR, so its row stays in Doing after you click Fix & reply instead of falling back to Needs you.
* Loading new rules after a reply that asks you something no longer drops it from "needs you" (board, filter, notifications).
* `homebase-rules.local.md` is now appended after `homebase-rules.md` instead of replacing it; both are watched for "Load new rules".

## 0.1.0 - 2026-11-21

The first numbered state.

* A board of your Claude Code chats per project, with status, subagents, PR/MR state and work items.
* Chats driven through tmux: send, answer questions and permission prompts, interrupt, `/clear`, `/compact`, restart, pick a model.
* New project from GitHub or an existing folder, a changes view, and use from a phone through Tailscale with device pairing and push notifications.
* `--doctor`, `--setup` and `--demo`.
* Checked with Claude Code 2.1.331; a newer installed version shows a warning in the header and in `--doctor`.
* A `/model <alias>` sent from a chat backs up `~/.claude/settings.json` before restoring the default model.
* The session list is built once for all pages polling at the same time.
* On a phone: board actions ask before sending, a send button (Enter adds a line), a one-row header that stays on screen above the keyboard, menus and tables that fit the screen, 44px tap targets, and no "Pair a device…" on a paired device.
* In the chat, a button's message ("Load new rules", a row action, an issue's Start), slash-command and `!` output, and a "Ran: …" line each show as one line that opens to the full text; commands in a row fold into one.
* Issues and forge: an issue a chat already works on offers "Check on it" instead of a second Start, a forge that cannot be reached says so on the board in plain words (old data kept and dated), GitHub issues link to their PRs and say PR/GitHub, a conflicting PR is blocked, a project without milestones shows the issues assigned to you, and an MR closed without merging has its own group.
* Accessibility: Enter on a waiting row never lands on an answer, the phone layout with pane tabs up to 900px (a zoomed desktop), new replies announced to screen readers, a modal changes view, 12px smallest text and 4.5:1 status colours, names for the unnamed controls, and a switch for single-character shortcuts in the `?` overlay.
* When things go wrong: one odd transcript entry or unreadable chat no longer fails the whole board (it is skipped and logged once), a missing `~/.claude/projects` folder is an empty first run, and a corrupt `config.json`, `handled.json` or `tracked.json` is set aside as `.bak` with a log line (`--doctor` reports the config). The page says "Server error" for a failing Homebase and "Offline" only when it can't be reached.
* A chat whose turn went silent for 30 minutes without ending keeps a Needs you row until you open it (only turns that died after this first ran; never a chat you closed, and no push), and a chat still waiting on your answer stays on the board for up to 14 days.
* A send Homebase did not answer in time is "Not confirmed" rather than "Not sent", and Retry checks the transcript first so nothing is sent twice; the draft is dropped when the send starts.
* A reply that can't be rendered shows as plain text instead of blanking the chat; a huge table or code block shows its first part with "Show all"; "Show earlier" says when older messages are only in the terminal; right-to-left titles no longer tear row labels; ages follow the server's clock.
