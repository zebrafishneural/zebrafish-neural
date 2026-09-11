import {rename} from 'node:fs/promises';
import {setTimeout as sleep} from 'node:timers/promises';

export const RENAME_RETRY_DELAYS_MS = Object.freeze([25, 50, 100, 200, 400, 800]);
const retryable = new Set(['EPERM', 'EBUSY', 'EACCES']);

// Windows readers may briefly lock the destination. Retain both files if the
// lock persists: deleting the committed checkpoint would break atomicity.
export async function renameWithRetry(source, destination, {renameImpl=rename, sleepImpl=sleep}={}) {
  for (let attempt=0; ; attempt++) {
    try {
      return await renameImpl(source, destination);
    } catch (error) {
      if (!retryable.has(error?.code) || attempt >= RENAME_RETRY_DELAYS_MS.length) throw error;
      await sleepImpl(RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
}
