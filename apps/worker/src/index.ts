import { createBlobStoreFromEnv } from "@protoloom/core";
import { createDb } from "@protoloom/db";
import { redisConnection } from "@protoloom/jobs";
import { loadEnv } from "./env.js";
import { startWorker } from "./worker.js";

const env = loadEnv(process.env);
const db = createDb(env.DATABASE_URL);
const blobs = createBlobStoreFromEnv(env);
const running = await startWorker({ db, blobs, connection: redisConnection(env.VALKEY_URL) });
console.log("protoloom-worker: processing cleanup jobs");

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`protoloom-worker: ${signal} received, finishing the current job`);
  try {
    await running.close();
    await db.$client.end();
    process.exit(0);
  } catch (error) {
    console.error("protoloom-worker: shutdown failed", error);
    process.exit(1);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
