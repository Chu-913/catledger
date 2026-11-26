#!/usr/bin/env node
/**
 * 用 GitHub Git Data API 推送当前分支（这台机器上 git push 到 github.com:443 会被网络拦掉，
 * 但 api.github.com 通，所以走 API）。
 *
 * 用法：
 *   node scripts/push-github.mjs            # 推送当前分支到 origin
 *   node scripts/push-github.mjs -n         # 只看会不会推，不实际写
 *
 * 前提：
 *   - 本地提交已经做好（这个脚本不会替你 add/commit）
 *   - Windows 凭据管理器里存着 GitHub 的 token（`git credential fill` 能取到）
 *   - 远端 HEAD 必须是本地 HEAD 的父提交（否则说明两边分叉了，脚本会停下让你手动处理）
 */
import { execFileSync } from 'node:child_process';

const DRY = process.argv.includes('-n') || process.argv.includes('--dry-run');
const git = (args, opts = {}) => execFileSync('git', args, { encoding: 'utf8', ...opts });

const die = msg => { console.error('✗ ' + msg); process.exit(1); };

/* ---------- 1. 远端与 token ---------- */
const remoteUrl = git(['remote', 'get-url', 'origin']).trim();
const m = /github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?$/.exec(remoteUrl);
if (!m) die('origin 不是 GitHub 地址: ' + remoteUrl);
const [, owner, repo] = m;

const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
if (branch === 'HEAD') die('当前是游离 HEAD，先切到分支');

let token;
try {
  const out = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8', timeout: 15000
  });
  token = (/^password=(.*)$/m.exec(out) || [])[1];
} catch (e) {
  die('取不到 GitHub 凭据（git credential fill 失败）');
}
if (!token) die('凭据里没有 password（token）');

/* ---------- 2. 本地提交信息 ---------- */
const head = git(['rev-parse', 'HEAD']).trim();
const raw = git(['cat-file', 'commit', 'HEAD']);
const lines = raw.split('\n');
const tree = /^tree (\w+)$/.exec(lines[0])[1];
const parent = (/^parent (\w+)$/.exec(lines[1]) || [])[1];
const authorLine = lines.find(l => l.startsWith('author '));
const committerLine = lines.find(l => l.startsWith('committer '));

const parseId = line => {
  const r = /^\w+ (.+) <(.+)> (\d+) ([+-]\d{4})$/.exec(line);
  if (!r) die('解析提交身份失败: ' + line);
  return { name: r[1], email: r[2], ts: Number(r[3]), tz: r[4] };
};
const toIso = ({ ts, tz }) => {
  const sign = tz[0] === '-' ? -1 : 1;
  const offMin = sign * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(3, 5)));
  const d = new Date((ts + offMin * 60) * 1000);
  return d.toISOString().slice(0, 19) + tz.slice(0, 3) + ':' + tz.slice(3);
};
const A = parseId(authorLine), C = parseId(committerLine);
const message = raw.slice(raw.indexOf('\n\n') + 2).replace(/\n+$/, '');

/* ---------- 3. HTTP ---------- */
const API = `https://api.github.com/repos/${owner}/${repo}`;
async function api(path, init = {}) {
  const res = await fetch(API + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'catledger-push-script',
      ...(init.headers || {})
    }
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) die(`${init.method || 'GET'} ${path} → ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

const repoInfo = await api('');
const remoteBranch = await api(`/git/ref/heads/${branch}`).catch(() => null);
const remoteHead = remoteBranch ? remoteBranch.object.sha : null;

console.log(`仓库   ${owner}/${repo}（${repoInfo.private ? '私有' : '公开'}）`);
console.log(`分支   ${branch}`);
console.log(`本地   ${head.slice(0, 7)}`);
console.log(`远端   ${remoteHead ? remoteHead.slice(0, 7) : '(空)'}`);

if (remoteHead === head) { console.log('✓ 远端已是最新，无需推送'); process.exit(0); }
if (remoteHead !== parent) {
  die(`远端 HEAD 不是本地 HEAD 的父提交（远端 ${remoteHead?.slice(0, 7)}，本地父 ${parent?.slice(0, 7)}）。` +
      `\n  两边分叉了，请先手动对齐（例如 git fetch，但本机 443 不通，只能用 API 逐层核对）。`);
}

/* ---------- 4. 上传 blob ---------- */
const entries = git(['ls-tree', '-r', '-z', 'HEAD']).split('\0').filter(Boolean).map(s => {
  const [mode, type, sha, ...rest] = s.split(/\s+/);
  return { mode, type, sha, path: rest.join(' ') };
});
if (!entries.length) die('HEAD 里没有文件');

console.log(`\n上传 ${entries.length} 个文件…`);
for (const e of entries) {
  if (e.type !== 'blob') die('暂不支持子模块: ' + e.path);
  const content = git(['cat-file', 'blob', e.sha], { encoding: 'buffer' });
  const blob = await api('/git/blobs', {
    method: 'POST',
    body: JSON.stringify({ content: content.toString('base64'), encoding: 'base64' })
  });
  if (blob.sha !== e.sha) die(`blob 内容不一致: ${e.path}（本地 ${e.sha.slice(0, 7)} / 远端 ${blob.sha.slice(0, 7)}）`);
  process.stdout.write('.');
}
console.log('');

/* ---------- 5. tree / commit / ref ---------- */
const treeRes = await api('/git/trees', {
  method: 'POST',
  body: JSON.stringify({
    tree: entries.map(e => ({ path: e.path, mode: e.mode, type: 'blob', sha: e.sha }))
  })
});
if (treeRes.sha !== tree) die(`tree 不一致: 本地 ${tree.slice(0, 7)} / 远端 ${treeRes.sha.slice(0, 7)}`);
console.log(`tree   ${treeRes.sha.slice(0, 7)} ✓`);

const commitRes = await api('/git/commits', {
  method: 'POST',
  body: JSON.stringify({
    message,
    tree: treeRes.sha,
    parents: [remoteHead],
    author: { name: A.name, email: A.email, date: toIso(A) },
    committer: { name: C.name, email: C.email, date: toIso(C) }
  })
});

/* GitHub 生成的对象和本地 `git commit` 的只有一个字节差异：
   message 末尾不带换行。所以这里按它的规矩复现同一个对象，
   把本地分支对齐过去，避免本地/远端历史悄悄分叉。 */
let finalSha = commitRes.sha;
if (commitRes.sha !== head) {
  const text = `tree ${tree}\nparent ${remoteHead}\n` +
    `author ${A.name} <${A.email}> ${A.ts} ${A.tz}\n` +
    `committer ${C.name} <${C.email}> ${C.ts} ${C.tz}\n\n${message}`;
  const local = execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'],
    { input: text, encoding: 'utf8' }).trim();
  if (local !== commitRes.sha) {
    die(`远端生成的提交 ${commitRes.sha.slice(0, 7)} 与本地 ${head.slice(0, 7)} 不同，且无法用本地对象复现。\n` +
        `  提交已经推上去了，但本地历史对不上，建议用 git reset 对齐后再看。`);
  }
  if (!DRY) {
    execFileSync('git', ['update-ref', `refs/heads/${branch}`, local, head], { stdio: 'inherit' });
    console.log(`本地已对齐到远端提交 ${local.slice(0, 7)}（内容不变，仅 message 末尾换行差异）`);
  }
  finalSha = local;
}

if (DRY) { console.log(`\n（-n 模式，未写入 ref）会是 ${finalSha.slice(0, 7)}`); process.exit(0); }

await api(`/git/refs/heads/${branch}`, {
  method: 'PATCH',
  body: JSON.stringify({ sha: commitRes.sha, force: false })
});

const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();
if (dirty) console.log('注意：工作区还有未提交的改动\n' + dirty);

console.log(`✓ 已推送 ${finalSha.slice(0, 7)} → ${owner}/${repo}#${branch}`);