// 分块并行下载 Android SDK 组件（走国内镜像），解决单连接限速。
import { open, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MIRROR = process.env.MIRROR || 'https://mirrors.cloud.tencent.com/AndroidSDK/';
const OUT = path.resolve('.sdk-dl');
const CONN = Number(process.env.CONN || 8);

const FILES = [
  'build-tools_r34-windows.zip',
  'platform-34-ext8_r01.zip'
];

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function sizeOf(url) {
  const r = await fetch(url, { method: 'HEAD' });
  if (!r.ok) throw new Error('HEAD ' + r.status + ' ' + url);
  return Number(r.headers.get('content-length'));
}

async function grab(url, dest, total, conn) {
  const fh = await open(dest, 'w');
  await fh.truncate(total);
  const chunk = Math.ceil(total / conn);
  const jobs = [];
  let done = 0;
  const t0 = Date.now();
  const timer = setInterval(() => {
    const sec = (Date.now() - t0) / 1000;
    log(`  ${(done / 1048576).toFixed(1)}/${(total / 1048576).toFixed(1)}MB  ${(done / 1048576 / sec).toFixed(2)}MB/s`);
  }, 4000);

  for (let i = 0; i < conn; i++) {
    const start = i * chunk;
    const end = Math.min(total - 1, start + chunk - 1);
    if (start > end) break;
    jobs.push((async () => {
      let attempt = 0;
      while (attempt < 6) {
        attempt++;
        try {
          const r = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const buf = Buffer.from(await r.arrayBuffer());
          if (buf.length !== end - start + 1) throw new Error('short read ' + buf.length);
          await fh.write(buf, 0, buf.length, start);
          done += buf.length;
          return;
        } catch (e) {
          if (attempt >= 6) throw e;
          await new Promise(r2 => setTimeout(r2, 800 * attempt));
        }
      }
    })());
  }
  await Promise.all(jobs);
  clearInterval(timer);
  await fh.close();
  const sec = (Date.now() - t0) / 1000;
  log(`saved ${path.basename(dest)} ${(total / 1048576).toFixed(1)}MB in ${sec.toFixed(0)}s (${(total / 1048576 / sec).toFixed(2)}MB/s)`);
}

for (const name of FILES) {
  const url = MIRROR + name;
  log('HEAD', url);
  const total = await sizeOf(url);
  log('size', (total / 1048576).toFixed(1), 'MB');
  await grab(url, path.join(OUT, name), total, CONN);
}
await writeFile(path.join(OUT, 'DONE.txt'), 'ok ' + new Date().toISOString(), 'utf8');
log('ALL DONE');