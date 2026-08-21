import assert from "node:assert/strict";
import test from "node:test";
import {
  accountMutationTargets,
  activateAccountMutations,
  migrateAccountMutations,
  resetAccountMutationRoute,
  retireAccountMutations,
  runAccountMutation,
} from "../src/account-mutations.ts";

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("登录迁移等待既有写入，并把冻结期间的新写入路由到团队命名空间", async () => {
  const local = `local-${crypto.randomUUID()}`;
  const team = `team-${crypto.randomUUID()}`;
  const writing = deferred();
  const events: string[] = [];
  const first = runAccountMutation(local, async (effective) => {
    events.push(`first:${effective}:start`);
    await writing.promise;
    events.push(`first:${effective}:end`);
  });
  const migration = migrateAccountMutations(local, team, async (from, to) => {
    assert.equal(from, local);
    assert.equal(to, team);
    events.push("migrate");
  });
  const late = runAccountMutation(local, async (effective) => {
    events.push(`late:${effective}`);
    return effective;
  });

  await Promise.resolve();
  assert.deepEqual(events, [`first:${local}:start`]);
  writing.resolve();
  await first;
  await migration;
  assert.equal(await late, team);
  assert.deepEqual(events, [
    `first:${local}:start`,
    `first:${local}:end`,
    "migrate",
    `late:${team}`,
  ]);
  assert.equal(accountMutationTargets(local, team), true);

  resetAccountMutationRoute(local);
  assert.equal(accountMutationTargets(local, team), false);
});

test("登出屏障等待已开始的副作用，并拒绝释放后的旧页面写入", async () => {
  const account = `account-${crypto.randomUUID()}`;
  activateAccountMutations(account);
  const writing = deferred();
  const events: string[] = [];
  const first = runAccountMutation(account, async () => {
    events.push("first:start");
    await writing.promise;
    events.push("first:end");
  });
  const retiring = retireAccountMutations(account, async () => {
    events.push("finalize");
  });
  const late = runAccountMutation(account, async () => {
    events.push("late");
  });

  writing.resolve();
  await first;
  await retiring;
  await assert.rejects(late, /账号已切换/);
  assert.deepEqual(events, ["first:start", "first:end", "finalize"]);
});

test("journal 重放解析成同一目标账号时不再调用底层迁移", async () => {
  const local = `local-${crypto.randomUUID()}`;
  const team = `team-${crypto.randomUUID()}`;
  const migrations: string[] = [];
  const migrate = async (from: string, to: string) => {
    migrations.push(`${from}->${to}`);
  };

  await migrateAccountMutations(local, team, migrate);
  await migrateAccountMutations(local, team, migrate);

  assert.deepEqual(migrations, [`${local}->${team}`]);
  assert.equal(accountMutationTargets(local, team), true);
});
