import * as Minio from "minio";
import { config } from "./config.js";
import { retryUntilReady } from "./retry.js";

export const minio = new Minio.Client({
  endPoint: config.minio.endPoint,
  port: config.minio.port,
  useSSL: config.minio.useSSL,
  accessKey: config.minio.accessKey,
  secretKey: config.minio.secretKey,
});

export async function initializeMinio(): Promise<void> {
  await retryUntilReady(async () => {
    const exists = await minio.bucketExists(config.minio.bucket);
    if (!exists) {
      await minio.makeBucket(config.minio.bucket, "us-east-1");
    }
  });
}
