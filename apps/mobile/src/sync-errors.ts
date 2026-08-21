export class SyncHttpError extends Error {
  readonly status: number;
  readonly responseData: unknown;

  constructor(status: number, message: string, responseData: unknown) {
    super(message);
    this.name = "SyncHttpError";
    this.status = status;
    this.responseData = responseData;
  }
}

/** 每次同步最多恢复一次，避免损坏服务端游标导致 bootstrap 循环。 */
export function shouldRecoverPullCursor(error: unknown, alreadyRecovered: boolean): boolean {
  return !alreadyRecovered && error instanceof SyncHttpError && error.status === 409;
}
