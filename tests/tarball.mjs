/** Install the real archive through dsh in a disposable home, using compiled host modules only. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const tarball = resolve(process.argv[2] ?? join(root, 'dist', `${manifest.name}-${manifest.version}.tgz`));
// Pass an installed dsh package directory as the second argument to test another host build.
const hostRoot = resolve(process.argv[3] ?? join(root, '..', 'apps', 'cli'));
const cli = join(hostRoot, 'lib', 'bin.js');
assert.ok(existsSync(cli), `需要已构建的 Harness：${cli}`);
const hostManifest = JSON.parse(readFileSync(join(hostRoot, 'package.json'), 'utf8'));
assert.ok(existsSync(tarball), `请先运行 npm run pack:tarball：${tarball}`);
const checksum = readFileSync(`${tarball}.sha256`, 'utf8').split(/\s/)[0];
assert.equal(createHash('sha256').update(readFileSync(tarball)).digest('hex'), checksum);
const directory = mkdtempSync(join(tmpdir(), 'traffic-tarball-'));
const testHome = join(directory, 'home');
const env = { ...process.env, DSH_HOME: testHome };
// The test must not load the source checkout through tsx, NODE_PATH, or custom Node hooks.
delete env.NODE_OPTIONS;
delete env.NODE_PATH;
const run = (args) => {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: directory, env, encoding: 'utf8', timeout: 120000,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
  return result.stdout;
};
let resolutionContext;
try {
  assert.equal(run(['--version']).trim(), hostManifest.version, '验证实际运行的 Harness 版本');
  run(['plugin', '--profile', 'tarball-test', 'add', tarball, '--ignore-scripts']);
  const profileDir = join(testHome, 'profiles', 'tarball-test');
  const profileManifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
  assert.ok(profileManifest.dsh.profile.bundles.includes(manifest.name), 'dsh 自动启用 bundle 层');
  assert.ok(!profileManifest.dependencies[manifest.name].startsWith('link:'), '不能链接回源码仓库');
  assert.match(run(['--profile', 'tarball-test', '--dump-config']), /name: dsh-traffic-liability/);
  const installed = join(profileDir, 'node_modules', manifest.name);
  assert.ok(realpathSync(installed).startsWith(`${realpathSync(directory)}${sep}`), '安装文件必须位于临时目录');
  assert.equal(lstatSync(installed).isSymbolicLink(), false);
  assert.equal(existsSync(join(installed, 'src')), false);
  assert.equal(existsSync(join(installed, 'tests')), false);
  assert.equal(existsSync(join(installed, '.cases')), false);
  const packedManifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
  assert.equal(packedManifest.version, manifest.version);
  const hostRequire = createRequire(join(hostRoot, 'package.json'));
  const boot = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-app-boot')).href);
  const profile = boot.loadProfile('dsh', 'tarball-test', join(hostRoot, 'package.json'), testHome);
  assert.ok(!profile.skippedBundles?.some((bundle) => bundle.packageName === manifest.name), '兼容性检查不能跳过插件');
  if (boot.evaluatePluginCompatibility) {
    for (const version of [hostManifest.version, '0.1.5-rc.2', '0.2.0-rc.2', '0.2.0']) {
      assert.equal(boot.evaluatePluginCompatibility(packedManifest, {}, version), undefined, `宿主版本声明须接受 ${version}`);
    }
    const previousManifest = { ...packedManifest, peerDependencies: { ...packedManifest.peerDependencies, '@deepseek-ai/dsh-tools': '^0.1.5-rc.2' } };
    assert.ok(boot.evaluatePluginCompatibility(previousManifest, {}, '0.2.0-rc.2'), '旧声明会被 0.2 的兼容性检查拦截');
  }
  const resolutionOptions = { installAnchor: join(hostRoot, 'package.json'), profile, home: testHome };
  if (boot.createRuntimeResolution) {
    // Harness 0.2 shares host packages through its runtime service, without fallback symlinks.
    const { Context } = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/cordis')).href);
    resolutionContext = new Context();
    await resolutionContext.plugin(boot.PluginPackages, { resolution: await boot.createRuntimeResolution(resolutionOptions) });
  } else {
    await boot.healProfilesModuleFallback(resolutionOptions);
  }
  const profileRequire = createRequire(join(profileDir, 'package.json'));
  assert.equal(realpathSync(profileRequire.resolve(manifest.name)), join(realpathSync(installed), 'lib', 'index.js'));
  const { Config, apply } = await import(pathToFileURL(profileRequire.resolve(manifest.name)).href);
  const config = Config({ caseDir: join(directory, 'cases') });
  assert.equal(config.lawDataDir, join(realpathSync(installed), 'data', 'laws'));
  const tools = new Map();
  let prompt = '';
  apply({
    systemPrompt: { section(value) { prompt = value.text; } },
    tools: { register(tool) { tools.set(tool.name, tool); } },
  }, config);
  assert.equal(tools.size, 7);
  assert.match(prompt, /traffic_review_export/);
  const { validateJsonSchemaValue } = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-tools')).href);
  const call = async (name, args) => {
    const tool = tools.get(name);
    assert.ok(tool, name);
    const value = await tool.execute(args, {});
    assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value, 'value'), []);
    return value;
  };
  assert.equal((await call('traffic_case_save', { stage: 'registration', payload: {} })).saved, false, '安装产物返回普通校验结果');
  const overview = await call('traffic_case_read', {});
  assert.deepEqual(overview.cases, [], '失败的首次登记不留下空案件');
  assert.ok(!('reviewContract' in overview));
  const format = await call('traffic_case_read', { stage: 'duties' });
  assert.ok(format.stageContract.duties.rules.some((rule) => rule.includes('affectedIds')));
  assert.deepEqual(Object.keys((await call('traffic_case_read', { reviewSection: 'intake' })).reviewContract), ['intake']);
  assert.ok(existsSync(join(installed, 'docs', 'upgrade-guide', 'v0.1.3', 'stage-validation', 'guide.zh.md')));
  const created = await call('traffic_case_save', { stage: 'registration', payload: {
    occurredAt: null, reportedAt: null, location: '打包测试路口', jurisdiction: '全国',
    roadType: null, intersectionType: null, trafficControl: null, casualties: null,
    propertyLoss: null, unknowns: [], parties: [{ id: 'A', name: '甲', role: 'motor_driver' }], vehicles: [],
  } });
  const evidence = await call('traffic_case_save', { caseId: created.caseId, stage: 'evidence', payload: {
    skippedReason: 'no_materials', materials: [], observations: [], qualityIssues: [],
    facts: [{ id: 'signal', proposition: '甲面对的信号灯颜色', status: 'unknown', supportingObservationIds: [], opposingObservationIds: [] }],
    openQuestions: [{ itemId: 'item.signal', partyId: 'A', prompt: '甲当时面对的信号灯是什么颜色？', impact: '改变通行义务判断。', factIds: ['signal'] }],
  } });
  assert.equal(evidence.clarification.questions[0].itemId, 'item.signal');
  await call('traffic_case_answer', { caseId: created.caseId, answers: [{ itemId: 'item.signal', status: 'answered', answer: '当时是绿灯', speaker: '甲' }] });
  const updated = await call('traffic_case_read', { caseId: created.caseId });
  assert.equal(updated.clarification.status, 'needs_reanalysis');
  const updatedEvidence = updated.evidenceForUpdate;
  updatedEvidence.facts[0].status = 'supported';
  updatedEvidence.facts[0].supportingObservationIds = [`reply_o_${updated.clarification.pendingAnswers[0].id}`];
  updatedEvidence.openQuestions = [];
  await call('traffic_case_save', { caseId: created.caseId, stage: 'evidence', payload: updatedEvidence });
  assert.equal((await call('traffic_case_read', { caseId: created.caseId })).adoptedFacts.length, 1);
  const rules = JSON.parse(readFileSync(join(config.lawDataDir, 'rules.json'), 'utf8'));
  assert.equal(rules.filter((rule) => rule.title === '道路交通事故处理程序规定').length, 114);
  const search = await call('traffic_rule_search', { lawId: 'road_traffic_accident_procedures', articleNumber: 71, asOf: '2026-10-15' });
  assert.equal(search.status, 'matched');
  assert.equal((await call('traffic_rule_search', { lawId: 'road_traffic_accident_procedures', articleNumber: 71, asOf: '2017-01-01' })).status, 'version_not_covered');
  await call('traffic_rule_read', { ruleIds: [search.cards[0].ruleId] });
  const review = await call('traffic_review_save', {
    section: 'intake', payload: {
      applicant: { kind: 'individual', name: null, identityNumber: null, address: null, phone: null, details: null, representative: null },
      original: { number: null, authority: null, issuedOn: null, servedOn: null, source: '打包测试虚构材料', text: '测试原文：甲承担全部责任。', conclusions: [{ id: 'original', locator: '测试第1段', quote: '甲承担全部责任', responsibility: '甲全部责任' }] },
      accidentSummary: null, userRequest: null, receivingAuthority: null, applicationDate: null,
      priorReview: 'unknown', evidence: [],
    },
  });
  const draft = await call('traffic_review_export', { caseId: review.caseId, mode: 'draft' });
  assert.match(draft.preview, /【待补充：/);
  assert.equal(readFileSync(draft.path).subarray(0, 2).toString(), 'PK', 'docx 运行依赖可用');
  assert.equal(readFileSync(draft.previewPath, 'utf8'), draft.preview);
  const view = await call('traffic_case_read', { caseId: review.caseId });
  assert.equal(view.review.exports.length, 1);
  for (const file of ['道路交通事故认定复核申请书模板.docx', '道路交通事故认定复核申请书模板.txt', 'README.md']) {
    assert.ok(existsSync(join(installed, 'data', 'templates', file)), file);
  }
  run(['plugin', '--profile', 'tarball-test', 'remove', manifest.name]);
  const removed = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
  assert.ok(!removed.dsh.profile.bundles.includes(manifest.name));
  console.log(`tarball ok: ${manifest.name}@${manifest.version} on Harness ${hostManifest.version}; dsh add/remove, bundle config, compiled entry, all seven tools, clarification/reanalysis, laws, templates and Word export outside checkout`);
} finally {
  try {
    await resolutionContext?.fiber.dispose();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
