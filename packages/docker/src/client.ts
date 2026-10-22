/**
 * Browser-safe helpers of the docker format: client snippets and artifact type labels. Nothing here imports
 * Node or database modules, so the web app's client components can use it.
 */
import type { Repo } from "@weaver/core";

/** Config media types of runnable images; a manifest with one of them is an image, not an attached artifact. */
export const IMAGE_CONFIG_TYPES: readonly string[] = [
  "application/vnd.docker.container.image.v1+json",
  "application/vnd.oci.image.config.v1+json",
];

/** Whether a stored artifact type (artifactType or config media type) means a plain container image. */
export function isImageArtifactType(type: string | null | undefined): boolean {
  return !type || IMAGE_CONFIG_TYPES.includes(type);
}

const LABELS: Record<string, string> = {
  "application/vnd.cncf.helm.config.v1+json": "Helm chart",
  "application/vnd.dev.cosign.artifact.sig.v1+json": "cosign signature",
  "application/vnd.dev.cosign.simplesigning.v1+json": "cosign signature",
  "application/vnd.dev.sigstore.bundle.v0.3+json": "Sigstore bundle",
  "application/spdx+json": "SBOM",
  "application/vnd.cyclonedx+json": "SBOM",
  "application/vnd.in-toto+json": "attestation",
};

/** A readable label for an artifact type: "image" for container images, a known name, else the raw type. */
export function artifactTypeLabel(type: string | null | undefined): string {
  if (isImageArtifactType(type)) return "image";
  return LABELS[type!] ?? type!;
}

/** Copy-paste commands for one docker repository. */
export interface DockerSnippets {
  /** `docker login <host>`. */
  login: string;
  /** `docker pull <host>/<repo>/<image>:<tag>` (or `@<digest>`). */
  pull: string;
  /** `docker tag` plus `docker push`; null for mirrors and groups, which are read-only. */
  push: string | null;
  /** The Docker daemon `daemon.json` that uses Weaver as a registry mirror; only for the docker root mirror. */
  daemonJson: string | null;
}

/**
 * Copy-paste snippets for a repo: login, pull, push (hosted only), daemon.json registry-mirrors (root mirror only).
 * `image` and `tag` default to placeholders and `latest`; a digest `tag` is written as `@<digest>`.
 */
export function dockerSnippets(
  publicUrl: string,
  repo: Pick<Repo, "name" | "kind" | "dockerRoot">,
  image?: string,
  tag?: string,
): DockerSnippets {
  const base = publicUrl.replace(/\/+$/, "");
  let host = base;
  try {
    host = new URL(base).host;
  } catch {
    // Not a URL: use it as the host.
  }
  const name = image ?? "<image>";
  const byDigest = tag !== undefined && tag.includes(":");
  const tagRef = tag && !byDigest ? `:${tag}` : image ? ":latest" : ":<tag>";
  const pullRef = byDigest ? `@${tag}` : tagRef;
  const pushTarget = `${host}/${repo.name}/${name}${tagRef}`;
  return {
    login: `docker login ${host}`,
    pull: `docker pull ${host}/${repo.name}/${name}${pullRef}`,
    push: repo.kind === "hosted" ? `docker tag ${name}${tagRef} ${pushTarget}\ndocker push ${pushTarget}` : null,
    daemonJson: repo.kind === "mirror" && repo.dockerRoot ? JSON.stringify({ "registry-mirrors": [base] }) : null,
  };
}
