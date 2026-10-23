# Security Policy

OSFPM manages some of the most sensitive data on a production: crew and cast contact details, emergency contacts, medical and dietary needs, contracts and money. We take security reports seriously and are grateful to anyone who helps keep that data safe.

---

## Reporting a vulnerability

**Please do not report security issues in public GitHub issues, discussions or pull requests.**

Report privately through one of these:

1. **GitHub private reporting (preferred):** go to the repository's **Security** tab → **Report a vulnerability**.
2. **Email:** peter.berberih@gmail.com, with the subject line `SECURITY - <short description>`.

Please include:

- What the issue is and what an attacker could do with it
- Steps to reproduce, or a proof of concept
- The OSFPM version or commit, and how it was deployed (Docker, npm, other)
- Any logs, screenshots or requests that help

**Never include real personal data** of crew, cast or anyone else in a report. Use the demo production (`node seed.js`) or invented data.

---

## What happens next

OSFPM is maintained by a small team, so these are honest targets rather than guarantees:

| Step | Target |
|---|---|
| We acknowledge your report | Within 7 days |
| We confirm the issue and its severity | Within 14 days |
| We release a fix for critical and high-severity issues | As fast as possible, aiming for 30 days |
| We release a fix for other issues | Within 90 days |

We will keep you updated, agree a disclosure date with you, and publish a GitHub Security Advisory when the fix is out. If you would like, we will credit you by name in the advisory and the changelog.

There is no paid bug bounty. OSFPM is free, community software.

---

## Supported versions

OSFPM is pre-1.0. Only the **latest release** and the `main` branch receive security fixes.

| Version | Supported |
|---|---|
| Latest release | ✅ |
| `main` branch | ✅ |
| Anything older | ❌ Please upgrade |

Once 1.0 ships, this table will list which release lines are supported and for how long.

---

## Scope

**In scope**

- Code in this repository: server, client, Docker setup and default configuration
- Access-control problems, such as a user seeing another project's data or crew personal data they should not see
- Authentication and session issues
- Injection (SQL, script, command, template) and file-upload issues
- Public links (onboarding, availability, call sheet confirmation) that leak data or can be guessed
- Email in and email out: spoofed senders being accepted, data leaking through email, unsafe handling of attachments
- Insecure defaults that a normal installation would ship with

**Out of scope**

- Vulnerabilities in third-party dependencies with no OSFPM-specific impact. Please report those upstream; tell us too if OSFPM needs to update.
- A self-hosted install that its operator configured insecurely (see below), unless our documentation told them to do it
- Denial of service by flooding traffic, spam, or physical attacks
- Social engineering of maintainers, contributors or users
- Missing best-practice headers or settings with no demonstrated impact

---

## Safe harbour

If you act in good faith, we will not pursue or support legal action against you. Good faith means you:

- Only test against your own installation, or one you have permission to test
- Do not access, change, keep or share other people's data beyond the minimum needed to show the issue
- Do not disrupt real productions or degrade a service for others
- Give us reasonable time to fix the issue before disclosing it publicly

If you are unsure whether something is allowed, ask us first.

---

## For people running OSFPM

OSFPM is self-hosted, so the operator is responsible for the server it runs on. At minimum:

- **Use HTTPS.** Never expose OSFPM over plain HTTP on the internet.
- **Set a strong, unique `JWT_SECRET`.** Never use an example or default value.
- **Keep OSFPM updated.** Watch this repository's releases and security advisories.
- **Back up the database**, keep backups encrypted, and test restoring them.
- **Limit admin accounts** to the people who need them.
- **Remove people's data when a production no longer needs it.** Crew personal data is protected by data protection law (for example GDPR in the EU and UK).
- **Use an email address that belongs only to OSFPM** for email features, never someone's personal mailbox.

---

## Security fixes and the licence

OSFPM is licensed under AGPL-3.0. Security fixes are published openly in this repository, so every installation, including modified ones, can apply them.
