# Changelog

All notable changes to this project will be documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases use [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.3.2] - 2026-09-28

### Changed

- Removed the More menu and display New, Import, Export, and Delete directly in the toolbar.
- Replaced the persistent manual rerun action with two simpler concepts: the enable switch controls whether a script runs, while **Save and apply** writes and immediately applies enabled scripts.
- Explicit UI actions now apply immediately even when `autoReload` is disabled; that setting only governs external file changes.
- Runtime and compile failures show a contextual **Retry** button instead of a permanent rerun control.

### Added

- Added an idempotent `window.dshCustomJs.sync()` API and runtime-status events for UI synchronization without duplicate reloads.

## [0.3.1] - 2026-09-28

### Changed

- Reduced button, input, toggle, menu, and toolbar spacing so more script actions fit on each row.
- Fixed the code workspace at 350 pixels high; long files now scroll inside CodeMirror instead of expanding the Settings page.

### Fixed

- Windows folder opening now invokes the absolute `explorer.exe` under `SystemRoot`, waits for a successful process spawn, and reports a localized failure instead of claiming success.

## [0.3.0] - 2026-09-28

### Added

- CodeMirror editor with JavaScript / TypeScript syntax highlighting, line numbers, bracket matching, selection history, and DSH theme integration.
- Literal, case-insensitive find and replace with previous/next navigation, match position, replace-current, and replace-all actions.
- Script-directory path copy and safe folder opening.
- Complete Chinese and English strings for every new editor and management control.

### Changed

- Reorganized script controls around the current script, with secondary export, rerun, and delete actions in a More menu.
- Save now explicitly shows whether an enabled script will reload, and unsaved changes block ambiguous switch, toggle, and rerun actions.
- Deletion uses danger styling, a second confirmation click, and a five-second confirmation timeout.

### Security

- Newly imported scripts are persisted disabled before their first manifest update, allowing review before execution.
- Replaced operating-system default handling of individual script files with opening the fixed script directory only.

## [0.2.0] - 2026-09-27

### Added

- JavaScript, MJS, and TypeScript userscript loading for the DeepSeek Harness Web GUI.
- Built-in script manager with creation, editing, import/export, deletion, search, and code outline navigation.
- Automatic reload, per-script enable/disable controls, runtime status, and lifecycle cleanup.
- TypeScript ES2022 Module transpilation and compile diagnostics.
- Revision protection for concurrent external edits.
- Chinese and English UI using the native DSH locale service.
- `window.dshCustomJs` browser API.
- Plugin-shop compatibility metadata, ordered screenshots, update/uninstall guidance, recovery instructions, and explicit verification status.
- Ubuntu and Windows CI validation plus HTTP route integration tests.

### Security

- Path validation, symbolic-link rejection, request-size limits, revision preconditions, and DSH Connection request fencing for management routes.
- Stable public management error codes keep local paths and unexpected internal exceptions out of browser responses.

[Unreleased]: https://github.com/jeffreyren1/dsh-custom-js/compare/v0.3.2...HEAD
[0.3.2]: https://github.com/jeffreyren1/dsh-custom-js/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/jeffreyren1/dsh-custom-js/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/jeffreyren1/dsh-custom-js/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/jeffreyren1/dsh-custom-js/releases/tag/v0.2.0
