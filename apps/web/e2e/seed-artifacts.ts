import { createLocalStore, createRegistry, packArchive, type Principal, type ProtoFile } from "@protoloom/core";
import { repository, type Db } from "@protoloom/db";
import { ARTIFACTS, USERS, serverEnv } from "./fixtures";

function proto(path: string, body: string, imports: string[] = []): ProtoFile {
  const pkg = path.replace(/\/[^/]+$/, "").replaceAll("/", ".");
  const importLines = imports.map((i) => `import "${i}";\n`).join("");
  return { path, content: `syntax = "proto3";\n\npackage ${pkg};\n\n${importLines}${body}\n` };
}

/**
 * Seeds the browse fixtures through the real publish path: a public `releases` and a `snapshots`
 * repository, `dev.example:demo:1.0.0` (money.proto), `dev.example:orders:1.0.0` depending on it
 * (so deleting demo hits `has_dependents`) and two builds of `dev.example:demo:1.1.0-SNAPSHOT`.
 */
export async function seedArtifacts(db: Db): Promise<void> {
  await db.insert(repository).values([
    { name: ARTIFACTS.releases, description: "Released contracts", visibility: "public" },
    { name: ARTIFACTS.snapshots, description: "Snapshot builds", visibility: "private" },
  ]);

  const registry = createRegistry({ db, blobs: createLocalStore(serverEnv().STORAGE_LOCAL_PATH!) });
  const admin: Principal = { kind: "user", userId: USERS.admin.id, role: "admin" };
  const money = proto(
    "dev/example/money/v1/money.proto",
    "// An amount of money in minor units.\nmessage Money {\n  string currency = 1;\n  int64 cents = 2;\n}",
  );
  const currency = proto("dev/example/money/v1/currency.proto", 'enum Currency {\n  CURRENCY_UNSPECIFIED = 0;\n  EUR = 1;\n  USD = 2;\n}');
  const order = proto(
    "dev/example/orders/v1/order.proto",
    "message Order {\n  string id = 1;\n  dev.example.money.v1.Money total = 2;\n}",
    ["dev/example/money/v1/money.proto"],
  );

  const publish = async (repo: string, name: string, version: string, files: ProtoFile[], dependencies: string[] = []) =>
    registry.publish(admin, {
      repository: repo,
      manifest: { group: "dev.example", name, version, dependencies },
      archive: await packArchive(files),
    });

  await publish(ARTIFACTS.releases, "demo", "1.0.0", [money, currency]);
  await publish(ARTIFACTS.releases, "orders", "1.0.0", [order], ["dev.example:demo:1.0.0"]);
  await publish(ARTIFACTS.snapshots, "demo", "1.1.0-SNAPSHOT", [money, currency]);
  await publish(ARTIFACTS.snapshots, "demo", "1.1.0-SNAPSHOT", [money]);
}
