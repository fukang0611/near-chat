export interface EmojiItem {
  emoji: string;
  name: string;
  keywords: string[];
}

export interface EmojiCategory {
  id: string;
  label: string;
  icon: string;
  emojis: EmojiItem[];
}

export const RECENT_EMOJI_STORAGE_KEY = "near-chat-recent-emojis";
export const MAX_RECENT_EMOJIS = 18;

const emoji = (value: string, name: string, ...keywords: string[]): EmojiItem => ({
  emoji: value,
  name,
  keywords,
});

/**
 * 第一阶段内置一组高频 Unicode Emoji，保证离线环境无需字体文件、CDN 或第三方数据包。
 * 关键词同时保留中文和常用英文，方便团队成员按习惯搜索。
 */
export const EMOJI_CATEGORIES: EmojiCategory[] = [
  {
    id: "smileys",
    label: "表情",
    icon: "😀",
    emojis: [
      emoji("😀", "开心", "笑脸", "高兴", "happy", "smile"),
      emoji("😃", "大笑", "开心", "笑脸", "grin"),
      emoji("😄", "笑眼", "开心", "哈哈", "laugh"),
      emoji("😁", "露齿笑", "开心", "得意", "grin"),
      emoji("😆", "眯眼笑", "开心", "大笑", "laugh"),
      emoji("😅", "汗笑", "尴尬", "还好", "sweat"),
      emoji("😂", "笑哭", "大笑", "眼泪", "joy"),
      emoji("🤣", "笑翻", "大笑", "打滚", "rofl"),
      emoji("😊", "微笑", "开心", "温暖", "blush"),
      emoji("🙂", "浅笑", "友好", "微笑", "smile"),
      emoji("🙃", "倒脸", "调皮", "反话", "upside"),
      emoji("😉", "眨眼", "暗示", "调皮", "wink"),
      emoji("😍", "花痴", "喜欢", "爱心眼", "love"),
      emoji("🥰", "喜爱", "爱心", "幸福", "love"),
      emoji("😘", "飞吻", "亲亲", "喜欢", "kiss"),
      emoji("😋", "好吃", "馋", "美味", "yum"),
      emoji("😎", "墨镜", "酷", "厉害", "cool"),
      emoji("🤩", "星星眼", "惊喜", "崇拜", "wow"),
      emoji("🥳", "庆祝脸", "派对", "生日", "party"),
      emoji("🤔", "思考", "疑问", "考虑", "think"),
      emoji("🫡", "敬礼", "收到", "遵命", "salute"),
      emoji("🤗", "拥抱", "欢迎", "抱抱", "hug"),
      emoji("🤭", "捂嘴笑", "偷笑", "害羞", "giggle"),
      emoji("🫢", "惊讶捂嘴", "吃惊", "震惊", "gasp"),
      emoji("😐", "无表情", "无语", "平静", "neutral"),
      emoji("😑", "无语", "无奈", "沉默", "expressionless"),
      emoji("😴", "睡觉", "困", "晚安", "sleep"),
      emoji("🥱", "打哈欠", "困", "疲倦", "yawn"),
      emoji("😢", "流泪", "难过", "哭", "sad"),
      emoji("😭", "大哭", "伤心", "眼泪", "cry"),
      emoji("😤", "哼", "生气", "不服", "angry"),
      emoji("😡", "生气", "愤怒", "发火", "rage"),
      emoji("🤯", "爆炸头", "震惊", "烧脑", "mind blown"),
      emoji("😱", "惊恐", "害怕", "震惊", "scream"),
      emoji("🥺", "可怜", "请求", "委屈", "plead"),
      emoji("😇", "天使", "无辜", "乖", "angel"),
    ],
  },
  {
    id: "gestures",
    label: "手势",
    icon: "👋",
    emojis: [
      emoji("👋", "挥手", "你好", "再见", "wave"),
      emoji("🤚", "举手", "停止", "我来", "hand"),
      emoji("🖐️", "手掌", "五", "击掌", "hand"),
      emoji("✋", "停", "手掌", "击掌", "stop"),
      emoji("🫶", "爱心手", "喜欢", "支持", "heart hands"),
      emoji("👌", "好的", "可以", "没问题", "ok"),
      emoji("🤌", "捏手", "一点", "强调", "pinched"),
      emoji("🤏", "一点点", "很少", "小", "small"),
      emoji("✌️", "胜利", "耶", "二", "victory"),
      emoji("🤞", "祝好运", "交叉手指", "期待", "luck"),
      emoji("🫰", "比心", "爱", "喜欢", "finger heart"),
      emoji("🤟", "爱你", "手势", "love you"),
      emoji("🤘", "摇滚", "酷", "rock"),
      emoji("🤙", "打电话", "联系", "call"),
      emoji("👈", "向左", "这里", "left"),
      emoji("👉", "向右", "这里", "right"),
      emoji("👆", "向上", "上面", "up"),
      emoji("👇", "向下", "下面", "down"),
      emoji("☝️", "第一", "注意", "one"),
      emoji("👍", "赞", "同意", "很好", "like"),
      emoji("👎", "踩", "不同意", "不好", "dislike"),
      emoji("✊", "加油", "拳头", "力量", "fist"),
      emoji("👊", "碰拳", "加油", "拳头", "fist bump"),
      emoji("🤝", "握手", "合作", "成交", "handshake"),
      emoji("👏", "鼓掌", "赞扬", "庆祝", "clap"),
      emoji("🙌", "欢呼", "庆祝", "万岁", "hooray"),
      emoji("🙏", "谢谢", "拜托", "祈祷", "thanks"),
      emoji("💪", "肌肉", "加油", "强壮", "strong"),
    ],
  },
  {
    id: "hearts",
    label: "爱心",
    icon: "❤️",
    emojis: [
      emoji("❤️", "红心", "喜欢", "爱", "heart"),
      emoji("🧡", "橙心", "温暖", "爱", "heart"),
      emoji("💛", "黄心", "友谊", "爱", "heart"),
      emoji("💚", "绿心", "健康", "爱", "heart"),
      emoji("💙", "蓝心", "信任", "爱", "heart"),
      emoji("💜", "紫心", "喜欢", "爱", "heart"),
      emoji("🖤", "黑心", "酷", "爱", "heart"),
      emoji("🤍", "白心", "纯洁", "爱", "heart"),
      emoji("🤎", "棕心", "温暖", "爱", "heart"),
      emoji("💔", "心碎", "难过", "分手", "broken heart"),
      emoji("❤️‍🔥", "燃烧的心", "热爱", "激情", "fire heart"),
      emoji("❤️‍🩹", "治愈的心", "安慰", "恢复", "healing"),
      emoji("💕", "两颗心", "喜欢", "甜蜜", "hearts"),
      emoji("💞", "旋转心", "相爱", "喜欢", "hearts"),
      emoji("💓", "心跳", "心动", "喜欢", "heartbeat"),
      emoji("💗", "成长的心", "喜欢", "心动", "heart"),
      emoji("💖", "闪亮的心", "喜欢", "闪耀", "sparkle"),
      emoji("💘", "丘比特", "恋爱", "喜欢", "cupid"),
      emoji("💝", "礼物心", "送礼", "喜欢", "gift heart"),
      emoji("💟", "心形装饰", "爱", "heart"),
      emoji("❣️", "心形叹号", "喜欢", "强调", "heart"),
      emoji("💌", "情书", "消息", "喜欢", "love letter"),
      emoji("💋", "唇印", "亲亲", "喜欢", "kiss"),
      emoji("🌹", "玫瑰", "浪漫", "鲜花", "rose"),
    ],
  },
  {
    id: "celebration",
    label: "庆祝",
    icon: "🎉",
    emojis: [
      emoji("🎉", "礼花", "庆祝", "恭喜", "party"),
      emoji("🎊", "彩球", "庆祝", "恭喜", "confetti"),
      emoji("✨", "闪光", "漂亮", "新", "sparkles"),
      emoji("⭐", "星星", "收藏", "优秀", "star"),
      emoji("🌟", "闪亮星星", "优秀", "高光", "star"),
      emoji("💫", "眩晕星", "闪耀", "魔法", "dizzy"),
      emoji("🔥", "火", "热门", "厉害", "fire"),
      emoji("💥", "爆炸", "冲击", "厉害", "boom"),
      emoji("💯", "一百分", "满分", "正确", "100"),
      emoji("✅", "完成", "正确", "通过", "done"),
      emoji("❌", "错误", "取消", "不行", "wrong"),
      emoji("❗", "叹号", "注意", "重要", "important"),
      emoji("❓", "问号", "疑问", "为什么", "question"),
      emoji("🎈", "气球", "庆祝", "生日", "balloon"),
      emoji("🎂", "生日蛋糕", "生日", "庆祝", "cake"),
      emoji("🎁", "礼物", "惊喜", "赠送", "gift"),
      emoji("🏆", "奖杯", "冠军", "胜利", "trophy"),
      emoji("🥇", "金牌", "第一", "冠军", "medal"),
      emoji("🚀", "火箭", "发布", "起飞", "launch", "rocket"),
      emoji("📣", "喇叭", "通知", "宣传", "announce"),
      emoji("🔔", "铃铛", "提醒", "通知", "bell"),
      emoji("💡", "灯泡", "想法", "灵感", "idea"),
      emoji("🎯", "靶心", "目标", "命中", "target"),
      emoji("⚡", "闪电", "快速", "能量", "fast"),
    ],
  },
  {
    id: "work",
    label: "工作",
    icon: "💻",
    emojis: [
      emoji("💻", "电脑", "工作", "开发", "computer"),
      emoji("⌨️", "键盘", "输入", "开发", "keyboard"),
      emoji("🖥️", "显示器", "工作", "电脑", "desktop"),
      emoji("📱", "手机", "移动端", "电话", "phone"),
      emoji("📎", "回形针", "附件", "文件", "attachment"),
      emoji("📁", "文件夹", "文件", "目录", "folder"),
      emoji("📄", "文档", "文件", "说明", "document"),
      emoji("📝", "备忘录", "记录", "写作", "memo"),
      emoji("📌", "图钉", "固定", "重要", "pin"),
      emoji("📅", "日历", "日期", "计划", "calendar"),
      emoji("⏰", "闹钟", "提醒", "时间", "alarm"),
      emoji("⏳", "沙漏", "等待", "处理中", "wait"),
      emoji("🔍", "搜索", "查找", "放大镜", "search"),
      emoji("🔗", "链接", "地址", "连接", "link"),
      emoji("🔒", "锁", "安全", "私密", "lock"),
      emoji("🔧", "扳手", "修复", "设置", "fix"),
      emoji("⚙️", "齿轮", "设置", "配置", "settings"),
      emoji("🧪", "试管", "测试", "实验", "test"),
      emoji("🐛", "虫子", "缺陷", "调试", "bug"),
      emoji("📦", "包裹", "发布", "构建", "package"),
      emoji("🔄", "刷新", "同步", "重试", "refresh"),
      emoji("⬆️", "向上", "上传", "升级", "up"),
      emoji("⬇️", "向下", "下载", "降级", "down"),
      emoji("📊", "图表", "数据", "统计", "chart"),
      emoji("📈", "上涨", "增长", "趋势", "up chart"),
      emoji("👀", "关注", "看看", "眼睛", "eyes"),
      emoji("🙋", "举手", "我来", "提问", "raise hand"),
      emoji("🤖", "机器人", "自动化", "AI", "robot"),
    ],
  },
  {
    id: "nature",
    label: "自然",
    icon: "🌿",
    emojis: [
      emoji("☀️", "太阳", "晴天", "早上", "sun"),
      emoji("🌤️", "晴间多云", "天气", "白天", "weather"),
      emoji("☁️", "云", "阴天", "天气", "cloud"),
      emoji("🌧️", "下雨", "雨天", "天气", "rain"),
      emoji("❄️", "雪花", "冬天", "冷", "snow"),
      emoji("🌈", "彩虹", "美好", "颜色", "rainbow"),
      emoji("🌙", "月亮", "晚安", "夜晚", "moon"),
      emoji("🌍", "地球", "世界", "全球", "earth"),
      emoji("🌱", "幼苗", "成长", "新生", "seedling"),
      emoji("🌿", "绿叶", "自然", "清新", "leaf"),
      emoji("🍀", "四叶草", "好运", "幸运", "clover"),
      emoji("🌸", "樱花", "春天", "漂亮", "flower"),
      emoji("🌻", "向日葵", "阳光", "花", "sunflower"),
      emoji("🐶", "小狗", "宠物", "可爱", "dog"),
      emoji("🐱", "小猫", "宠物", "可爱", "cat"),
      emoji("🐼", "熊猫", "可爱", "动物", "panda"),
      emoji("🐰", "兔子", "可爱", "动物", "rabbit"),
      emoji("🦊", "狐狸", "动物", "聪明", "fox"),
      emoji("🐳", "鲸鱼", "海洋", "动物", "whale"),
      emoji("🦋", "蝴蝶", "漂亮", "变化", "butterfly"),
      emoji("☕", "咖啡", "休息", "早上", "coffee"),
      emoji("🍵", "茶", "休息", "饮料", "tea"),
      emoji("🍺", "啤酒", "干杯", "聚会", "beer"),
      emoji("🍻", "碰杯", "干杯", "聚会", "cheers"),
      emoji("🍎", "苹果", "水果", "健康", "apple"),
      emoji("🍉", "西瓜", "夏天", "水果", "watermelon"),
      emoji("🍜", "面条", "吃饭", "美食", "noodles"),
      emoji("🍰", "蛋糕", "甜点", "庆祝", "cake"),
    ],
  },
];

const EMOJI_LOOKUP = new Map(
  EMOJI_CATEGORIES.flatMap((category) =>
    category.emojis.map((item) => [item.emoji, item] as const),
  ),
);

export function searchEmojis(keyword: string): EmojiItem[] {
  const normalizedKeyword = keyword.trim().toLocaleLowerCase();
  if (!normalizedKeyword) return [];
  return EMOJI_CATEGORIES.flatMap((category) => category.emojis).filter((item) =>
    [item.emoji, item.name, ...item.keywords].some((value) =>
      value.toLocaleLowerCase().includes(normalizedKeyword),
    ),
  );
}

export function loadRecentEmojis(): EmojiItem[] {
  if (typeof window === "undefined") return [];
  try {
    const stored = JSON.parse(window.localStorage.getItem(RECENT_EMOJI_STORAGE_KEY) ?? "[]");
    if (!Array.isArray(stored)) return [];
    return stored
      .filter((value): value is string => typeof value === "string")
      .map((value) => EMOJI_LOOKUP.get(value))
      .filter((item): item is EmojiItem => Boolean(item))
      .slice(0, MAX_RECENT_EMOJIS);
  } catch {
    return [];
  }
}

export function rememberRecentEmoji(selected: EmojiItem, current: EmojiItem[]): EmojiItem[] {
  const next = [selected, ...current.filter((item) => item.emoji !== selected.emoji)].slice(
    0,
    MAX_RECENT_EMOJIS,
  );
  try {
    window.localStorage.setItem(
      RECENT_EMOJI_STORAGE_KEY,
      JSON.stringify(next.map((item) => item.emoji)),
    );
  } catch {
    // 存储受限时仍允许当前页面继续使用最近表情。
  }
  return next;
}
