# Contributing to OSFPM

Thank you for helping. OSFPM is a self-hosted, API-first film production management system. This guide covers what you need to send a contribution.

## How to contribute

1. For anything bigger than a small fix (a typo, a broken link, a one-line bug), open an issue first and describe what you want to change. This saves you from building something we cannot accept.
2. Fork the repository.
3. Create a branch in your fork, for example `feat/short-description` or `fix/short-description`.
4. Make one focused change, and add or update tests.
5. Open a pull request to `main` and fill in the template.

Small pull requests are reviewed faster than large ones. One pull request should do one thing.

## Contributor Licence Agreement (CLA)

Every contributor signs the CLA once. When you open your first pull request, the CLA check will ask you to sign. To sign, comment this exact phrase on the pull request:

```text
I have read the CLA Document and I hereby sign the CLA
```

If you are contributing on behalf of a company, see [CLA.md](CLA.md) for the company agreement.

If the check does not turn green after you sign, comment `recheck`.

## Commit style

Use [Conventional Commits](https://www.conventionalcommits.org/), for example:

```text
feat: add call sheet export
fix: stop sensitive fields appearing in logs
docs: correct the setup steps
```

Keep one focused change per commit.

## Setup and test

Use the Node.js version in `.nvmrc` and the pnpm version in the `packageManager` field of the root `package.json`.

- Install: `pnpm install`
- Test: `pnpm test`
- Lint: `pnpm lint`
- Format: `pnpm format` (check only: `pnpm format:check`)
- Typecheck: `pnpm typecheck`

Run the full test suite before every commit. It must stay green.

## Personal data

OSFPM handles crew and cast personal data. Never put real people's data in issues, pull requests, tests, fixtures, logs or screenshots. This includes medical, dietary, accessibility, emergency, ID, bank and agent details.

Use the fictional demo production _The Last Withdrawal_, or invented data.

## Licence

OSFPM is licensed under AGPL-3.0-only. By contributing, you agree that your contribution is licensed under AGPL-3.0-only, in addition to the terms of the CLA.

## Security issues

Never report a security issue in a public issue, discussion or pull request. Follow [SECURITY.md](SECURITY.md) instead.

## Conduct

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
