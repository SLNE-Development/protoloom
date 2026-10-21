import { z } from "zod";
import { updateSettings, type ServerSettings } from "@protoloom/core";
import { adminProcedure, publicProcedure, router } from "../init";

/** Server-wide settings. */
export const settingsRouter = router({
  /** The settings any caller may know (the layout needs them before sign-in): only `anonymousView`. */
  get: publicProcedure.query(({ ctx }): Pick<ServerSettings, "anonymousView"> => ({ anonymousView: ctx.settings.anonymousView })),

  /** Changes settings (admin), audited as `settings.update`; returns the resulting settings. */
  update: adminProcedure
    .input(z.object({ anonymousView: z.boolean().optional() }))
    .mutation(async ({ ctx, input }): Promise<ServerSettings> => updateSettings(ctx.db, input, ctx.principal)),
});
