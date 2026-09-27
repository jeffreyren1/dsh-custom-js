# Contributing to dsh-custom-js

Thanks for helping improve `dsh-custom-js`.

## Before opening an issue

- Search existing issues first.
- For bugs, include your operating system, Node.js version, DSH version, plugin version, reproduction steps, expected behavior, and relevant logs.
- Remove secrets and private data from logs and screenshots.
- For security vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Development setup

Requirements:

- Node.js `^22.19.0` or `>=24.0.0`
- pnpm 10
- DeepSeek Harness `0.1.7-rc.2` for integration testing

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
npm pack --dry-run
```

## Pull requests

1. Keep each pull request focused on one change.
2. Add or update tests for behavior changes.
3. Update both `README.md` and `README.zh.md` when user-facing behavior changes.
4. Run type checking, tests, build, and package inspection before submitting.
5. Explain the motivation, implementation, testing performed, and any compatibility impact.

By contributing, you agree that your contribution is licensed under the repository's MIT License.
