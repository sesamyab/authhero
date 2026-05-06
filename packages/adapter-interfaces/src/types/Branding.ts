import { z } from "@hono/zod-openapi";

export const brandingSchema = z.object({
  colors: z
    .object({
      primary: z.string(),
      // Auth0 supports either a hex color string ("#ffffff") or a gradient
      // object. Match both shapes so SDK callers don't get rejected.
      page_background: z
        .union([
          z.string(),
          z.object({
            type: z.string().optional(),
            start: z.string().optional(),
            end: z.string().optional(),
            angle_deg: z.number().optional(),
          }),
        ])
        .optional(),
    })
    .optional(),
  logo_url: z.string().optional(),
  favicon_url: z.string().optional(),
  powered_by_logo_url: z.string().optional(),
  font: z
    .object({
      url: z.string(),
    })
    .optional(),
});

export type Branding = z.infer<typeof brandingSchema>;
