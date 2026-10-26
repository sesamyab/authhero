import {
  Rollout,
  RolloutInsert,
  RolloutKind,
  RolloutStatus,
  RolloutUpdate,
} from "../types/Rollout";
import { ListParams } from "../types/ListParams";

export interface ListRolloutsResult {
  rollouts: Rollout[];
  start: number;
  limit: number;
  length: number;
}

export interface ListRolloutsParams extends ListParams {
  status?: RolloutStatus | RolloutStatus[];
  kind?: RolloutKind;
}

export interface RolloutsAdapter {
  /** Generates the `rol_<nanoid>` id and inserts with status `pending`. */
  create(rollout: RolloutInsert): Promise<Rollout>;
  get(id: string): Promise<Rollout | null>;
  /** Default sort: `created_at` descending. */
  list(params?: ListRolloutsParams): Promise<ListRolloutsResult>;
  /** Always bumps `updated_at`. */
  update(id: string, rollout: RolloutUpdate): Promise<boolean>;
  remove(id: string): Promise<boolean>;
}
