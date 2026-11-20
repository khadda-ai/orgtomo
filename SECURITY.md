# Security policy

## Supported versions

Security fixes are made on the latest released version.

## Reporting a vulnerability

Please report privately through GitHub: on this repository open **Security**, then **Report a vulnerability**. Do not open a public issue for a security problem.

Include what you can of: the version, what you ran, what you expected the guards to do, and what happened. A minimal command or hook input that reproduces it is the most useful thing.

You can expect an acknowledgement within a few working days, an assessment after that, and credit in the release notes if you want it.

## What counts

- A way for an agent to write to an org with the production role, or to any org that is not the build org's metadata target.
- A way for an agent to perform a human action (approve, reject, deployed, answer, configuration change) or to alter engine state, evidence or backups.
- A way to get an e-mail address or phone number outside the allow list into an org through a guarded path, or to read unmasked data where masking is on.
- A way to reach a token or to open a production page in the agent browser.
- A problem in the local control panel (token handling, request validation).

## What does not

The limits described in [docs/SAFETY.md](docs/SAFETY.md#limits) are known and documented: guards inspect requests and are not an operating-system sandbox. Reports that tighten those limits in practice are still welcome as ordinary issues or pull requests.

## Good practice for users

Log in to production with a read-only user, run Orgtomo in a dedicated folder, and keep the default e-mail mode. See [docs/SAFETY.md](docs/SAFETY.md).
