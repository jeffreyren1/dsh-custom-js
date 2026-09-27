# Changelog

All notable changes to this project will be documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases use [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/jeffreyren1/dsh-custom-js/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/jeffreyren1/dsh-custom-js/releases/tag/v0.2.0
