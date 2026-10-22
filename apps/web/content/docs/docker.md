---
title: Docker and OCI
description: Log in, push and pull images with docker and podman, mirror Docker Hub, use groups, push Helm charts and cosign signatures, and clean up storage.
section: Clients
order: 6
---

Weaver is an OCI registry at `{{host}}`. Stock `docker`, `podman`, `buildx`, containerd, `helm`, `oras` and `cosign` work with it without any flag or patched config. Every image name starts with the name of a docker repository: `{{host}}/<repo>/<image>:<tag>`.

## Log in

Create an access token (see [API keys and permissions](/docs/admin/keys)) and log in with any username and the token as the password:

```sh
docker login {{host}}
# Username: token
# Password: <your access token>
```

In CI, pipe the token in so it never shows up in the process list:

```sh
echo "$WEAVER_TOKEN" | docker login {{host}} --username token --password-stdin
```

`podman login`, `helm registry login` and `oras login` take the same credentials. Public repositories can be pulled without logging in. Pushing and deleting always need a token with write access.

Docker trades your token for a short-lived registry token that is valid for 5 minutes. When you revoke an access token, clients that already hold a registry token keep working until it expires, so a revoked token stops working within 5 minutes, not instantly.

## Push and pull

Tag the image with the repository as the first path segment, then push it:

```sh
docker tag web:1.0 {{host}}/apps/web:1.0
docker push {{host}}/apps/web:1.0
docker pull {{host}}/apps/web:1.0
```

Here `apps` is the repository and `web` the image. Images can have more segments, such as `{{host}}/apps/team/web`. Pulling by digest works too: `docker pull {{host}}/apps/web@sha256:<hex>`.

Multi-platform images built with `docker buildx build --platform linux/amd64,linux/arm64 --push -t {{host}}/apps/web:1.0 .` are stored as an index with one manifest per platform. The browse page lists the platforms of each tag.

An image index is accepted only when every platform manifest it lists is already in the same image. Clients push the platform manifests first, so this never shows up in practice; a tool that tries to push only the index gets `MANIFEST_UNKNOWN` and its push is refused.

Blobs that already exist in another hosted repository you can read are mounted instead of uploaded again (docker prints `Mounted from`). Manifests can be up to 4 MiB. On a hosted repository with **Immutable tags** turned on, moving an existing tag to another image is refused with `denied: tag <tag> is immutable`; pushing the same image again is fine.

## Mirrors and Docker Hub

A docker mirror proxies an upstream registry. Pull through it with the mirror's name as the first segment:

```sh
docker pull {{host}}/hub/nginx:latest
```

With **Docker Hub** turned on in the mirror settings, single-segment names map to Docker Hub's official images: `hub/nginx` is fetched as `library/nginx`. Point the upstream at `https://registry-1.docker.io`.

Anonymous pulls from Docker Hub are rate-limited. To pull with your Docker Hub account instead, give the upstream **Basic** credentials: your Docker Hub username, and a Docker Hub access token (Account settings → Personal access tokens, read-only is enough) as the password. Weaver uses them to get its own Docker Hub tokens; your clients still log in to Weaver with their Weaver token.

Mirrors are read-only: pushing to one fails with `UNSUPPORTED`. Caching is off by default, so every pull goes to the upstream. Turn caching on in the repository settings to keep the layers Weaver fetched.

## Root mirror and `registry-mirrors`

One docker mirror can be the **root mirror** (repository settings → Docker → Root mirror). It serves image names that don't start with a repository name, so `docker pull {{host}}/nginx` works, and the Docker daemon can use Weaver as a pull-through mirror for Docker Hub. Add it to `/etc/docker/daemon.json` and restart the daemon:

```json title="/etc/docker/daemon.json"
{
  "registry-mirrors": ["{{url}}"]
}
```

Then a plain `docker pull nginx` goes through Weaver and falls back to Docker Hub when Weaver can't answer. The daemon sends no credentials to registry mirrors, so the root mirror has to be public. Turn on **Docker Hub** for it as well, so `nginx` maps to `library/nginx`. The name `library` is reserved and can't be used for a repository.

For containerd, add a `hosts.toml` for `docker.io` with `[host."{{url}}"]` and `capabilities = ["pull", "resolve"]`.

## Groups

A docker group is a read-only view over hosted and mirror docker repositories. Pull through the group's name, and Weaver tries the members in order: the first member that has the manifest, blob or tag list answers. Tags are not merged across members. Reading a group grants reading everything served through it, even from private members.

```sh
docker pull {{host}}/all/web:1.0
```

Pushing to a group fails; push to a hosted member.

## Helm charts

Helm 3.8 and newer push charts to OCI registries. The repository is the path after `oci://`:

```sh
helm registry login {{host}} --username token --password "$WEAVER_TOKEN"
helm push mychart-0.1.0.tgz oci://{{host}}/charts
helm pull oci://{{host}}/charts/mychart --version 0.1.0
helm install demo oci://{{host}}/charts/mychart --version 0.1.0
```

The browse page labels these images as Helm charts.

## Signatures, SBOMs and referrers

Weaver supports the OCI referrers API, so `cosign` and `oras` attach signatures, SBOMs and attestations to an image:

```sh
cosign sign {{host}}/apps/web@sha256:<hex>
cosign verify --key cosign.pub {{host}}/apps/web:1.0
oras attach --artifact-type application/spdx+json {{host}}/apps/web:1.0 sbom.spdx.json
oras discover {{host}}/apps/web:1.0
```

Attached artifacts show up on the manifest's browse page with their type: cosign signature, SBOM (`application/spdx+json`, `application/vnd.cyclonedx+json`), Helm chart, or the raw artifact type.

## Deleting and garbage collection

Deleting needs a token with write access. Delete a tag, or a manifest with all its tags, with `crane delete`, `regctl` or the registry API:

```sh
crane delete {{host}}/apps/web:old            # removes the tag only
crane delete {{host}}/apps/web@sha256:<hex>   # removes the manifest and its tags
```

Deleting frees no storage at once. The worker's `docker:gc` job runs daily at 03:30 and deletes layers that no manifest references any more, once they have been unreferenced for 24 hours. Uploads idle for 24 hours are dropped. Layers pushed in the last 24 hours are always kept, so a push in progress never loses its layers.

## Upload directory

Uploads are written to a temporary file on the web container before they are stored. The directory is `WEAVER_DOCKER_UPLOAD_DIR`, by default `weaver-uploads` in the system temp directory. Give it a volume with room for the largest layers you push; see [Docker Compose](/docs/self-host/compose#docker-registry-uploads). Files of abandoned uploads are removed automatically.

## Troubleshooting

- **`unauthorized: authentication required`**: log in with `docker login {{host}}`, or the repository is private and your token can't read it.
- **`denied: requested access to the resource is denied`**: your token is valid but lacks write access to the repository.
- **`UNSUPPORTED: <repo> is a mirror repository and read-only`**: push to a hosted repository instead.
- **`name unknown`**: the first segment is not a docker repository, and there is no root mirror to serve the name.
- **`413 Request Entity Too Large`** from your proxy: raise its body size limit (see [Docker Compose](/docs/self-host/compose#docker-registry-uploads)).
