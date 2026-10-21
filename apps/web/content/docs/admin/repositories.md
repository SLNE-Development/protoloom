---
title: Repositories
description: Create public and private repositories, and set redeploy, accepted version kinds and resolution priority.
section: Administration
order: 1
---

A repository is a named container for artifacts with its own access and publishing rules. Only admins create and change repositories. Everyone signed in can browse all of them.

## Plan your repositories

Two common setups:

| Setup | Repositories |
| --- | --- |
| By stability | `releases` (releases only, no redeploy) and `snapshots` (snapshots only, with a cleanup policy) |
| By audience | `public` (public, contracts other organisations may fetch) and `internal` (private) |

You can combine them, for example `releases`, `snapshots` and `public`. Clients list the repositories they search, in order, so adding one later doesn't break anyone.

## Create a repository

1. Open **Repositories** in the sidebar and choose **Create repository** (or press `Ctrl K` and type "create repository").
2. Enter a **name**. It becomes part of every URL and client config, so keep it short: lowercase letters, digits and `-`, starting with a letter or digit, at most 63 characters.
3. Optionally add a **description**.
4. Choose the settings below and save.

The name can't be changed later. Clients refer to it in `protoloom { repositories(...) }` and `protoloom.json`.

## Settings

Open a repository and choose **Settings** to change these at any time.

### Visibility

| Visibility | Who can read |
| --- | --- |
| **Private** (default) | Signed-in users, and API keys with a permission entry for this repository |
| **Public** | Everyone, including requests without a key |

Public repositories can be fetched anonymously from any build or CI, whatever the "Allow anonymous view" setting says. That setting only controls whether the web app shows public repositories to visitors who aren't signed in. See [Server settings and audit log](/docs/admin/settings).

Writing always needs a key with `write` access, also for public repositories.

### Allow redeploy

Off by default. When off, a release version can be published once and never replaced (`409 immutable`). When on, publishing an existing release replaces it, unless other versions depend on it. See [Versions and snapshots](/docs/versions#redeploy).

Turn it on only for repositories where builds don't need to be reproducible, such as a playground. Snapshots can always be published again, whatever this setting says.

### Accept releases and accept snapshots

Both are on by default. Turn one off to split versions across repositories, for example a `snapshots` repository that accepts only snapshots. A publish of the wrong kind fails with `400 invalid_request` and `Repository <name> does not accept snapshots` (or releases).

### Resolution priority

A number, `100` by default. When someone publishes, their declared dependencies are looked up in the target repository first, then in every other repository by ascending priority (lower wins), then by name.

Give your main release repository a lower number than repositories that might contain the same coordinate, so publishes always resolve against it. This only affects publishing; clients that fetch use the order in their own config. See [Dependencies and resolution](/docs/resolution#resolution-when-publishing).

### Cleanup policies

Rules that delete old snapshot builds and unused versions on a schedule. See [Cleanup policies](/docs/admin/cleanup).

## Give people access

Signed-in users already read every repository. To let a build publish, a maintainer or admin creates an API key with a `write` entry for the repository, optionally limited to a group prefix. See [API keys and permissions](/docs/admin/keys).

## Delete a repository

A repository can be deleted only when it has no artifacts left. Delete its versions first, or let cleanup policies remove them.
