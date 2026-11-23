# Accessibility

OSFPM is built for everyone who works on a production, including disabled, Deaf, neurodivergent and chronically ill cast and crew. This file explains what we aim for, where the project stands today, how we protect people's access information, and how to report a problem.

## Where the project stands

OSFPM is in early development. Today it is a backend and an API. There is no web app yet, and OSFPM does not yet generate call sheets, PDFs, emails or calendar files.

| Area                                                  | Status                                                                                                                                       |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| API                                                   | Available. Errors are returned as RFC 9457 problem details with plain-language titles, and the API is described in an OpenAPI document.      |
| Sign-in                                               | Passkeys, or a password with optional TOTP. Passkeys avoid memory tests at sign-in, which is what WCAG 2.2 success criterion 3.3.8 asks for. |
| Web app and phone views                               | Not built yet.                                                                                                                               |
| Generated documents (PDF, email, calendar files, SMS) | Not built yet.                                                                                                                               |
| Conformance                                           | Not assessed yet, because there is no interface to assess.                                                                                   |

## What we aim for

These are targets, not claims. Each will be checked when the feature it applies to is built.

- **Web app and phone views:** [WCAG 2.2](https://www.w3.org/TR/WCAG22/) level AA. Automated checks run in CI, plus manual screen-reader checks before each release.
- **PDFs** (call sheets, schedules, reports): tagged PDFs that pass [PDF/UA-1](https://pdfa.org/resource/pdfua-in-a-nutshell/) validation with [veraPDF](https://verapdf.org/) in CI, plus an HTML version of every PDF.
- **Email:** a real plain-text version of every message, and subject lines that say what changed.
- **Calendar files:** event titles and descriptions that make sense when read aloud, and updates that replace the event instead of duplicating it.
- **Changes:** every reissued call sheet, schedule or script says what changed, in words. Colour is never the only way meaning is shown; revision colours always have a text label.
- **Choice of format:** each person chooses how they receive information (for example plain text, easy-read, large print, SMS, a daily digest or quiet hours) without having to explain why.
- **API:** names alongside codes and text labels for revision colours, so anyone can build their own accessible tools on top of OSFPM.

We will publish a conformance report for each release once the web app exists.

## How OSFPM treats access needs

Many people never tell a production about a disability or condition, often for fear of not being hired again. OSFPM is designed so that:

- **Nobody has to disclose anything to get an accessible format.** Format and notification choices are ordinary settings, not health data.
- **Access needs belong to the person.** They are recorded as practical adjustments (for example "no call before 08:00" or "step-free access"), not as diagnoses.
- **The person decides who sees each adjustment,** role by role and production by production. Access ends when the production wraps, and the person keeps their own copy.
- **Diagnoses and medication stay private** unless the person chooses to share them.
- **Schedules and call sheets show the constraint, never the reason,** and never name a person unless that person agrees.
- **Every read of access or medical information is logged.** This information is never written to application logs and never emailed.

This follows the approach of the UK TV Access Project's Access Passport and the Channel 4 Access Rider.

## Reporting an accessibility problem

- **Public issues:** open a GitHub issue and add the `accessibility` label. Describe what you were trying to do, what happened, and which assistive technology, browser or device you used, if any.
- **Private reports:** if you'd rather not report in public, email the contact address listed in [SECURITY.md](SECURITY.md) and start the subject with "Accessibility".

Please don't include personal health information in a public issue. We will never ask you to tell us about a condition in order to fix a barrier.

Security problems go through [SECURITY.md](SECURITY.md), not this process.

## For contributors

- Check new or changed screens with a keyboard and a screen reader, at 200% zoom and at a width of 320 px.
- Don't use colour, position or sound as the only way to convey meaning.
- Don't add drag-only interactions; always provide a button alternative.
- Write interface and notification text in plain language, and spell out abbreviations (for example "DOOD: Day Out of Days").
- Never log, export or email access or medical information.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the general workflow.
