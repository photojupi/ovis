### Added
- `scripts\herdr-app.ps1` runs Ovis on the Herdr app's terminals on Windows from a clone: it
  installs and builds what is missing, waits for the app's core, starts Ovis with no window, and
  with `autostart on` does so at sign-in.

### Fixed
- On Windows Ovis no longer starts a core of its own when it cannot reach the Herdr app's, one that
  took Ovis's environment and stopped with Ovis, terminals and all: it says to open the app and
  connects once the app's core is up.
- On Windows a health request no longer opens the core's pipe to see whether the core runs, and a
  `socket` in hc's `config.toml` is read from `%APPDATA%`, where hc reads it.
