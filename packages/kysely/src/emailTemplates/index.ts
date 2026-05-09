import { EmailTemplatesAdapter } from "@authhero/adapter-interfaces";
import { Kysely } from "kysely";
import { Database } from "../db";
import { get } from "./get";
import { list } from "./list";
import { create } from "./create";
import { update } from "./update";
import { remove } from "./remove";

export function createEmailTemplatesAdapter(
  db: Kysely<Database>,
): EmailTemplatesAdapter {
  return {
    get: get(db),
    list: list(db),
    create: create(db),
    update: update(db),
    remove: remove(db),
  };
}
