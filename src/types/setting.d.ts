// 全局设置类型定义

/// <reference path="./enums.ts" />

interface SettingsData {
  pronunciationType: PronunciationType;
  chineseCount: number;
  showAllMeanings: boolean;
  answerKey: string;
  playPronunciationKey: string;
  addToWordlistKey: string;
  addToFavoritesKey: string;
  addToFavoritesKeyInQuiz: string;
  addToErrorbookAfterShowAnswer: boolean;
  errorCorrectCount: number;
  autoPlayPronunciationAfterErrors: number;
  quizOrder: QuizOrder;
  quizWordCount: number;
  searchHistoryCount: number;
  enableEbbinghaus: boolean;
  quizMultiPartProbability: number;
  quizSinglePartProbability: number;
  dailyWordCount: number;
  quizMode?: QuizMode;
  wordSource?: WordSource;
  quizCount?: number;
  // 语义相似度模型开关：仅在「看英文写中文」(EnToZh) 模式下，当字符串匹配失败时调用本地模型兜底判断
  // 关闭后答错判定完全依赖字符串匹配，可减少 CPU 占用
  semanticSimilarityEnabled: boolean;
  // 答题时显示例句：目标词挖空为下划线，答对后在详细释义中展示完整例句
  showExampleInQuiz: boolean;
  // 中译英/拼写时逐字符辅助着色：正确前缀绿色、从首个错误位起红色
  assistSpelling: boolean;
  // 词书派生词开关：开启后《英语四级·你还在背单词吗》每个主词的派生词作为独立词条一并练习
  includeDerivations: boolean;
  // 学段（首次进入弹窗选择，可在设置页修改；影响默认词库与难度）
  grade: GradeLevel;
  // 复习调度算法：固定艾宾浩斯间隔（ebbinghaus）或 ts-fsrs 概率调度（fsrs）
  scheduler: SchedulerAlgo;
  // FSRS 期望保留率（0~1，到期时能回忆出的目标比例；默认 0.9，越高间隔越短、每日复习越多）
  fsrsRequestRetention: number;
  // FSRS 负载均衡（fuzz）：给间隔加随机抖动，把同一天到期的词摊开，避免爆发日（默认开）
  fsrsFuzzing: boolean;
  // 判题日志：全本地记录每次判题的输入/判定明细，供评测集采样与阈值标定（默认开）
  gradingLogEnabled: boolean;
}