import { Writable } from 'stream';

export function processIsRunning(pid: number) {
  try {
    return process.kill(pid, 0);
  } catch (e) {
    return e.code === 'EPERM';
  }
}

export function devNull() {
  return new Writable({
    write: (chunk, encoding, cb) => {
      cb();
    },
  });
}
