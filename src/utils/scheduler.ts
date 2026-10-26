// FSRS 调度封装：基于官方 ts-fsrs（纯 TypeScript、本地运行、无需服务器）
// 复用 learningHistory：每个词的 FSRS Card 以可 JSON 序列化形式存在 learningHistory[word].card
// 与固定艾宾浩斯并存，由 settings.scheduler 切换；历史 correctCount/errorCount 不丢弃

import {
    fsrs,
    createEmptyCard,
    generatorParameters,
    forgetting_curve,
    Rating,
    type Card,
    type Grade,
} from 'ts-fsrs';

export type FsrsGrade = 'again' | 'hard' | 'good' | 'easy';

const f = fsrs();
const DEFAULT_PARAMS = generatorParameters();

/** FSRS 可调参数（来自设置）：期望保留率 0~1、是否开启 fuzz 负载均衡 */
export interface FsrsConfig {
    requestRetention: number;
    fuzzing: boolean;
}

/** 校正期望保留率到合理区间（FSRS 允许 0.7~0.99；超出则回退默认 0.9） */
export function normalizeRetention(r: unknown): number {
    const n = Number(r);
    if (!Number.isFinite(n) || n < 0.7 || n > 0.99) return 0.9;
    return Math.round(n * 100) / 100;
}

/** 按设置构建 FSRS 实例：透传 request_retention 与 enable_fuzzing（其余参数用默认） */
function makeFsrs(config?: Partial<FsrsConfig>) {
    const request_retention = normalizeRetention(config?.requestRetention ?? DEFAULT_PARAMS.request_retention);
    const enable_fuzz = config?.fuzzing ?? false;
    return fsrs(generatorParameters({ request_retention, enable_fuzz }));
}

const GRADE_RATING: Record<FsrsGrade, Grade> = {
    again: Rating.Again,
    hard: Rating.Hard,
    good: Rating.Good,
    easy: Rating.Easy,
};

export interface GradeDecisionInput {
    isCorrect: boolean;
    /** 本轮（该词本次出现）此前的错误次数，来自会话 errorCount */
    errorCountThisRound: number;
    /** 该卡历史复习次数 reps（无卡为 undefined） */
    oldReps?: number;
}

/**
 * 把本次作答表现映射为 FSRS 四级评分（纯函数，集中评分口径）：
 * 答错（含主动看答案）→ again；本轮错过后才答对 → hard；
 * 一次答对且该卡已复习 ≥3 次（成熟卡仍秒答）→ easy；其余一次答对 → good。
 */
export function decideFsrsGrade(input: GradeDecisionInput): FsrsGrade {
    if (!input.isCorrect) return 'again';
    if (input.errorCountThisRound > 0) return 'hard';
    if (typeof input.oldReps === 'number' && input.oldReps >= 3) return 'easy';
    return 'good';
}

/** 可 JSON 序列化的 Card（Date 字段已转毫秒时间戳） */
export type SerializedCard = Record<string, unknown>;

/** Card 序列化为纯对象：due / last_review 转毫秒 */
export function serializeCard(card: Card): SerializedCard {
    return {
        ...card,
        due: card.due.getTime(),
        last_review: card.last_review ? card.last_review.getTime() : null,
    };
}

/** 把序列化对象还原为可用 Card（时间戳转回 Date）；无卡则给一张空卡 */
function reviveCard(raw: SerializedCard | undefined, now: number): Card {
    if (!raw) return createEmptyCard(new Date(now));
    return {
        ...raw,
        due: new Date(raw.due as number),
        last_review: raw.last_review ? new Date(raw.last_review as number) : undefined,
    } as Card;
}

export interface FsrsResult {
    card: SerializedCard;
    nextReviewTime: number;
    stability: number;
    difficulty: number;
    state: number;
    scheduledDays: number;
}

/**
 * 纯计算：给定某词已存 Card（序列化，可为空）与本次评分，
 * 返回新 Card（序列化）与下次复习时间。不读写 localStorage。
 */
export function computeFsrs(
    cardRaw: SerializedCard | undefined,
    grade: FsrsGrade,
    now: number = Date.now(),
    config?: Partial<FsrsConfig>,
): FsrsResult {
    const engine = makeFsrs(config);
    const card = reviveCard(cardRaw, now);
    const { card: next } = engine.next(card, new Date(now), GRADE_RATING[grade]);
    return {
        card: serializeCard(next),
        nextReviewTime: next.due.getTime(),
        stability: next.stability,
        difficulty: next.difficulty,
        state: next.state as unknown as number,
        scheduledDays: next.scheduled_days,
    };
}

/** 某词当前的可提取度 R（0~1）；无卡返回 null */
export function getCardRetrievability(cardRaw: SerializedCard | undefined, now: number = Date.now()): number | null {
    if (!cardRaw) return null;
    try {
        return f.get_retrievability(reviveCard(cardRaw, now), new Date(now), false) as number;
    } catch {
        return null;
    }
}

/**
 * FSRS 遗忘曲线 R(t | S)：距上次复习 t 天、稳定度 S 时的回忆概率（0~1）
 * 用默认参数（request_retention=0.9）计算，供可视化绘制曲线
 */
export function curveRetention(elapsedDays: number, stability: number): number {
    const r = forgetting_curve(DEFAULT_PARAMS.w, elapsedDays, stability);
    return Math.max(0, Math.min(1, r));
}

/** 单例 FSRS 默认目标记忆率（0~1） */
export const FSRS_TARGET_RETENTION = DEFAULT_PARAMS.request_retention;
