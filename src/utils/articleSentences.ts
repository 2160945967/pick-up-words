// 文章练习：把阅读题原始段落（含全角括号中文注释、内嵌中文）清洗为纯英文句子序列。
// 全部为纯函数，便于单元测试，不依赖 DOM。

// 占位符：临时替换缩写/小数里的句点，避免被误判为句末。私有区 U+E000，正常文本不会出现。
const DOT_PLACEHOLDER = '';

// 常见英文缩写（点不是句末）；小写匹配，覆盖句首大写场景
const ABBREVIATIONS = [
    'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc',
    'e.g', 'i.e', 'u.s', 'u.k', 'a.m', 'p.m', 'no', 'vol', 'fig',
];

// 含 CJK 字符的括号注释（全角/半角），如 amphipods（端足类动物）
const CJK_PAREN_RE = /[（(][^（）()]*[一-鿿][^（）()]*[）)]/g;
// 全角括号但内容无汉字（通常是英文术语），去掉括号保留内容
const FW_EN_PAREN_RE = /（([^（）]*)）/g;
// 括号外的内嵌中文（数据质量问题，如 become高风险 when）
const INLINE_CJK_RE = /[一-鿿]+/g;

/**
 * 清洗一段文本：
 * 1) 删除含汉字的括号注释（补空格，避免相邻单词粘连）；
 * 2) 全角括号内为英文的，去括号保留英文；
 * 3) 删除残留的内嵌中文。
 */
export function stripCjkParentheses(text: string): string {
    if (!text) return '';
    let out = text;
    // 嵌套/相邻时多跑几轮直到稳定
    for (let i = 0; i < 5; i++) {
        const next = out.replace(CJK_PAREN_RE, ' ');
        if (next === out) break;
        out = next;
    }
    // 剩余全角括号（英文内容）去括号保留
    for (let i = 0; i < 5; i++) {
        const next = out.replace(FW_EN_PAREN_RE, ' $1 ');
        if (next === out) break;
        out = next;
    }
    // 内嵌中文整体替换为空格
    out = out.replace(INLINE_CJK_RE, ' ');
    // 折叠本函数产生的多余空白，返回干净文本（句末标点空格在切句阶段处理）
    return out.replace(/\s+/g, ' ').trim();
}

/** 折叠连续空白为单个空格并去掉首尾空白；同时去掉标点前多余空格 */
function normalizeSpaces(text: string): string {
    return text
        .replace(/\s+/g, ' ')
        .replace(/\s+([.!?,;:])/g, '$1')
        .trim();
}

/** 把缩写与小数中的句点替换为占位符，防止误切 */
function protectDots(text: string): string {
    let out = text;
    for (const ab of ABBREVIATIONS) {
        const re = new RegExp(ab.replace(/\./g, '\\.') + '\\.', 'gi');
        // 匹配串内部可能含点（如 e.g. / i.e.），需把其中所有点都保护，不能只替换结尾点
        out = out.replace(re, (m) => m.replace(/\./g, DOT_PLACEHOLDER));
    }
    // 小数：数字 . 数字（如 3.14）
    out = out.replace(/(\d)\.(?=\d)/g, `$1${DOT_PLACEHOLDER}`);
    return out;
}

/** 还原占位符为真实句点 */
function restoreDots(text: string): string {
    return text.split(DOT_PLACEHOLDER).join('.');
}

/**
 * 把一段已清洗的纯英文文本切分为句子。
 * 句末标点 . ! ?（可连续、可带收尾引号/括号）后跟空白或文本结束。
 */
export function splitSentences(text: string): string[] {
    const clean = normalizeSpaces(text);
    if (!clean) return [];
    const protectedText = protectDots(clean);

    const parts: string[] = [];
    const re = /[^.!?]+[.!?]+["'”’\)\]]?\s*/g;
    let m: RegExpExecArray | null;
    let lastIndex = 0;
    while ((m = re.exec(protectedText)) !== null) {
        parts.push(m[0]);
        lastIndex = re.lastIndex;
    }
    // 无句末标点的尾部片段
    if (lastIndex < protectedText.length) {
        parts.push(protectedText.slice(lastIndex));
    }

    return parts
        .map((s) => normalizeSpaces(restoreDots(s)))
        .filter((s) => s.length > 0);
}

/** 判断是否为含足够拉丁字母的英文句子（过滤纯中文/纯标点片段） */
function isEnglishSentence(s: string): boolean {
    return (s.match(/[a-zA-Z]/g) || []).length >= 3;
}

/**
 * 从一篇文章的原始段落数组构建纯英文句子列表。
 * 纯中文文章（无英文句子）返回空数组，由调用方提示不适合英文练习。
 * @param paragraphs 阅读 JSON 的 p 字段（含中文注释）
 */
export function buildArticleSentences(paragraphs: string[]): string[] {
    if (!Array.isArray(paragraphs)) return [];
    const raw = paragraphs.map((p) => p || '').join(' ');
    // 整篇级判断：原始文本中汉字数超过拉丁字母数，视为中文文章，不适合英文练习
    const cjkCount = (raw.match(/[一-鿿]/g) || []).length;
    const latinCount = (raw.match(/[a-zA-Z]/g) || []).length;
    if (cjkCount > latinCount) return [];

    const joined = stripCjkParentheses(raw);
    return splitSentences(joined).filter(isEnglishSentence);
}
