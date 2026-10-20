/** Build via prepack, audit the npm payload, and write a portable SHA-256 sidecar. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, process.argv[2] ?? 'dist');
mkdirSync(output, { recursive: true });
const result = spawnSync('npm', ['pack', '--json', '--foreground-scripts=false', '--pack-destination', output], {
  cwd: root, encoding: 'utf8', shell: process.platform === 'win32',
});
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'npm pack failed');
const [packed] = JSON.parse(result.stdout);
const files = new Set(packed.files.map((file) => file.path));
for (const required of [
  'package.json', 'lib/index.js', 'cordis.patch.yml', 'README.md',
  'data/laws/rules.json', 'data/laws/catalog.json', 'data/laws/annotations.json',
  'data/templates/README.md', 'data/templates/道路交通事故认定复核申请书模板.docx',
  'data/templates/道路交通事故认定复核申请书模板.txt',
  'docs/upgrade-guide/v0.1.3/stage-validation/guide.md',
  'docs/upgrade-guide/v0.1.3/stage-validation/guide.zh.md',
]) assert.ok(files.has(required), `打包缺少必要文件：${required}`);
for (const file of files) assert.match(file, /^(?:package\.json|README\.md|cordis\.patch\.yml|lib\/[^/]+\.js|data\/laws\/[^/]+\.json|data\/templates\/(?:README\.md|[^/]+\.(?:docx|txt))|docs\/upgrade-guide\/[^/]+\/[^/]+\/guide(?:\.zh)?\.md)$/, `意外的分发文件：${file}`);
const tarball = join(output, packed.filename);
const hash = createHash('sha256').update(readFileSync(tarball)).digest('hex');
writeFileSync(`${tarball}.sha256`, `${hash}  ${basename(tarball)}\n`);
console.log(`Tarball: ${tarball}\nSHA-256: ${hash}\nFiles: ${files.size}; compressed: ${packed.size} bytes`);
