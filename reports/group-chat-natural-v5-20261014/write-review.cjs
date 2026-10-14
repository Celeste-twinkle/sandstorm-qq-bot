const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..', '..');
const read = file => JSON.parse(fs.readFileSync(path.resolve(__dirname, file), 'utf8'));
const hash = file => createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
const baseline = read('../group-chat-natural-v4-20261014/round-04/run.json');
const rounds = ['01', '02', '03', '04'].map(number => read(`round-${number}/run.json`));
const selected = rounds[3];
assert.equal(selected.status, 'awaiting-transcript-review');
assert.equal(selected.summary.failedChecks.length, 0);
for (const [file, expected] of Object.entries(selected.sourceHashes)) assert.equal(hash(file), expected, file);
function describe(run) {
  const replies = run.events.filter(event => event.role === 'assistant');
  const ambient = replies.filter(event => run.operations.find(op => op.id === event.operation).kind === 'ambient');
  const anchors = new Set(ambient.map(event => event.afterHuman));
  let sequence = 0, longest = 0;
  for (let human = 1; human <= 100; human++) {
    sequence = anchors.has(human) ? sequence + 1 : 0;
    longest = Math.max(longest, sequence);
  }
  return { ...run.summary, nonAtReplies: ambient.length, atReplies: replies.length - ambient.length,
    meanAmbientChars: ambient.reduce((n, event) => n + Array.from(event.text).length, 0) / ambient.length,
    maxConsecutiveHumanMessagesWithAmbientReply: longest, assertions: run.checks.length,
    boundaryChecks: run.checks.filter(check => check.name.startsWith('boundary:')).length,
    mainRequests: run.requests.length,
    totalReportedTokens: run.summary.mainInputTokens + run.summary.mainOutputTokens + run.summary.searchInputTokens + run.summary.searchOutputTokens };
}
const abPaths = ['ab-01', 'continuity-ab', 'ab-revised', 'continuity-ab-revised', 'participation-ab',
  'continuity-participation-ab', 'tone-ab', 'participation-tone-ab', 'participation-selected-ab', 'continuity-selected-ab', 'fresh-sharing-ab'];
const ab = abPaths.map(directory => {
  const result = read(`${directory}/results.json`);
  assert.ok(result.finishedAt, directory);
  assert.equal(result.results.filter(row => row.error).length, 0, directory);
  return { path: `${directory}/results.json`, ...result.summary,
    decisions: Object.fromEntries(['baseline', 'candidate'].map(variant => {
      const rows = result.results.filter(row => row.variant === variant && row.kind === 'judge');
      return [variant, { cases: rows.length, reply: rows.filter(row => row.shouldReply).length,
        expectedCaseErrors: rows.filter(row => typeof row.expected === 'boolean' && row.expected !== row.shouldReply).length }];
    })) };
});
const totals = { abRequests: 0, abInputTokens: 0, abOutputTokens: 0, simulationMainRequests: 0,
  simulationInputTokens: 0, simulationOutputTokens: 0, searchInputTokens: 0, searchOutputTokens: 0 };
for (const item of ab) for (const variant of ['baseline', 'candidate']) {
  totals.abRequests += item[variant].requests;
  totals.abInputTokens += item[variant].promptTokens;
  totals.abOutputTokens += item[variant].completionTokens;
}
for (const run of rounds) {
  totals.simulationMainRequests += run.requests.length;
  totals.simulationInputTokens += run.summary.mainInputTokens;
  totals.simulationOutputTokens += run.summary.mainOutputTokens;
  totals.searchInputTokens += run.summary.searchInputTokens;
  totals.searchOutputTokens += run.summary.searchOutputTokens;
}
totals.totalReportedTokens = totals.abInputTokens + totals.abOutputTokens + totals.simulationInputTokens +
  totals.simulationOutputTokens + totals.searchInputTokens + totals.searchOutputTokens;
const smoke = read('package-smoke.json');
const archive = read('archive-verification.json');
assert.equal(smoke.passed, true);
assert.equal(smoke.ambientPhasesShare50DespiteLegacyLimits, true);
assert.equal(archive.zipContentsMatch, true);
assert.equal(archive.noLiveCredential, true);
const unitBytes = fs.readFileSync(path.join(__dirname, 'unit-tests-deployed.log'));
const unit = unitBytes.toString(unitBytes[0] === 0xff && unitBytes[1] === 0xfe ? 'utf16le' : 'utf8');
assert.ok(/pass 159/.test(unit), 'Expected 159 passing tests');
assert.ok(/fail 0/.test(unit), 'Expected zero failing tests');
const review = {
  checkedAt: new Date().toISOString(), status: 'validated_with_style_and_semantic_limitations', selectedRun: 'round-04/run.json',
  baselineRun: '../group-chat-natural-v4-20261014/round-04/run.json',
  changes: [
    '已删除只回应当前一句或只回答锚点的限制。提示词说明群消息按时间从旧到新排列，由模型联系整段讨论直接发言；锚点只作最后一条成员消息的位置标记。',
    '即时闲聊、冷场闲聊的判断、正文和检查共用最近50条共享群消息，包含实际发送的bot回复。旧4/6条闲聊设置和Qwen独立会话历史上限不再缩短共享群记录。',
    '仍以时间上最新群成员的个人设置选择人格，没有设置就使用默认人格。',
    '参与判断倾向加入公共分享、共鸣和偏好，无需艾特、新知识或新梗；同时减少已参与事件的连续跟评，保留对自己的追问和真正的新进展。',
    '生成强调直接和群友说话，减少点评谁总结得准、旁白群友情绪和虚构地点；不把机器人写成现场队友或现实同事。',
    '.env 中旧 AMBIENT_CHAT_SYSTEM_PROMPT 覆盖已清空，使用当前内置提示词；.env.example 同步留空。其他凭据与运行设置未改。',
    '没有启用默认思考、增加请求环节、引入回复概率、固定比例、次数配额或强制暖场。'
  ],
  manualReview: {
    readAllFourFullTranscripts: true,
    findings: [
      '最终15条艾特消息全部回复，未艾特的偏好追问h28保持蓝白选择。集合更正、数量更正、说话者区分、最新发送者人格与未知问题留白检查通过。',
      '最终正文未再观察到第二轮h20挑我站着的、h67卡纸归我管那样把自己代入真实队友或同事的说法。',
      '第三轮h37的新叶比表好看多了能够联系前面的工作吐槽。最终h44/h49/h54/h93从群聊记录读取更正和发言人，不把末尾消息孤立成单独的问题。',
      '冻结50条连续性场景中，最早保留记录的深绿键盘仍能关联米白键帽；同一话题条件变更的追问可以接，只有前一条说明接收人的私人事务保持安静。',
      '第三轮非艾特26次、最长连续插话3条，仍偏保守；随后放宽另一名群友的新经历和不同反应。最终非艾特43次、艾特15次，比上轮29次非艾特多14次，最长连续插话4条。没有用程序设参与率或连发上限。',
      '第三轮对应的固定31条历史判断对照为旧版7次、新版9次想接话，全部已标注边界正确；9个连续性判断中，纠正旧bot结论的场景由漏接变为接住。最终对应的18组公共分享判断由11次想接增至17次，h51公交与h53闹钟经历更容易参与，重复跟评也有增加。'
    ],
    remainingIssues: [
      '最终43次非艾特参与增多，同时在工作吐槽、打印机上的猫、梦和闹钟等事件仍有连续跟评。没有证明实际群聊回复率或真人感稳定提高，次数增加不是自然程度的保证。',
      '仍有简短评语、物品拟人和未请求提醒，如h19截图记得挑好看的、h37绿萝想通了、h94-96闹钟续梗。',
      '草稿检查仍漏放部分语义问题：h68把可能暖和说成暖和倒是真的；h48在缺少人数和用量依据时说五瓶差不多够了；h53把不能赖公交转成闹钟不背锅。不能声称彻底消除NPC感或所有无依据细节。',
      '普通短附和的补充场景仍选择不接，想接就接的提示不保证每次回应；保留AI按兴致旁观的选择。',
      '语气改善来自合成场景的非盲人工审阅，采样和分叉历史会影响结果，不把次数或字数作为客观真人感分。',
      '只验证联网证据路径可用，没有独立复核联网回答的每个概括或所有开源表述。',
      '群记录硬上限是50；极长正文或图片仍会受到模型与CHAT_MAX_CONTEXT_CHARS预算保护。'
    ]
  },
  experiments: {
    method: '冻结每对群聊历史，随机请求先后，判断温度0.5、正文0.9、相同输出预算，全部非思考。A/B无工具、无QQ；100条模拟使用实际index.js和OneBot入口、真实API与搜索、虚拟时间和假的WebSocket确认，不发送到真实QQ。',
    ab,
    discarded: [
      { paths: ['ab-01/results.json', 'continuity-ab/results.json'], reason: '用户澄清前的原型，已按后续要求删除所有只回应锚点的控制语句。' },
      { paths: ['ab-revised/results.json'], reason: '删除单句限定后仍过度保守，固定31条历史只想接6次，随后强化公共话题参与意愿。' },
      { paths: ['round-01/run.json'], reason: '35次非艾特但最长连续跟评5条，有旁观点评与补造锅底、墙边地点。' },
      { paths: ['round-02/run.json'], reason: '35次非艾特但最长连续跟评4条，有虚构现场参与和同一笑点连续补充，随后收紧这两点。' },
      { paths: ['round-03/run.json', 'review-round03.json'], reason: '26次非艾特且最长连续跟评3条，现场参与声称减少，但把补充细节一律压低后，新成员公开分享偏保守；随后放宽对不同个人经历和反应的参与。' }
    ],
    rawForcedGenerationNote: '部分A/B正文被强制生成，即使判断阶段本应不接；原始回复包含未请求提醒与不合适比喻，不代表经过检查后实际发送的正文。'
  },
  comparison: { baseline: describe(baseline), rounds: rounds.map(describe), selected: describe(selected) },
  validation: { unitTests: 159, unitLog: 'unit-tests-deployed.log', syntaxLog: 'build-selected.log',
    sourceHashesMatch: true, sourceHashes: selected.sourceHashes, finalAssertions: selected.checks.length,
    failedAssertions: 0, gitDiffCheckPassed: true, gitDiffCheckLog: 'git-diff-check-final.log',
    compiled50DespiteLegacyLimits: true,
    correctedHarnessAssumptions: [
      '旧文字断言只回应它更新为按时间从旧到新排列，功能测试未失败。',
      '部署校验的历史窗口改为回传文本更新前的快照，避免测试回传echo替换row-69后正则失配；生产去重行为未改。',
      'ZIP条目名兼容Windows反斜杠，规范化后再做边界与逐文件哈希校验。',
      '报告读取PowerShell日志时识别UTF16LE的BOM；测试实际已通过，只是最初报告解码不符。'
    ] },
  cost: { totals, selectedVsBaselineTotalPercent: (describe(selected).totalReportedTokens / describe(baseline).totalReportedTokens - 1) * 100,
    note: '计入全部原型与未采用实验。使用API返回token，包含缓存输入与搜索，不是账单。最后18组判断输入增加306 token，约0.65%，输出相同。最终完整模拟总token较上轮增加约23%，参与和检查请求也更多，搜索用量不同，不能全部归因于提示词。' },
  deployment: { package: '../../deploy/SandstormQQBot-Deploy.zip', scope: '更新本地deploy目录与ZIP，没有连接QQ或安装到生产服务器。',
    exeSha256: smoke.exeSha256, zipSha256: archive.zipSha256, zipBytes: archive.zipBytes, files: archive.files,
    runtime: smoke.runtime, compiledSmokePassed: true, zipContentsMatch: true, noLiveCredential: true,
    smoke: 'package-smoke.json', archiveVerification: 'archive-verification.json' },
  shutdown: read('shutdown-status.json')
};
fs.writeFileSync(path.join(__dirname, 'review.json'), JSON.stringify(review, null, 2) + '\n');
console.log(JSON.stringify({ selectedRun: review.selectedRun, nonAtReplies: review.comparison.selected.nonAtReplies,
  atReplies: review.comparison.selected.atReplies, assertions: review.validation.finalAssertions, unitTests: 159,
  sourceHashesMatch: true, compiledSmokePassed: true, cost: totals }));
