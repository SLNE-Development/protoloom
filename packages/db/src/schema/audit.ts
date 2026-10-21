import { boolean, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const actorTypeEnum = pgEnum("actor_type", ["user", "apikey", "anonymous", "system"]);

export const auditEvent = pgTable("audit_event", {
  id: uuid("id").primaryKey().defaultRandom(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  actorType: actorTypeEnum("actor_type").notNull(),
  actorId: text("actor_id"),
  action: text("action").notNull(),
  target: text("target").notNull(),
  details: jsonb("details"),
  forced: boolean("forced").notNull().default(false),
});
