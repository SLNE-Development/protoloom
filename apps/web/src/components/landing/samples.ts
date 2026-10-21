/** Sample artifact shown on the landing page: dev.surf.economy:economy-contracts:1.4.0. */

export const SAMPLE_COORDINATE = "dev.surf.economy:economy-contracts:1.4.0";

export const PROTO_FILES = [
  {
    path: "surf/economy/v1/money.proto",
    code: `syntax = "proto3";
package surf.economy.v1;

// An amount in the smallest unit of a currency.
message Money {
  string currency_code = 1;
  int64 amount_minor = 2;
}
`,
  },
  {
    path: "surf/economy/v1/events.proto",
    code: `syntax = "proto3";
package surf.economy.v1;

import "google/protobuf/timestamp.proto";
import "surf/economy/v1/money.proto";

// Published whenever a balance changes.
message BalanceChanged {
  string account_id = 1;
  Money balance_after = 2;
  Money delta = 3;
  google.protobuf.Timestamp occurred_at = 4;
}
`,
  },
  {
    path: "surf/economy/v1/service.proto",
    code: `syntax = "proto3";
package surf.economy.v1;

import "surf/economy/v1/events.proto";
import "surf/economy/v1/money.proto";

service EconomyService {
  rpc GetBalance(GetBalanceRequest) returns (Money);
  rpc Transfer(TransferRequest) returns (BalanceChanged);
}

message GetBalanceRequest { string account_id = 1; }
message TransferRequest { string to = 1; Money amount = 2; }
`,
  },
] as const;

export const HERO_BUILD_GRADLE = `plugins {
    id("dev.protoloom") version "0.1.0"
}

protoloom {
    repositories("releases", "snapshots")
}

dependencies {
    protoloom("${SAMPLE_COORDINATE}")
}
`;

export const HERO_SETTINGS_GRADLE = `pluginManagement {
    repositories {
        maven("https://reposilite.slne.dev/releases/")
        gradlePluginPortal()
    }
}

rootProject.name = "protection-service"
`;

export const CLIENT_GRADLE = `plugins {
    id("dev.protoloom") version "0.1.0"
}

// url and token default to PROTOLOOM_URL and PROTOLOOM_TOKEN
protoloom {
    repositories("releases", "snapshots")
    publishing {
        repository = "releases"
        snapshotRepository = "snapshots"
        group = "dev.surf.protection"
        name = "protection-contracts"
        // version defaults to project.version
    }
}

dependencies {
    protoloom("${SAMPLE_COORDINATE}")
    protoloom(project(":shared-contracts"))
}
`;

/** protoloom.json of the Node CLI, pointing at this instance. */
export function cliConfig(origin: string): string {
  return `{
  "url": "${origin}",
  "repositories": ["releases"],
  "dependencies": [
    "${SAMPLE_COORDINATE}"
  ],
  "outDir": "./protos"
}
`;
}

export const CLI_PACKAGE_JSON = `{
  "scripts": {
    "protos": "protoloom fetch",
    "postinstall": "protoloom fetch"
  }
}
`;

/** Compose excerpt for the self-hosting section, with this instance's public URL. */
export function composeSnippet(origin: string): string {
  return `services:
  protoloom:
    image: ghcr.io/slne-development/protoloom:latest
    command: ["web"]
    environment:
      BETTER_AUTH_URL: ${origin}
      INITIAL_ADMIN: github:your-login
      STORAGE_DRIVER: s3
  worker:
    image: ghcr.io/slne-development/protoloom:latest
    command: ["worker"]
`;
}
