// Shared synthetic conversations for repeatable chat evaluations.
const scenarios = [
  {
    id: "game-update", label: "游戏更新吐槽", mode: "instant",
    goal: "接住半小时游玩时间被更新占掉的吐槽，避免说教或泛泛安慰。",
    messages: [
      ["user", "小林", "好不容易下班了，终于能打一把"],
      ["assistant", "Bot", "结果刚开游戏就被更新挡在门外了。"],
      ["user", "阿泽", "我就半小时能玩，它给我整了个30G更新"],
    ],
  },
  {
    id: "aim-joke", label: "接自嘲玩笑", mode: "instant",
    goal: "识别气氛组是在自嘲枪法，接一句具体的玩笑，不转成训练建议。",
    messages: [
      ["user", "阿泽", "刚才一梭子过去，对面一滴血没掉"],
      ["user", "小林", "你是给墙重新装修了吧"],
      ["user", "阿泽", "我的枪法主打一个气氛组"],
    ],
  },
  {
    id: "own-callback", label: "承接自己说过的话", mode: "idle",
    goal: "理解下载器启动器来自 bot 上一句的梗，继续玩笑，别解释这个梗或重复原句。",
    messages: [
      ["user", "小林", "这启动器每天开机第一件事就是更新"],
      ["assistant", "Bot", "这哪是游戏启动器，分明是下载器启动器。"],
      ["user", "小林", "你刚说那个下载器启动器笑死，我今天一把没打，下载倒是没停过"],
    ],
  },
  {
    id: "tired-chat", label: "疲惫时随口聊天", mode: "idle",
    goal: "简短自然地回应想躺会的状态，不套心理咨询话术，不安排一串恢复精力步骤。",
    messages: [
      ["user", "阿泽", "今天又加班，洗完澡都快一点了"],
      ["user", "小林", "那你还开游戏吗"],
      ["user", "阿泽", "不开了，就想躺会，啥也不想干"],
    ],
  },
  {
    id: "persona-switch", label: "多人聊天后恢复默认人格", mode: "instant",
    goal: "最新发言人未设置人格，应使用默认列克星敦，避免继承前一位的企业台词或反复角色称呼。",
    messages: [
      ["user", "企业爱好者", "企业，今晚带我赢一把"],
      ["assistant", "Bot", "指挥官，下一场由我为你扫清前路。"],
      ["user", "阿泽", "先别扫清前路了，谁把我外卖拿走了"],
    ],
  },
  {
    id: "enterprise-help", label: "已设置人格的实用提问", mode: "direct", persona: "enterprise",
    goal: "保留企业的简洁沉稳语气，回答版本不一致先查什么，不表演出击台词或添安慰套话。",
    messages: [
      ["user", "小林", "服务器还没更新，管理说十分钟后弄"],
      ["assistant", "Bot", "等服务端也更到同一版本再进。"],
      ["user", "阿泽", "我客户端刚更新完，进群服提示版本不一致，先查啥"],
    ],
  },
];

const earlierChat = [
  ["user", "小林", "明天要是下雨我就不出门了"],
  ["user", "阿泽", "楼下那家面馆今天居然没开"],
  ["assistant", "Bot", "又白跑一趟，看来晚饭得换一家。"],
  ["user", "小林", "我键盘的空格键又开始响了"],
  ["user", "阿泽", "你昨天不是刚修过吗"],
  ["user", "小林", "修完安静了半天"],
  ["assistant", "Bot", "这维修有效期有点短。"],
  ["user", "阿泽", "周末再拆开看看吧"],
];

function contextFor(scenario) {
  const fillerCount = 50 - scenario.messages.length;
  const records = [
    ...(scenario.history ?? Array.from({ length: fillerCount }, (_, index) => earlierChat[index % earlierChat.length])),
    ...scenario.messages,
  ].slice(-50);
  return records.map(([role, senderName, text], index) => ({
    role, senderName, text, userId: role === "user" ? senderName : "",
    messageId: `${scenario.id}-${index}`, timestamp: index + 1, images: [],
  }));
}


const holdoutScenarios = [
  {
    id: "no-advice", label: "明确只吐槽，不要建议", mode: "instant",
    goal: "尊重只想吐槽的意图，简短接话，不列解决方案，不套安慰词。",
    messages: [
      ["user", "小林", "今天进公司又忘带工牌了"],
      ["user", "阿泽", "保安让你登记了？"],
      ["user", "小林", "登记就算了，还扣20，我就是抱怨两句，别给我列办法"],
    ],
  },
  {
    id: "simple-close", label: "平常的对话收尾", mode: "idle",
    goal: "自然承接明晚再约，一句朴素的回应即可，不劝睡觉、不另找话题、不捏造亲自上线陪玩的安排。",
    messages: [
      ["user", "小林", "明早得赶车，今晚不打了"],
      ["user", "阿泽", "那就先散了"],
      ["user", "小林", "明晚再约呗"],
    ],
  },
  {
    id: "stop-catchphrase", label: "用户要求停止固定角色称呼", mode: "direct", persona: "enterprise",
    goal: "企业人格仍有效，但应接受自然说话的要求，不再使用指挥官、出击台词或角色动作。",
    messages: [
      ["user", "阿泽", "企业，刚才你那句太像游戏台词了"],
      ["assistant", "Bot", "指挥官，我会继续守在你身旁。"],
      ["user", "阿泽", "别一口一个指挥官了，正常说话就行"],
    ],
  },
  {
    id: "short-confirmation", label: "明确游戏背景下的简短确认", mode: "direct",
    goal: "使用服务端尚未更新的已知信息，简短确认等待管理即可；不增加重装、Minecraft 或无关分支排查。",
    messages: [
      ["user", "小林", "沙漠风暴客户端更新好了，服务器管理说十分钟后更服务端"],
      ["assistant", "Bot", "客户端先更新的话，暂时连不上旧版本服务端。"],
      ["user", "阿泽", "那我现在是不是等管理更完就行，别让我重装"],
    ],
  },
];

const interactionScenarios = [
  {
    id: "style-feedback", label: "只确认聊天风格反馈", mode: "direct",
    goal: "接受少总结、随便聊的反馈，直接改口，不解释规则或恢复较早的键盘/面馆话题。",
    messages: [
      ["user", "小林", "你每次都要在最后总结一下吗"],
      ["assistant", "Bot", "这样就能让今晚安排更有条理，也照顾到大家的感受。"],
      ["user", "小林", "别老总结了，我就是在随便聊天"],
    ],
  },
  {
    id: "friendly-disagree", label: "有判断地回应气话", mode: "instant",
    goal: "对卸载的气话给自然、适度的判断，可以温和不同意，不一味附和或演绎角色安慰。",
    messages: [
      ["user", "阿泽", "刚更新完又得下载补丁，烦死了"],
      ["user", "小林", "你是不是又想卸载了"],
      ["user", "阿泽", "还真想直接卸了，你说我是不是有点冲动"],
    ],
  },
  {
    id: "grounded-joke", label: "接梗保持情境成立", mode: "instant",
    goal: "顺着声音大但没命中的反差接玩笑，别为了梗把一梭子开火说成没声音，也不用提供练枪建议。",
    messages: [
      ["user", "小林", "你这开火声音全服务器都听见了"],
      ["user", "阿泽", "声音是挺大，问题是一个都没打中"],
      ["user", "阿泽", "我现在定位很明确，战场背景音"],
    ],
  },
  {
    id: "casual-fragment", label: "碎句与放弃继续折腾", mode: "idle",
    goal: "用松弛的短话接住暂时不玩的决定，不写完整劝慰段落，也不继续教用户修问题。",
    messages: [
      ["user", "小林", "刚进加载界面，又崩了"],
      ["user", "阿泽", "今天第三次了吧"],
      ["user", "小林", "算了，今天不玩了，摆了"],
    ],
  },
];

// These cases use short, non-repeating histories instead of the legacy filler.
const naturalnessScenarios = [
  {
    id: "unknown-update", label: "信息不足时自然问清楚", mode: "instant", history: [],
    goal: "没有游戏名或更新内容，先自然问清对象，不从人格推断游戏，不编造新角色、地图或改动。",
    messages: [["user", "小陈", "太太，你觉得这次更新怎么样？"]],
  },
  {
    id: "unknown-interface", label: "缺少软件名的实用追问", mode: "direct", history: [],
    goal: "前文没有指明游戏或软件，需要问清是哪一个；不编造菜单位置或拿角色所属游戏代入。",
    messages: [
      ["user", "小陈", "连不上，说版本不一样"],
      ["assistant", "Bot", "先核对一下两边的版本号。"],
      ["user", "小陈", "那版本号在哪看啊"],
    ],
  },
  {
    id: "small-good-news", label: "分享小小的成就", mode: "instant", history: [],
    goal: "具体接住做成一件小事的开心，允许朴素的高兴或轻松打趣，别写励志总结、教学或冷淡打发。",
    messages: [
      ["user", "栗子", "前两次煎蛋翻面都碎了"],
      ["user", "小陈", "今天呢"],
      ["user", "栗子", "今天居然完整翻过来了，给我厉害坏了"],
    ],
  },
  {
    id: "disappointed-without-advice", label: "认真失落时有温度", mode: "instant", history: [],
    goal: "承认投入白费的具体失落，不用段子打发、不强行积极、不推测老板动机，也不转成一套办法。",
    messages: [
      ["user", "小陈", "为那个方案忙了一整周"],
      ["user", "栗子", "今天评审怎么样"],
      ["user", "小陈", "项目直接砍了，有点难受，先别给我出主意"],
    ],
  },
  {
    id: "tease-the-bot", label: "被轻轻调侃时接得住", mode: "direct", persona: "enterprise", history: [],
    goal: "接住对 bot 一本正经讲冷笑话的打趣，保留沉稳语气，不解释幽默原理、不客服式道歉或表演动作。",
    messages: [
      ["user", "栗子", "讲个冷笑话"],
      ["assistant", "Bot", "冰箱里为什么很安静？因为没人在里面说话。"],
      ["user", "栗子", "你怎么能这么一本正经地冷场啊哈哈哈"],
    ],
  },
  {
    id: "own-mistake", label: "被指出记错时直接改正", mode: "direct", history: [],
    goal: "承认是自己把周末记错并改成周六，不解释系统原因、不甩锅给用户，也不复述一长段认错承诺。",
    messages: [
      ["user", "小陈", "我们周六去，周日我要上班"],
      ["assistant", "Bot", "那就周日见。"],
      ["user", "小陈", "周六啊，你怎么给我说成周日了"],
    ],
  },
  {
    id: "different-members", label: "不同群友的近况不混淆", mode: "instant",
    history: [
      ["user", "栗子", "我的杯子摔了，今天真倒霉"],
      ["assistant", "Bot", "杯子还能再买，人没被划到就好。"],
      ["user", "栗子", "没事，已经收拾了"],
    ],
    goal: "只接小陈忘拿快递的自嘲，不把栗子的杯子、受伤或倒霉经历算给小陈。",
    messages: [
      ["user", "小陈", "我下楼本来要拿快递"],
      ["user", "小陈", "结果买了杯奶茶就上来了"],
      ["user", "小陈", "快递一点没拿，奶茶倒是喝上了"],
    ],
  },
  {
    id: "useful-full-answer", label: "有具体任务时不敷衍", mode: "direct", history: [],
    goal: "写出自然的群公告，准确保留周六晚九点、满四人开、最多六人和迟到可补位四个条件，不为短而漏项。",
    messages: [
      ["user", "栗子", "周六晚上九点开，满四个人就打，最多六个人，迟到的有空位可以补"],
      ["user", "小陈", "帮忙把这个写成一句群公告，条件别漏，别像发文件"],
    ],
  },
  {
    id: "own-preference", label: "可以有自己的具体偏好", mode: "direct", history: [],
    goal: "按当前人格明确选一种并给朴素理由，不两边都夸，不捏造过去亲自看展的经历。",
    messages: [
      ["user", "栗子", "画展有两张，一张很鲜艳挤满花，一张就几笔淡淡的海"],
      ["user", "栗子", "要你选一张挂着看，你更喜欢哪张，别都说好"],
    ],
  },
  {
    id: "fresh-topic", label: "换了话题就自然跟过去", mode: "instant",
    history: [
      ["user", "小陈", "快递柜又打不开了"],
      ["assistant", "Bot", "先联系一下柜机客服。"],
      ["user", "小陈", "已经拿到了，没事了"],
    ],
    goal: "直接回应脆桃还是软桃，允许自然偏好，不拿刚结束的快递话题凑梗或追加建议，不捏造吃过的经历。",
    messages: [
      ["user", "栗子", "换个话题，你站脆桃还是软桃"],
    ],
  },
];

module.exports = { scenarios, holdoutScenarios, interactionScenarios, naturalnessScenarios, contextFor };
