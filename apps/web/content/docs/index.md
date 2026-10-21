---
title: What is Protoloom
description: Protoloom stores versioned bundles of .proto files, resolves their dependencies and serves them to Gradle and Node builds.
section: Getting started
order: 1
---

Protoloom is a registry for `.proto` files. A team publishes its protos from Gradle as a versioned artifact. Other projects declare that artifact as a dependency and fetch it, together with everything it imports, into one folder. Code generation happens in your own build, not in Protoloom.

This instance runs at `{{url}}`.

## Artifacts and coordinates

An **artifact** is a bundle of `.proto` files with a Maven-style coordinate:

```text
dev.surf.economy:economy-contracts:1.4.0
group            name              version
```

- **group** is a reverse-DNS name such as `dev.surf.economy`. Lowercase letters, digits, `_` and `-`, separated by dots.
- **name** identifies the artifact inside the group, such as `economy-contracts`.
- **version** is a version number like `1.4.0`, optionally with a qualifier: `1.4.0-rc.1` or `1.4.0-SNAPSHOT`.

Each version stores its files under their import paths, for example `surf/economy/v1/money.proto`. Another artifact that depends on it can write `import "surf/economy/v1/money.proto";` and it just works.

A version also records its declared dependencies (exact coordinates), a SHA-256 checksum, who published it, when, and how often it was downloaded.

## Repositories

Artifacts live in named **repositories**, such as `releases` and `snapshots`, or `public` and `internal`. Each repository has its own settings:

- **Visibility.** A public repository can be read by anyone, without a key. A private one needs an API key with read access, or a signed-in user.
- **Redeploy.** Whether an existing release version may be replaced. Off by default.
- **Accepted versions.** Releases, snapshots, or both.
- **Resolution priority.** The order in which repositories are searched for dependencies when you publish.
- **Cleanup policies.** Rules that delete old snapshot builds and unused versions.

See [Repositories](/docs/admin/repositories).

## Why versions like Maven

Proto files are contracts between services. When a contract changes, every consumer should choose when to pick up the change. Versioned artifacts give you that:

- A release such as `1.4.0` never changes once published (unless the repository allows redeploy), so a build that worked yesterday works today.
- A `-SNAPSHOT` version can be published again and again while you iterate. Consumers get the newest build.
- Dependencies are exact. There are no version ranges, so you always know which files you compile against.

See [Versions and snapshots](/docs/versions).

## How it fits together

1. **Publish.** The Gradle plugin packs `src/main/proto` and uploads it with its dependencies. Protoloom compiles the files together with those dependencies and rejects the upload if anything is wrong. See [Validation on publish](/docs/validation).
2. **Resolve.** A client sends the coordinates it needs and an ordered list of repositories. The server works out the full dependency tree, picks one version of each artifact and returns download links. See [Dependencies and resolution](/docs/resolution).
3. **Fetch.** The Gradle plugin or the `protoloom` CLI downloads each archive, checks its checksum and writes all files into one folder that keeps the import paths intact. Your code generator reads that folder.

## Who can do what

Protoloom has three roles for people: `admin`, `maintainer` and `viewer`. Signed-in users can browse every repository in the web app. Builds use **API keys**, which carry read or write access per repository and, optionally, per group prefix. See [Users, roles and invites](/docs/admin/users) and [API keys and permissions](/docs/admin/keys).

## Where to go next

- New to this instance? Start with [Join an instance](/docs/join).
- Ready to ship protos? Read [Publish your first artifact](/docs/publish).
- Need protos from another team? Read [Use protos in a project](/docs/consume).
- Running your own instance? Read [Docker Compose](/docs/self-host/compose).
