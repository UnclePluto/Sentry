import { parentPort, workerData } from 'node:worker_threads';
import { parseWorkbook } from './parser.mjs';
try {
  parentPort.postMessage({
    data: await parseWorkbook(Buffer.from(workerData)),
  });
} catch (e) {
  parentPort.postMessage({ error: e.message });
}
