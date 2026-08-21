import assert from "node:assert/strict";
import test from "node:test";
import type { SyncProfile } from "../src/models.ts";
import {
  commitProfileJournal,
  recoverProfileJournal,
  type ProfileJournalEffects,
} from "../src/profile-journal.ts";
import { migrateAccountMutations } from "../src/account-mutations.ts";

const profile: SyncProfile = {
  accountKey: "team-a",
  installationId: "installation-a",
  serverUrl: "https://near.example",
  token: "token-a",
  userId: "user-a",
  username: "alice",
};

test("Room 迁移后 Keystore 失败会保留 journal，重启后幂等完成并清理", async () => {
  let journal: string | null = null;
  let persistFails = true;
  const migrations: string[] = [];
  const persisted: SyncProfile[] = [];
  const effects: ProfileJournalEffects = {
    read: async () => journal,
    write: async (value) => {
      journal = value;
    },
    clear: async () => {
      journal = null;
    },
    reassign: async (from, to) => {
      migrations.push(`${from}->${to}`);
    },
    persist: async (value) => {
      if (persistFails) throw new Error("keystore unavailable");
      persisted.push(value);
    },
  };

  await assert.rejects(commitProfileJournal(profile, "LOCAL", effects), /keystore/);
  assert.ok(journal);
  assert.deepEqual(migrations, ["LOCAL->team-a"]);
  persistFails = false;
  assert.deepEqual(await recoverProfileJournal(effects), profile);
  assert.deepEqual(migrations, ["LOCAL->team-a", "LOCAL->team-a"]);
  assert.deepEqual(persisted, [profile]);
  assert.equal(journal, null);
});

test("同进程恢复不会把已迁移的目标命名空间再次当作源删除", async () => {
  const local = `local-${crypto.randomUUID()}`;
  const teamProfile = { ...profile, accountKey: `team-${crypto.randomUUID()}` };
  const records = new Map([[local, ["offline-record"]]]);
  let journal: string | null = null;
  let persistFails = true;
  let physicalMigrations = 0;
  const effects: ProfileJournalEffects = {
    read: async () => journal,
    write: async (value) => {
      journal = value;
    },
    clear: async () => {
      journal = null;
    },
    reassign: (from, to) =>
      migrateAccountMutations(from, to, async (effectiveFrom, effectiveTo) => {
        physicalMigrations += 1;
        const source = records.get(effectiveFrom) ?? [];
        records.set(effectiveTo, [...(records.get(effectiveTo) ?? []), ...source]);
        records.delete(effectiveFrom);
      }),
    persist: async () => {
      if (persistFails) throw new Error("keystore unavailable");
    },
  };

  await assert.rejects(commitProfileJournal(teamProfile, local, effects), /keystore/);
  persistFails = false;
  await recoverProfileJournal(effects);

  assert.equal(physicalMigrations, 1);
  assert.deepEqual(records.get(teamProfile.accountKey), ["offline-record"]);
  assert.equal(records.has(local), false);
});
