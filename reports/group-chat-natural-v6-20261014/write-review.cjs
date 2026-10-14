const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const read = file => JSON.parse(fs.readFileSync(path.join(__dirname, file), 'utf8'));
const runs = ['01', '02', '03'].map(n => read(`round-${n}/run.json`));
const selected = runs[2];
const ab = read('ab-01/results.json');
const demo = read('learning-demo/run.json');
const smoke = read('package-smoke.json');
const archive = read('archive-verification.json');
const replay = read('replay-validation.json');
assert.ok(smoke.passed && smoke.groupLearningPersists && smoke.obsoleteHintsCanBeRetired);
assert.ok(archive.zipContentsMatch && archive.noLiveCredential);
assert.ok(replay.replayedWithCurrentParser && replay.manualSemanticReview.passed);
assert.deepEqual(selected.summary.failedChecks.map(check => check.name), ['answer:unknown']);
const describe = run => ({ ...run.summary, assertions: run.checks.length,
  nonAtReplies: run.events.filter(event => event.role === 'assistant' && run.operations.find(op => op.id === event.operation)?.kind === 'ambient').length,
  atReplies: run.events.filter(event => event.role === 'assistant' && run.operations.find(op => op.id === event.operation)?.kind === 'direct').length,
  learning: run.learning,
  learningTokens: run.requests.filter(row => run.operations.find(op => op.id === row.operation)?.kind === 'learning')
    .reduce((n, row) => n + (row.usage?.prompt_tokens || 0) + (row.usage?.completion_tokens || 0), 0),
  totalTokens: run.summary.mainInputTokens + run.summary.mainOutputTokens + run.summary.searchInputTokens + run.summary.searchOutputTokens });
const tokens = { prompt: 0, completion: 0, requests: 0, nativeSearchInput: 0, nativeSearchOutput: 0 };
for (const record of [...runs.flatMap(run => run.requests), ...ab.results, ...demo.requests]) {
  tokens.requests++; tokens.prompt += record.usage?.prompt_tokens || 0; tokens.completion += record.usage?.completion_tokens || 0;
}
for (const run of runs) { tokens.nativeSearchInput += run.summary.searchInputTokens; tokens.nativeSearchOutput += run.summary.searchOutputTokens; }
tokens.total = tokens.prompt + tokens.completion + tokens.nativeSearchInput + tokens.nativeSearchOutput;
const review = {
  checkedAt: new Date().toISOString(), status: 'implemented_and_verified_with_language_limitations',
  selectedRun: 'round-03/run.json',
  changes: [
    '新增独立的group-chat-learning.js服务和group-chat-learning-prompt.js专用学习提示词。',
    '程序自动在源码根目录或EXE所在目录的data/group-chat-learning/<群号>.json创建并更新文件，每群独立，重启后恢复。',
    '首次20条新真人消息学习，之后每30条且间隔至少10分钟；后台全群串行，不阻塞当前回复，回传去重不消耗新样本计数。',
    '从最近最多50条真实发送的群成员和bot消息提炼表达倾向，以真人表达和反馈为依据，不把旧NPC口癖或一声笑当作奖励。学习文件不累积原始聊天或过期话题事实。',
    '有上下文时一个字、词、笑声或半句话都可以，不要求补成完整解释；取消14字限制，不以长短评分。认真提问仍需答完整。',
    '学习提示作为表达资料注入判断、生成和草稿检查；不更改最新发送者人格、接话政策、工具权限或事实。至少一条真人证据，过滤越界策略和写作任务。',
    '原子写入后才应用新结果，异常保留旧配置；明确有效的空规则可以淘汰所有旧建议，重置使正在学习的旧结果失效。文件损坏不覆盖原文件。',
    '增加必须真实艾特的学习状态与重置群聊学习命令，加入帮助和配置示例。默认思考、学习与检查均保持非思考；未安排关机。'
  ],
  validation: {
    unitTests: 173, unitLog: 'unit-tests-deployed.log', syntaxLog: 'build-final.log',
    packageSmoke: 'package-smoke.json', archiveVerification: 'archive-verification.json', gitDiffCheckPassed: true,
    automaticFailuresInSelectedRun: selected.summary.failedChecks,
    manualSemanticResolution: replay.manualSemanticReview,
    sourceNote: '最终100条调用后，补充了有效空规则可清退全部旧建议的分支。该分支由单元和实际EXE验证；对本轮三个非空学习结果用最终解析器回放，结果与原记录完全相同。其余运行源码哈希匹配，详见replay-validation.json。',
    replay: 'replay-validation.json', realQQConnected: false
  },
  experiments: {
    fixedHistoryAb: { path: 'ab-01/results.json', requests: ab.results.length, summary: ab.summary,
      note: '这是本轮初版静态提示词的冻结历史对照，不含后续学习提示；输入约降9.3%，9个检查样本中旧版全部send，新版对6个旧问题skip。正文仍有建议、比喻和事实问题，未把全部初版当成最终方案。' },
    fragmentaryConversation: { path: 'learning-demo/run.json', requests: demo.requests.length,
      summary: demo.summary, learnedRules: demo.profile.rules,
      note: '同一当前提示词、相同历史，两轮成对生成，区别只有是否加入学习结果。学到省略、短词承接和反馈后少解释，出现总算、柠檬水、嗯知道了等回复；点完名是否赶上仍被部分输出误读，不能声称理解准确率或真人感稳定提高。' },
    iterations: [
      '第一轮学习把不用查误归为不接话，且学出自己的时间安排；已收紧学习范围和作用边界。',
      '第二轮仍学出顺着比喻推一步、补刀等创作策略，加入过滤，并加强真实行动与含糊时长的约束。',
      '模拟的未知答案词表漏认看不到、猜不出来、查不到；前两次已扩展词表。最后一轮梦是你的我可没权限看同样明确表示不知道，保留原始失败记录并人工确认，不强迫模型使用固定措辞。'
    ]
  },
  comparison: { baseline: describe(read('../group-chat-natural-v5-20261014/round-04/run.json')),
    rounds: runs.map(describe), selected: describe(selected) },
  manualReview: { readAllThreeTranscripts: true,
    findings: [
      '最终全部15条艾特消息回应，集合和数量修正、说话者区分、当前人格名字、简单数学和未知信息留白正常。',
      '学习文件初始化、三次更新、后续使用及共享50条时间顺序检查通过。内部学习JSON和未发送草稿没有写进群聊上下文。',
      '相比第一轮，最终未再观察到十点我也能上或我晚上轻手轻脚的现实参与声称。',
      '学习结果是提示词资料的迭代，不是修改模型权重；用户在真实群里的明确反馈仍是后续学习的重要依据。'
    ],
    limitations: [
      '仍有刻意接梗、复述、旁观点评和未请求建议，如h4换家店、h56评价形容准、h94-96闹钟续梗。不能声称NPC感已消除。',
      '仍有没依据的细节或推断，如h38-39猜没浇水、h35追加所需半天、h24将键盘打字当作游戏。语气学习不保证事实理解正确。',
      '合成100条中大多数真人消息本身带有调侃，学习结果会反映这种样本倾向；不能当成所有真实群的风格。',
      '主观非盲人工审阅，不以字数或接话次数作为自然程度分数；未独立核查所有联网回答的概括和开源表述。'
    ] },
  cost: { totals: tokens, note: '包括所有原型、未采用结果及搜索；API报告的缓存输入也计入，不是账单。完整对话会分叉，不能把总token差完全归因于提示词或学习模块。' },
  deployment: { package: '../../deploy/SandstormQQBot-Deploy.zip', scope: '本地deploy目录与ZIP，没有安装或重启真实QQ服务。',
    runtime: smoke.runtime, exeSha256: smoke.exeSha256, zipSha256: archive.zipSha256, files: archive.files,
    zipBytes: archive.zipBytes, noLiveCredential: archive.noLiveCredential, compiledSmokePassed: smoke.passed },
  shutdown: { scheduledNewShutdown: false }
};
fs.writeFileSync(path.join(__dirname, 'review.json'), JSON.stringify(review, null, 2) + '\n');
console.log(JSON.stringify({ unitTests: 173, learnedRevisions: selected.learning.revision,
  nonAtReplies: review.comparison.selected.nonAtReplies, atReplies: review.comparison.selected.atReplies,
  originalAutoFailures: selected.summary.failedChecks.length, manuallyResolved: 1, compiledSmokePassed: true, cost: tokens }));
