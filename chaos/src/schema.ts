import { defineSchema, t } from "@syncmesh/schema";

/**
 * One table, one partition, one rule.
 *
 * Deliberately the smallest schema that still has a policy: a rule that reads the row it lands on
 * is what makes admission depend on delivery, and admission depending on delivery is the whole
 * question. Anything more would only make a failing run harder to read.
 */

export const WORKSPACE = "workspace:chaos";
export const NOTE = "note";

export const chaosSchema = () =>
  defineSchema({
    partitions: { workspace: {} },
    roles: { workspace: ["admin", "member"] },
    tables: {
      note: {
        columns: {
          id: t.text().primaryKey(),
          title: t.text(),
          ownerId: t.text(),
          at: t.integer(),
        },
        partition: "workspace",
        // a row belongs to the account that made it; everyone in the workspace can read it
        allow: ({ owner, role, any }) => ({
          $default: any(owner("ownerId"), role("admin")),
          read: role("member"),
        }),
      },
    },
  });
