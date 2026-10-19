import { Kysely } from "kysely";
import { Database } from "../db";
import { list, listCheckpoint } from "./list";
import { listUsers } from "./list-users";
import { create } from "./create";
import { remove } from "./remove";

export function userRoles(db: Kysely<Database>) {
  return {
    list: list(db),
    listCheckpoint: listCheckpoint(db),
    listUsers: listUsers(db),
    create: create(db),
    remove: remove(db),
  };
}
