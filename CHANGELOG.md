# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.18] - 2026-10-21

### Fixed

- The orphan sweep no longer ends the Host's other children. Those are whatever the user (or an agent) started from DSH's own terminal — a second `dsh web` instance, a dev server, a build — and killing them on shutdown/restart is destructive and surprising. Only the app's own processes are cleaned now: the Electron main's children that share its image name. Set `DSH_POWER_MENU_KILL_HOST_CHILDREN=1` to restore the previous behaviour.

### Added

- Restart reuses the argv the current instance was started with, read per DSH home from `<DSH_HOME>\power-menu-relaunch-args.json` (or `<home>/.dsh/dsh-power-menu/relaunch-args.json` when `DSH_HOME` is unset). A home launched with `--user-data-dir=<home>\userdata` keeps that switch instead of silently falling back to the default Electron profile; two isolated homes no longer share one.
## [0.1.17] - 2026-10-21

### Changed

- The power button is back in the top-right header and also appears on the no-session welcome screen. It mounts through the root-scoped `shell.overlay`, then appends inside `[data-conversation-header-corner]` after the native sidebar toggle; a `MutationObserver` replaces the 500ms polling, and one forced header reflow after appending makes the welcome screen's native panel icon appear without manually resizing. It never registers the single-`header.corner` slot, so it cannot replace the native sidebar toggle. The mount is still DOM-dependent: a pure slot would place the button in the bottom-left sidebar footer, not at the requested top-right position.
- The menu chooses its direction from the available viewport space: it opens upward near the bottom and to the right when the trigger is on the left.
- Restart readiness now waits for a real main window (`waitForWindow`, 20s) instead of treating "process is alive" as success. A crash/error window (for example the "无法使用" DSH dialog) fails the restart.

### Fixed

- `desktopTarget` rejects `node.exe` even when `ELECTRON_RUN_AS_NODE=1` is inherited, so a plugin-spawned Node process is never mistaken for the desktop app.
- Origin checks require a present Origin whose **host:port** matches the server; `Origin: null` and wrong-host Origins are rejected. A missing Origin is accepted again because the desktop shell may omit it (0.1.16 behavior); the loopback socket + Host checks and the documented local-process trust boundary still apply. Protocol equality is not required because the shell may use `dsh-app:`.
- Added `--plan` / `--dryrun` to the helper and `GET /api/dsh-power-menu/plan` to inspect the target without side effects.
- Orphan cleanup retries once after 300ms and logs any process that is still alive; it remains best effort, not a 100% guarantee.
- `enable.ps1` edits the raw profile JSON instead of `ConvertFrom-Json | ConvertTo-Json -Depth 30`, so deep arrays are not truncated; BOM and a backup are preserved.
- `install.ps1` writes the portable git to the user PATH only with `-WritePath`, verifies the release tarball with SHA-256 when a checksum is available, and defaults to 0.1.17.
- Helper logs rotate to `.1` once they exceed 1 MB, so long-lived installs do not accumulate an unbounded `helper-*.log`.

### Docs

- README documents the top-right header position, the new `-WritePath` / `-Sha256` flags, and the remaining limits: hard exit may skip Chromium profile flush, orphan cleanup is best effort, and a cooperative quit IPC remains upstream work.
- Known limits: the button still depends on DSH's `headerCorner` DOM, so a future upstream header rewrite can break it; there is no built-in updater; only Windows + DSH Desktop is supported.

## [0.1.16] - 2026-10-19

### Fixed

- Unicode / Chinese install-path hardening: the relaunch executable is normalized and validated before spawning, helper logs are written explicitly as UTF-8, and `--pathtest` now covers a UTF-8 JSON round-trip plus spawning an executable from a Chinese + space temp directory. Installer scripts already use UTF-8 BOM and `Get-Command dsh`, so a Chinese profile path is discovered normally.

## [0.1.15] - 2026-10-19

### Changed

- Shutdown/restart now snapshots the Electron main process tree before ending it, excludes the Host subtree, and after the Host exits ends leftover non-Host children (GPU, renderers, plugin background servers). Orphaned plugin processes are cleaned without `/T`, and the normal path does not gain a fixed delay because the snapshot runs during the existing browser-acknowledgement wait.

### Docs

- README now states that a hard main-process exit can skip Chromium's profile flush; use the tray's Quit for the cleanest shutdown. A cooperative quit IPC (Host asks the main process to call `app.quit()`) is an upstream DSH request.

## [0.1.14] - 2026-10-19

### Added

- `install.ps1 -Github`: keeps the `github:xichen-62/dsh-power-menu` spec working on a machine without git. It downloads a portable MinGit (~38 MB, one time) into `%LOCALAPPDATA%\dsh-power-menu\mingit`, prepends it for the current run, and appends it to the **user PATH** so the DSH plugin manager can resolve pasted GitHub repository URLs too. Verified with the system git hidden: `github:` install resolved and installed 0.1.13 through the portable git.
- Portable git is configured with `http.schannelCheckRevoke=false` so GitHub fetches are not aborted by `CRYPT_E_NO_REVOCATION_CHECK`.

## [0.1.13] - 2026-10-19

### Fixed

- Release-tarball download now falls back to the gh-proxy mirror automatically when the direct GitHub download fails, and disables the Windows certificate revocation check that can abort the transfer with `CRYPT_E_NO_REVOCATION_CHECK`.
- Tarball installs are verified to work end to end on a machine without git: `dsh plugin add <local .tgz>` and `dsh plugin add <tarball URL>` both unpack without ever invoking git.

## [0.1.12] - 2026-10-19

### Added

- `install.ps1` now detects a missing `git` and falls back to the `.tgz` attached to the GitHub Release. pnpm resolves a `github:` spec by spawning `git` (`ERR_PNPM_GIT_RESOLVE_FAILED` when it is absent), while a local tarball is unpacked without any git involvement.
- `install.ps1 -Tarball` forces the release-tarball path even when git is installed; `install.ps1 -TgzPath <file>` installs from a tarball copied to the machine, for fully offline setup.
- GitHub Release now ships `dsh-power-menu-<version>.tgz`, so a machine without git can install with a single `dsh plugin add file:...` (or the tarball URL) and no build step.

### Docs

- README: added a "no git" install path and an `ERR_PNPM_GIT_RESOLVE_FAILED` FAQ entry, including the mirrored tarball URL for slow GitHub access.

## [0.1.11] - 2026-10-19

### Added

- `install.ps1`: one-command install — cleans up a stale `link:` junction, installs from GitHub through the DSH CLI, registers `dsh-power-menu` in `dsh.profile.bundles`, and reminds you to restart DSH.
- `install.ps1 -Mirror`: install through the gh-proxy mirror when GitHub is slow or unreachable from the machine.

### Fixed

- `enable.ps1` and `install.ps1` are saved as UTF-8 with BOM, so their Chinese console messages render correctly under Windows PowerShell 5.1 instead of turning into mojibake.
- `enable.ps1` now warns when `node_modules\dsh-power-menu` is still a junction (the `link:` install shape) and prints the exact command to remove it before a plugin-manager upgrade — that junction is what makes pnpm fail with `ERR_PNPM_EPERM`, reported by the UI as "No write permission; the plugin cannot be installed".

### Docs

- README: the install section now marks the `enable.ps1` step as mandatory, adds a one-click install path, and documents the EPERM / permission error and slow-GitHub workaround.

## [0.1.10] - 2026-10-18

### Fixed

- The default export is now the full plugin object (`name`, `inject`, `apply`) instead of the bare `apply` function. The 0.1.7 default-export fix dropped the named `inject`, so Cordis unwrapped a function without `inject` and the host failed with `cannot get property "webServer" without inject`; the client menu still opened, but every action returned HTTP 404.

## [0.1.9] - 2026-10-18

### Changed

- Removed the 0.1.8 `postinstall` auto-enable. pnpm 11 blocks dependency lifecycle scripts by default (`ERR_PNPM_IGNORED_BUILDS`), so the hook did not run and could make the install exit non-zero.

### Added

- `enable.ps1`: one-click append of `dsh-power-menu` to `dsh.profile.bundles` for an already-installed plugin, with a profile backup before writing.

## [0.1.8] - 2026-10-18

### Added

- A `postinstall` hook that appends `dsh-power-menu` to `dsh.profile.bundles` when the package is installed inside a DSH profile. A fresh install now becomes usable after a restart without a separate "enable" step; link/workspace installs and non-DSH directories are left untouched. If pnpm runs with `--ignore-scripts`, the hook is skipped and the plugin still has to be enabled manually.

## [0.1.7] - 2026-10-18

### Fixed

- Added a default export for the host plugin (`export default apply`) while keeping the named exports. Some installers/loaders unwrap ESM through `default`, so a Git install could otherwise fail with `invalid plugin, expect function or object with an "apply" method, received object`.

## [0.1.6] - 2026-10-18

### Fixed

- Show the power button on the first frame of a new conversation without resizing the window. The mount now uses `useLayoutEffect` and forces a header reflow (layout read plus a next-frame `resize` event) after inserting the button.

## [0.1.5] - 2026-10-18

### Changed

- The power button now mounts at the end of `conversation.session.header.corner` in both welcome and conversation, giving the order **layout / sidebar / power**.
- Removed the `conversation.session.header.utilities` registration; the same mounted button serves both states, so there is no duplicate.

## [0.1.4] - 2026-10-18

### Fixed

- Reverted the welcome-screen fallback to a fixed-position overlay. Mounting a foreign node inside the React-managed header made the button jump whenever the header re-rendered.
- The fallback now sits to the left of the layout/sidebar pair (not between them). The positioning scan ignores the plugin's own menu items and trigger, so opening the menu no longer moves the button and the menu drops below it.

## [0.1.3] - 2026-10-18

### Changed

- The welcome-screen power button is now mounted inside the header icon row (`conversation.session.header.corner`) instead of being absolutely positioned. It participates in the same flex layout as the native icons, so it aligns and spaces naturally and the menu drops below it.
- The fallback stays fully transparent (no background or shadow).

## [0.1.2] - 2026-10-18

### Changed

- The welcome-screen fallback button is now fully transparent (no background or shadow), so custom DSH themes are not broken by a sudden colour block.
- The fallback button aligns with the first native header icon in `conversation.session.header.corner`: vertically centred, 12px to its left.

## [0.1.1] - 2026-10-18

### Fixed

- Keep the power button visible on the no-session welcome screen: a `shell.overlay` fallback renders at the top-right when the session-header button is absent, and hides as soon as the header button is present.
- Refresh the injected stylesheet when the client bundle reloads, so new CSS rules (such as the floating fallback) apply instead of being skipped by a stale `<style>` tag.

## [0.1.0] - 2026-10-18

### Added

- Power button in the DSH Desktop session header (`conversation.session.header.utilities`).
- Windows power-menu style popover with exactly two actions:
  - **关闭DSH** — quit the whole desktop app without relaunching.
  - **重启DSH** — quit and relaunch the app, waiting for the old port to free first.
- Detached helper (`lib/helper.cjs`) that ends only the Electron main process (`taskkill /F`, no `/T`) so the Host can run its own graceful shutdown and flush session logs.
- Clean-environment relaunch with retry and a failure message box.
- Loopback-only, same-origin-fenced HTTP routes:
  - `POST /api/dsh-power-menu/shutdown`
  - `POST /api/dsh-power-menu/restart`
  - `GET /api/dsh-power-menu/health`
- Keyboard and pointer interaction: `Esc`, `↑` / `↓` / `Home` / `End`, `Enter` / `Space`, outside click.
- Full-page progress overlay while the app is shutting down or restarting.
- Local diagnostics under `%USERPROFILE%\.dsh\dsh-power-menu\`.
- Static `npm run check` validation and GitHub Actions workflow.
