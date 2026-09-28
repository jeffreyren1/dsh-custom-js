# Security Policy

## Supported versions

Security fixes are provided for the latest published version of `dsh-custom-js`.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub's **Security → Report a vulnerability** flow to submit a private security advisory:

<https://github.com/jeffreyren1/dsh-custom-js/security/advisories/new>

Include the affected version, impact, reproduction steps or proof of concept, and any suggested mitigation. Remove unrelated secrets and private data. You should receive an initial response within seven days.

## Userscript trust model

`dsh-custom-js` intentionally executes trusted userscripts with the browser-side permissions of the current DeepSeek Harness page. It is not a sandbox. A script can access the DOM, browser storage, page-visible data, and browser networking APIs. Only install or import code you wrote yourself or fully trust.
