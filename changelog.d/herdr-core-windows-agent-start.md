### Added
- With `OVIS_RUNTIME=herdr-core` on Windows, **New workspace** and **New tab with agent** start the
  agent in the pane's PowerShell or cmd, typing the line that shell reads and telling a busy shell
  and a started agent from this PC's process table. An argument the shell would change is refused
  before anything is typed, though cmd reads an agent's arguments again when PowerShell starts it
  through a `.cmd` file alone, which is not refused. A POSIX shell (Git Bash, WSL) takes no start
  there, and a Windows PC offers no agent on another machine of its core.
