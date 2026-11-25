import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { apps, devices } from "./capture";
import { episodes } from "./episodes";
import { identityRuleScopes } from "./enums";
import { oneOf } from "./check";

export const settings = sqliteTable(
  "settings",
  {
    key: text("key").primaryKey(),
    value: text("value", { mode: "json" }).$type<unknown>().notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (t) => [
    // SQLite lets a TEXT primary key hold NULL unless told otherwise.
    check("settings_key_check", sql`${t.key} is not null and length(${t.key}) > 0`),
    check("settings_value_check", sql`json_valid(${t.value})`),
  ],
);

/** Whether voices are recognised, globally or for one app, device, or episode. */
export const identityRules = sqliteTable(
  "identity_rules",
  {
    id: integer("id").primaryKey(),
    scope: text("scope", { enum: identityRuleScopes }).notNull(),
    appId: integer("app_id").references(() => apps.id, { onDelete: "cascade" }),
    deviceId: integer("device_id").references(() => devices.id, { onDelete: "cascade" }),
    episodeId: integer("episode_id").references(() => episodes.id, { onDelete: "cascade" }),
    recognize: integer("recognize", { mode: "boolean" }).notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (t) => [
    uniqueIndex("identity_rules_global_unique")
      .on(t.scope)
      .where(sql`${t.scope} = 'global'`),
    uniqueIndex("identity_rules_app_unique")
      .on(t.appId)
      .where(sql`${t.scope} = 'app'`),
    uniqueIndex("identity_rules_device_unique")
      .on(t.deviceId)
      .where(sql`${t.scope} = 'device'`),
    uniqueIndex("identity_rules_episode_unique")
      .on(t.episodeId)
      .where(sql`${t.scope} = 'episode'`),
    check("identity_rules_scope_check", oneOf(t.scope, identityRuleScopes)),
    check(
      "identity_rules_target_check",
      sql`(case ${t.scope}
        when 'global' then ${t.appId} is null and ${t.deviceId} is null and ${t.episodeId} is null
        when 'app' then ${t.appId} is not null and ${t.deviceId} is null and ${t.episodeId} is null
        when 'device' then ${t.deviceId} is not null and ${t.appId} is null and ${t.episodeId} is null
        when 'episode' then ${t.episodeId} is not null and ${t.appId} is null and ${t.deviceId} is null
        else 0 end)`,
    ),
  ],
);
