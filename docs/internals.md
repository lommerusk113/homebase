# Internals

Details the README leaves out because you do not need them to use Homebase.

## Startup dialogs

A blocking startup dialog in a `cc-*` tmux session, other than the trust dialog Homebase answers itself (README, "New project"), shows in the chat with its options as buttons (and the `tmux attach` hint); clicking one selects it in the terminal, and the message box refuses to send while it is up.

## Slash commands that open a panel

A slash command typed in the chat that opens a Claude Code panel (`/usage`, `/status`, `/config`, `/help`, `/model` with no argument…) has its panel read and closed with Esc, and the panel's text shows under the command; a picker's choice is made in the terminal or by typing the command with its argument. What a command prints (`/context`, `/model opus`) shows the same way. `/exit`, `/quit`, `/login` and `/logout` are refused, and a panel Esc won't close refuses sends until you close it (Stop, or the terminal).
