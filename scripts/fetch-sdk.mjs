// 下载 Android 构建所需的两个包：build-tools(含 aapt2/d8/apksigner/zipalign) 与 platform-34(含 android.jar)
// 用法: node scripts/fetch-sdk.mjs
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

const REPO = 'https://dl.google.com/android/repository/repository2-3.xml';
const BASE = 'https://dl.google.com/android/repository/';
const OUT = path.resolve('.sdk-dl');

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function text(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return await r.text();
}

log('fetching repository index ...');
const xml = await text(REPO);
log('index bytes:', xml.length);

// 抓所有 <url> 项
const urls = [...xml.matchAll(/<url>([^<]+)<\/url>/g)].map(m => m[1]);
log('total archive urls:', urls.length);

function pick(re, label) {
  const hits = urls.filter(u => re.test(u));
  log(`candidates for ${label}:`, hits.join(', ') || '(none)');
  return hits.sort().pop();
}

const buildTools = pick(/^build-tools_r34(\.\d+)?-windows\.zip$/, 'build-tools 34');
const platform = pick(/^platform-34(-ext\d+)?_r\d+\.zip$/, 'platform-34');
if (!buildTools || !platform) throw new Error('未能定位所需包，请检查索引规则');

await mkdir(OUT, { recursive: true });
log('selected:', buildTools, platform);

async function download(name) {
  const dest = path.join(OUT, name);
  const r = await fetch(BASE + name);
  if (!r.ok) throw new Error(`${name} -> HTTP ${r.status}`);
  const total = Number(r.headers.get('content-length') || 0);
  let got = 0, last = 0;
  const rs = r.body;
  rs.on?.('data', c => { got += c.length; });
  const t0 = Date.now();
  await pipeline(rs, createWriteStream(dest));
  const secs = (Date.now() - t0) / 1000;
  log(`saved ${name}  ${(got / 1048576).toFixed(1)}MB  ${secs.toFixed(1)}s  ${(got / 1048576 / secs).toFixed(2)}MB/s (server len=${total})`);
  return dest;
}

const t0 = Date.now();
for (const f of [buildTools, platform]) await download(f);
log('done in', ((Date.now() - t0) / 1000).toFixed(1), 's');
await writeFile(path.join(OUT, 'SELECTED.txt'), [buildTools, platform].join('\n'), 'utf8');