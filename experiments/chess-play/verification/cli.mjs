import {open} from 'node:fs/promises';
import {MAX_INPUT_BYTES, verifyDecision, VERIFICATION_SCOPE} from './verify.mjs';

let result;
try {
  if (process.argv.length !== 3) throw Error('Usage: node experiments/chess-play/verification/cli.mjs <decision.json>');
  const file = await open(process.argv[2], 'r');
  let bytes;
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw Error('Decision input must be an ordinary file.');
    if (stat.size > MAX_INPUT_BYTES) throw Error('Decision JSON exceeds the 8 MiB limit.');
    bytes = Buffer.alloc(MAX_INPUT_BYTES + 1); let used = 0;
    for (;;) {
      const {bytesRead} = await file.read(bytes, used, bytes.length - used, null);
      if (!bytesRead) break;
      used += bytesRead;
      if (used > MAX_INPUT_BYTES) throw Error('Decision JSON exceeds the 8 MiB limit.');
    }
    bytes = bytes.subarray(0, used);
  } finally { await file.close(); }
  result = await verifyDecision(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
} catch (failure) {
  result = {status: 'invalid', ok: false, reason: failure instanceof Error ? failure.message.slice(0, 240) : 'Decision input could not be read.', scope: VERIFICATION_SCOPE};
}
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
process.exitCode = result.ok ? 0 : 1;
