---
title: Server settings and audit log
description: Decide whether visitors can browse public repositories without signing in, and find out who published, deleted or changed what.
section: Administration
order: 5
---

Admins find both pages in the sidebar: **Settings** and **Audit log**.

## Allow anonymous view

Off by default. When it's off, visitors who aren't signed in can still open the landing page, these docs and the sign-in page, but they can't browse any repository in the web app.

When it's on, visitors can browse **public** repositories in the web app without signing in: the artifact browser, version pages and the proto viewer, all read-only. They never see private repositories, API keys, users, settings or the audit log.

| | Anonymous view off | Anonymous view on |
| --- | --- | --- |
| Web app, public repositories | sign in required | readable by anyone |
| Web app, private repositories | sign in required | sign in required |
| REST API and clients, public repositories | readable by anyone | readable by anyone |
| REST API and clients, private repositories | key required | key required |
| These docs | public | public |

The setting only affects the web app. Gradle and the CLI can always fetch public repositories without a key, so public contracts work in any CI even while the web app is closed to visitors.

## Audit log

The audit log records changes with who made them, when, and what they touched:

- publishes and redeploys, with the build number and checksum,
- manual deletes of versions,
- deletions by cleanup policies (`cleanup.delete`, by the system, with the rule's reason),
- API keys created and revoked,
- invites created and revoked, and role, ban and removal changes of users,
- accounts created through an invite or `INITIAL_ADMIN` (`user.create`, with the role and how the account was created), and sign-in providers connected or disconnected on the Account page (`account.link`, `account.unlink`),
- repository and setting changes.

The actor is a user, an API key, or `system` for scheduled cleanup. Filter by action to find, for example, every deletion of the last week.

Entries marked **forced** were deleted or redeployed by an admin past existing dependents. Their details list the dependents at that time, so you can tell the affected teams.
