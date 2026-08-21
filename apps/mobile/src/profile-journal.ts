import type { SyncProfile } from "./models";

interface ProfileTransitionJournal {
  version: 1;
  fromAccountKey: string | null;
  profile: SyncProfile;
}

export interface ProfileJournalEffects {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
  clear(): Promise<void>;
  reassign(fromAccountKey: string, toAccountKey: string): Promise<void>;
  persist(profile: SyncProfile): Promise<void>;
}

function parseJournal(raw: string): ProfileTransitionJournal {
  const parsed = JSON.parse(raw) as Partial<ProfileTransitionJournal>;
  const profile = parsed.profile as Partial<SyncProfile> | undefined;
  if (
    parsed.version !== 1 ||
    (parsed.fromAccountKey !== null && typeof parsed.fromAccountKey !== "string") ||
    !profile ||
    typeof profile.accountKey !== "string" ||
    typeof profile.installationId !== "string" ||
    typeof profile.serverUrl !== "string" ||
    typeof profile.token !== "string" ||
    typeof profile.userId !== "string" ||
    typeof profile.username !== "string"
  ) {
    throw new Error("账号迁移日志已损坏");
  }
  return parsed as ProfileTransitionJournal;
}

async function finishJournal(
  journal: ProfileTransitionJournal,
  effects: ProfileJournalEffects,
): Promise<SyncProfile> {
  if (journal.fromAccountKey && journal.fromAccountKey !== journal.profile.accountKey) {
    await effects.reassign(journal.fromAccountKey, journal.profile.accountKey);
  }
  await effects.persist(journal.profile);
  await effects.clear();
  return journal.profile;
}

/** journal 先于 Room/Keystore 副作用落盘；任何中断都可在下次启动幂等 roll-forward。 */
export async function commitProfileJournal(
  profile: SyncProfile,
  fromAccountKey: string | null,
  effects: ProfileJournalEffects,
): Promise<SyncProfile> {
  const journal: ProfileTransitionJournal = { version: 1, fromAccountKey, profile };
  await effects.write(JSON.stringify(journal));
  return finishJournal(journal, effects);
}

export async function recoverProfileJournal(
  effects: ProfileJournalEffects,
): Promise<SyncProfile | null> {
  const raw = await effects.read();
  if (!raw) return null;
  return finishJournal(parseJournal(raw), effects);
}
