import assert from "node:assert/strict";
import test from "node:test";
import {
  ProfileTransitionCoordinator,
  SupersededProfileTransitionError,
} from "../src/profile-transitions.ts";

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("并发登录只允许最新尝试提交，慢响应不能覆盖快响应", async () => {
  const coordinator = new ProfileTransitionCoordinator();
  const slowNetwork = deferred<string>();
  const fastNetwork = deferred<string>();
  const committed: string[] = [];
  const slowAttempt = coordinator.begin();
  const slow = slowNetwork.promise.then((value) =>
    slowAttempt.commit(async () => {
      committed.push(value);
      return value;
    }),
  );
  const fastAttempt = coordinator.begin();
  const fast = fastNetwork.promise.then((value) =>
    fastAttempt.commit(async () => {
      committed.push(value);
      return value;
    }),
  );

  fastNetwork.resolve("B");
  assert.equal(await fast, "B");
  slowNetwork.resolve("A");
  await assert.rejects(slow, SupersededProfileTransitionError);
  assert.deepEqual(committed, ["B"]);
});

test("登出等待在途提交收尾，并使尚未提交的登录失效", async () => {
  const coordinator = new ProfileTransitionCoordinator();
  const commitBlocked = deferred<void>();
  const firstAttempt = coordinator.begin();
  const first = firstAttempt.commit(async () => {
    await commitBlocked.promise;
    return "A";
  });
  await Promise.resolve();
  const invalidated = coordinator.invalidateAndWait();
  commitBlocked.resolve();
  await assert.rejects(first, SupersededProfileTransitionError);
  await invalidated;
  const stale = coordinator.begin();
  const newer = coordinator.begin();
  await assert.rejects(
    stale.commit(async () => "stale"),
    SupersededProfileTransitionError,
  );
  assert.equal(await newer.commit(async () => "current"), "current");
});
