# -*- coding: utf-8 -*-
# 生成判题评测集 tests/fixtures/grading-eval.jsonl
# 每行一条金标准用例，标签（expected / cat）由人工明确指定，不依赖模型。
# 类别配比：positive(应判对) >=40%，hard-negative(应判错/易混) >=30%，literal(字面规范匹配) >=20%。
# 重新扩充用例后运行：python tools/gen_grading_eval.py

import json
import os

ROWS = []


def add(mode, cat, word, target, inp, expected, note=""):
    ROWS.append({
        "mode": mode,
        "cat": cat,
        "word": word,
        "target": target,
        "input": inp,
        "expected": expected,
        "note": note,
    })


# ============ A. en-to-zh positive：语义等价、字面不同（同义换述） ============
A = [
    ("probably", ["或许", "大概"], "也许"),
    ("abandon", ["抛弃", "放弃"], "舍弃"),
    ("abundant", ["丰富的", "充裕的"], "充足的"),
    ("accurate", ["精确的", "准确的"], "精准的"),
    ("acquire", ["获得", "取得"], "获取"),
    ("adequate", ["充足的", "适当的"], "足够的"),
    ("adjust", ["调整", "适应"], "调节"),
    ("admire", ["钦佩", "欣赏"], "佩服"),
    ("admit", ["承认", "准许进入"], "供认"),
    ("adopt", ["采用", "收养"], "采纳"),
    ("advocate", ["提倡", "拥护"], "倡导"),
    ("affect", ["影响"], "波及"),
    ("afford", ["买得起", "承担得起"], "负担得起"),
    ("aggressive", ["侵略的", "好斗的"], "有攻击性的"),
    ("aid", ["援助", "帮助"], "帮忙"),
    ("alter", ["改变", "更改"], "改动"),
    ("amaze", ["使惊奇"], "使惊讶"),
    ("amuse", ["逗乐", "娱乐"], "使开心"),
    ("analyze", ["分析"], "剖析"),
    ("ancient", ["古代的", "古老的"], "久远的"),
    ("announce", ["宣布", "通告"], "公布"),
    ("annual", ["每年的", "年度的"], "一年一度的"),
    ("anticipate", ["预期", "预料"], "预想"),
    ("anxious", ["焦虑的", "渴望的"], "焦急的"),
    ("apparent", ["明显的", "表面上的"], "显而易见的"),
    ("appeal", ["吸引", "呼吁", "上诉"], "恳求"),
    ("appear", ["出现", "显得"], "显现"),
    ("applaud", ["鼓掌", "称赞"], "拍手叫好"),
    ("appoint", ["任命", "约定"], "委任"),
    ("appreciate", ["欣赏", "感激", "领会"], "感谢"),
    ("approach", ["接近", "方法"], "靠近"),
    ("appropriate", ["适当的"], "恰当的"),
    ("arise", ["出现", "上升"], "产生"),
    ("arrange", ["安排", "整理"], "布置"),
    ("arrest", ["逮捕", "阻止"], "拘捕"),
    ("assemble", ["集合", "装配"], "聚集"),
    ("assess", ["评估", "估价"], "评定"),
    ("assign", ["分配", "指派"], "分派"),
    ("assist", ["帮助", "协助"], "援助"),
    ("associate", ["联系", "联想", "伙伴"], "联想到"),
    ("assume", ["假定", "承担"], "假设"),
    ("assure", ["保证", "使确信"], "担保"),
    ("attach", ["系", "附上", "依恋"], "附属"),
    ("attain", ["达到", "获得"], "达成"),
    ("attempt", ["尝试", "企图"], "试图"),
    ("attend", ["出席", "照料"], "参加"),
    ("attract", ["吸引"], "招引"),
    ("available", ["可获得的", "有空的"], "可使用的"),
    ("avoid", ["避免", "避开"], "躲开"),
    ("aware", ["意识到的"], "察觉到的"),
    ("awful", ["糟糕的", "可怕的"], "极差的"),
    ("awkward", ["尴尬的", "笨拙的"], "难为情的"),
    ("ban", ["禁止", "禁令"], "取缔"),
    ("bear", ["忍受", "生育"], "容忍"),
    ("behave", ["表现", "举止"], "行事"),
    ("beneficial", ["有益的"], "有好处的"),
    ("blame", ["责备", "归咎于"], "责怪"),
    ("boost", ["促进", "推动"], "拉升"),
    ("bother", ["打扰", "麻烦"], "打搅"),
    ("brilliant", ["杰出的", "灿烂的"], "出色的"),
    ("burden", ["负担", "使负重"], "重压"),
    ("calculate", ["计算", "估计"], "核算"),
    ("cancel", ["取消", "废除"], "撤销"),
    ("capacity", ["容量", "能力"], "容积"),
    ("cautious", ["谨慎的"], "小心的"),
    ("challenge", ["挑战", "质疑"], "考验"),
    ("characteristic", ["特征", "典型的"], "特点"),
    ("chase", ["追逐", "追赶"], "追捕"),
    ("cheat", ["欺骗", "作弊"], "蒙骗"),
    ("claim", ["声称", "要求", "索赔"], "宣称"),
    ("classify", ["分类", "归类"], "分门别类"),
    ("combine", ["结合", "联合"], "组合"),
    ("command", ["命令", "指挥"], "指令"),
    ("comment", ["评论", "议论"], "评价"),
    ("commit", ["犯罪", "承诺", "投入"], "投身"),
    ("communicate", ["交流", "传达"], "沟通"),
    ("compare", ["比较", "对比"], "比照"),
    ("compete", ["竞争", "比赛"], "比拼"),
    ("complain", ["抱怨", "投诉"], "发牢骚"),
    ("complex", ["复杂的", "综合体"], "繁杂的"),
    ("comprise", ["包含", "组成"], "构成"),
    ("concentrate", ["集中", "专心"], "专注"),
    ("concept", ["概念", "观念"], "理念"),
    ("concern", ["关心", "涉及", "担忧"], "挂念"),
    ("conclude", ["推断出", "结束"], "断定"),
    ("concrete", ["具体的", "混凝土"], "实在的"),
    ("conduct", ["实施", "指挥", "行为"], "开展"),
    ("confidence", ["信心", "信任"], "自信"),
    ("confirm", ["确认", "证实"], "核实"),
    ("conflict", ["冲突", "矛盾"], "抵触"),
    ("confront", ["面对", "对抗"], "直面"),
    ("confuse", ["使困惑", "混淆"], "搞混"),
    ("conscious", ["有意识的", "清醒的"], "清醒的"),
    ("consequence", ["结果", "后果"], "结局"),
    ("conservative", ["保守的", "守旧的"], "守旧的"),
    ("consider", ["考虑", "认为"], "斟酌"),
    ("consist", ["组成", "在于"], "由…构成"),
    ("constant", ["持续的", "恒定的"], "不间断的"),
    ("construct", ["建造", "构想"], "搭建"),
    ("consult", ["咨询", "查阅"], "请教"),
    ("consume", ["消耗", "消费"], "耗费"),
    ("contain", ["包含", "容纳"], "装有"),
    ("contemporary", ["当代的", "同时代的"], "现今的"),
    ("contest", ["竞赛", "争辩"], "赛事"),
    ("context", ["上下文", "背景"], "语境"),
    ("contradict", ["反驳", "与…矛盾"], "驳斥"),
    ("contribute", ["贡献", "促成", "投稿"], "捐助"),
    ("convince", ["使确信", "说服"], "劝服"),
    ("cooperate", ["合作", "协作"], "联手"),
    ("cope", ["应付", "处理"], "应对"),
    ("correspond", ["符合", "通信", "相应"], "信函往来"),
    ("create", ["创造", "创建"], "创立"),
    ("cultivate", ["培养", "耕作"], "培育"),
    ("damage", ["损害", "损坏"], "毁坏"),
    ("debate", ["辩论", "争论"], "争辩"),
    ("decay", ["腐烂", "衰退"], "腐败"),
    ("deceive", ["欺骗", "蒙蔽"], "哄骗"),
    ("decline", ["下降", "谢绝"], "下滑"),
    ("decrease", ["减少", "降低"], "缩减"),
    ("defend", ["防御", "辩护"], "守卫"),
    ("define", ["下定义", "界定"], "阐释"),
    ("delay", ["推迟", "延误"], "延后"),
    ("deliver", ["递送", "发表", "接生"], "运送"),
    ("demand", ["要求", "需求"], "索要"),
    ("demonstrate", ["证明", "演示", "示威"], "示范"),
    ("deny", ["否认", "拒绝给予"], "抵赖"),
    ("depart", ["离开", "出发"], "启程"),
    ("depend", ["依靠", "取决于"], "依仗"),
    ("depict", ["描绘", "描述"], "刻画"),
    ("evolve", ["演变", "进化", "发展"], "演化"),
]
for w, t, i in A:
    add("en-to-zh", "positive", w, t, i, "correct", "同义换述，语义等价字面不同")

# ============ B1. en-to-zh hard-negative：反义 / 否定 / 程度对立 ============
B1 = [
    ("probably", ["或许", "大概"], "肯定"),
    ("abandon", ["抛弃", "放弃"], "保留"),
    ("abundant", ["丰富的", "充裕的"], "稀缺的"),
    ("accurate", ["精确的", "准确的"], "错误的"),
    ("acquire", ["获得", "取得"], "失去"),
    ("adequate", ["充足的", "适当的"], "不足的"),
    ("admire", ["钦佩", "欣赏"], "鄙视"),
    ("adopt", ["采用", "收养"], "抛弃"),
    ("advance", ["进展", "进步", "前进"], "后退"),
    ("advantage", ["优势", "有利条件"], "劣势"),
    ("aggressive", ["侵略的", "好斗的"], "温顺的"),
    ("allow", ["允许", "准许"], "禁止"),
    ("ancient", ["古代的", "古老的"], "现代的"),
    ("appear", ["出现", "显得"], "消失"),
    ("approve", ["批准", "赞成"], "反对"),
    ("arrive", ["到达"], "出发"),
    ("attract", ["吸引"], "排斥"),
    ("aware", ["意识到的"], "没察觉"),
    ("beneficial", ["有益的"], "有害的"),
    ("blame", ["责备"], "表扬"),
    ("bright", ["明亮的", "聪明的"], "昏暗的"),
    ("calm", ["平静的", "镇静的"], "激动的"),
    ("cheap", ["便宜的"], "昂贵的"),
    ("combine", ["结合", "联合"], "分离"),
    ("complex", ["复杂的"], "简单的"),
    ("confirm", ["确认", "证实"], "否认"),
    ("connect", ["连接", "联系"], "断开"),
    ("conscious", ["有意识的", "清醒的"], "昏迷的"),
    ("construct", ["建造", "构想"], "拆除"),
    ("consume", ["消耗", "消费"], "生产"),
    ("increase", ["增加", "增长"], "减少"),
    ("defend", ["防御", "辩护"], "进攻"),
    ("delay", ["推迟", "延误"], "提前"),
    ("demand", ["要求", "需求"], "供给"),
    ("deny", ["否认", "拒绝"], "承认"),
    ("depend", ["依靠"], "独立"),
    ("destroy", ["破坏", "摧毁"], "保护"),
    ("encourage", ["鼓励", "鼓舞"], "打击"),
    ("expand", ["扩张", "膨胀"], "收缩"),
    ("export", ["出口", "输出"], "进口"),
    ("expose", ["暴露", "揭露"], "隐藏"),
    ("extend", ["延伸", "扩大"], "缩短"),
    ("forget", ["忘记"], "记住"),
    ("freeze", ["冻结", "结冰"], "融化"),
    ("gather", ["聚集", "收集"], "分散"),
    ("generous", ["慷慨的"], "吝啬的"),
    ("guilty", ["有罪的", "内疚的"], "无辜的"),
    ("humble", ["谦逊的", "卑微的"], "傲慢的"),
    ("import", ["进口", "输入"], "出口"),
    ("include", ["包含", "包括"], "排除"),
    ("inferior", ["低劣的", "下级的"], "优越的"),
    ("inner", ["内部的", "内心的"], "外部的"),
    ("junior", ["年少的", "下级的"], "年长的"),
    ("lazy", ["懒惰的"], "勤快的"),
    ("loose", ["松的", "宽松的"], "紧的"),
    ("loyal", ["忠诚的"], "背叛的"),
    ("mature", ["成熟的"], "幼稚的"),
    ("maximum", ["最大的", "最高的"], "最小的"),
    ("minor", ["较小的", "次要的"], "主要的"),
    ("negative", ["否定的", "消极的"], "积极的"),
]
for w, t, i in B1:
    add("en-to-zh", "hard-negative", w, t, i, "wrong", "反义/否定/程度对立")

# ============ B2. en-to-zh hard-negative：范畴偏移 / 动作-产物-人物混淆 ============
B2 = [
    ("computer", ["计算机", "电脑"], "计算器"),
    ("college", ["大学", "学院"], "大学生"),
    ("library", ["图书馆"], "图书"),
    ("restaurant", ["餐厅", "饭店"], "服务员"),
    ("hospital", ["医院"], "病人"),
    ("economy", ["经济"], "经济学家"),
    ("history", ["历史"], "历史学家"),
    ("philosophy", ["哲学"], "哲学家"),
    ("science", ["科学"], "科学家"),
    ("art", ["艺术", "美术"], "艺术家"),
    ("music", ["音乐"], "音乐家"),
    ("novel", ["小说"], "作家"),
    ("poem", ["诗", "诗歌"], "诗人"),
    ("bake", ["烘焙", "烤"], "面包"),
    ("paint", ["绘画", "油漆"], "画家"),
    ("teach", ["教", "教授"], "教材"),
    ("drive", ["驾驶"], "司机"),
    ("farm", ["农场", "耕作"], "农民"),
    ("fish", ["鱼", "钓鱼"], "渔夫"),
    ("cook", ["烹饪", "厨师"], "厨房"),
]
for w, t, i in B2:
    add("en-to-zh", "hard-negative", w, t, i, "wrong", "范畴偏移/动作-产物-人物混淆")

# ============ B3. en-to-zh hard-negative：无关词 ============
B3 = [
    ("probably", ["或许", "大概"], "香蕉"),
    ("happy", ["高兴的", "幸福的"], "桌子"),
    ("water", ["水"], "汽车"),
    ("book", ["书"], "天气"),
    ("school", ["学校"], "水果"),
    ("dog", ["狗"], "建筑"),
    ("sun", ["太阳"], "纸张"),
    ("tree", ["树"], "音乐"),
    ("car", ["汽车"], "颜色"),
    ("house", ["房子"], "动物"),
]
for w, t, i in B3:
    add("en-to-zh", "hard-negative", w, t, i, "wrong", "语义无关")

# ============ C. en-to-zh literal：字面规范匹配（含尾标点/首尾空格/另一义项） ============
C = [
    ("probably", ["或许", "大概"], "或许", ""),
    ("abandon", ["抛弃", "放弃"], "放弃", ""),
    ("space", ["外层空间", "太空", "空间"], "空间", ""),
    ("universe", ["宇宙", "领域", "体系"], "宇宙", ""),
    ("diverse", ["不同的", "多种多样的"], "多种多样的", ""),
    ("convert", ["转变", "转换"], "转变", ""),
    ("reverse", ["逆转", "相反的"], "逆转", ""),
    ("develop", ["开发", "发展"], "发展", ""),
    ("evolve", ["演变", "进化"], "进化", ""),
    ("involve", ["涉及", "包含"], "涉及", ""),
    ("improve", ["改进", "改善"], "改进", ""),
    ("approve", ["批准", "赞成"], "赞成", ""),
    ("enhance", ["提高", "增强"], "提高", ""),
    ("enable", ["使能够"], "使能够", ""),
    ("enlarge", ["扩大", "扩展"], "扩大", ""),
    ("form", ["形式", "表格"], "形式", ""),
    ("formal", ["正式的", "正规的"], "正式的", ""),
    ("reform", ["改革", "改善"], "改革", ""),
    ("perform", ["表演", "执行"], "表演", ""),
    ("inform", ["通知", "告知"], "通知", ""),
    ("abandon", ["抛弃", "放弃"], "抛弃。", "尾标点放行"),
    ("space", ["空间", "太空"], " 空间", "前导空格放行"),
    ("diverse", ["不同的", "多种多样的"], "不同的", "另一义项"),
    ("convert", ["转变", "转换"], "转换", "另一义项"),
    ("reverse", ["相反的", "反向的"], "相反的", "adj 义项"),
    ("develop", ["开发", "发展"], "开发", "另一义项"),
    ("involve", ["涉及", "包含"], "包含", "近义项"),
    ("improve", ["改进", "改善"], "改善", "另一字面"),
    ("approve", ["批准", "赞成"], "批准", "另一义项"),
    ("form", ["形式", "表格"], "表格", "n 另一义项"),
]
for w, t, i, note in C:
    add("en-to-zh", "literal", w, t, i, "correct", "字面规范匹配" + ("：" + note if note else ""))

# ============ D. zh-to-en literal：大小写/空格/标点/英美变体放行 ============
D = [
    ("space", ["space"], "Space"),
    ("space", ["space"], "SPACE"),
    ("space", ["space"], " space "),
    ("space", ["space"], "space."),
    ("space", ["space"], "space,"),
    ("color", ["color", "colour"], "colour"),
    ("color", ["color", "colour"], "Color"),
    ("program", ["program", "programme"], "programme"),
    ("program", ["program", "programme"], "Programme"),
    ("analyze", ["analyze", "analyse"], "analyse"),
    ("honor", ["honor", "honour"], "honour"),
    ("favor", ["favor", "favour"], "favour"),
    ("center", ["center", "centre"], "centre"),
    ("meter", ["meter", "metre"], "metre"),
    ("defense", ["defense", "defence"], "defence"),
    ("license", ["license", "licence"], "licence"),
    ("catalog", ["catalog", "catalogue"], "catalogue"),
    ("labor", ["labor", "labour"], "labour"),
    ("practice", ["practice", "practise"], "practise"),
    ("check", ["check", "cheque"], "cheque"),
    ("organize", ["organize", "organise"], "organise"),
    ("realize", ["realize", "realise"], "realise"),
    ("recognize", ["recognize", "recognise"], "recognise"),
    ("apologize", ["apologize", "apologise"], "apologise"),
    ("memorize", ["memorize", "memorise"], "memorise"),
    ("space", ["space"], "space"),
    ("universe", ["universe"], "Universe"),
    ("unite", ["unite"], "UNITE"),
    ("diverse", ["diverse"], "Diverse"),
    ("convert", ["convert"], "Convert"),
    ("develop", ["develop"], "Develop"),
    ("improve", ["improve"], "Improve"),
    ("approve", ["approve"], "Approve"),
    ("enhance", ["enhance"], "Enhance"),
    ("form", ["form"], "Form"),
    ("perform", ["perform"], "Perform"),
    ("inform", ["inform"], "Inform"),
    ("advance", ["advance"], "Advance"),
    ("involve", ["involve"], "Involve"),
    ("evolve", ["evolve"], "Evolve"),
    ("universe", ["universe"], " universe"),
    ("unite", ["unite"], "unite "),
    ("diverse", ["diverse"], "diverse."),
    ("convert", ["convert"], "Convert "),
    ("develop", ["develop"], "DEVELOP"),
    ("improve", ["improve"], " improve "),
    ("approve", ["approve"], "APPROVE"),
    ("enhance", ["enhance"], "enhance,"),
    ("form", ["form"], "Form."),
    ("perform", ["perform"], " perform "),
]
for w, t, i in D:
    add("zh-to-en", "literal", w, t, i, "correct", "大小写/空格/标点/英美变体放行")

# ============ E. zh-to-en hard-negative：错拼/漏字母/多字母/换位 ============
E = [
    ("apple", ["apple"], "appa"),
    ("apple", ["apple"], "appale"),
    ("apple", ["apple"], "app"),
    ("space", ["space"], "spac"),
    ("space", ["space"], "spacee"),
    ("space", ["space"], "spcae"),
    ("universe", ["universe"], "universee"),
    ("universe", ["universe"], "univese"),
    ("develop", ["develop"], "develp"),
    ("develop", ["develop"], "develope"),
    ("improve", ["improve"], "improv"),
    ("improve", ["improve"], "inprove"),
    ("convert", ["convert"], "conver"),
    ("convert", ["convert"], "convart"),
    ("perform", ["perform"], "perfom"),
    ("inform", ["inform"], "infrom"),
    ("advance", ["advance"], "advence"),
    ("involve", ["involve"], "involv"),
    ("approve", ["approve"], "aproove"),
    ("enhance", ["enhance"], "enhanc"),
]
for w, t, i in E:
    add("zh-to-en", "hard-negative", w, t, i, "wrong", "错拼/漏字母/多字母/换位")

# ============ 写盘 + 配比自检 ============
out_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tests", "fixtures")
os.makedirs(out_dir, exist_ok=True)
out_file = os.path.join(out_dir, "grading-eval.jsonl")

with open(out_file, "w", encoding="utf-8", newline="\n") as f:
    for idx, r in enumerate(ROWS, start=1):
        r = dict(r)
        r["id"] = "E%03d" % idx
        # 字段顺序固定，便于阅读与 diff
        ordered = {k: r[k] for k in ("id", "mode", "cat", "word", "target", "input", "expected", "note")}
        f.write(json.dumps(ordered, ensure_ascii=False) + "\n")

total = len(ROWS)
from collections import Counter
catc = Counter(r["cat"] for r in ROWS)
modec = Counter(r["mode"] for r in ROWS)
print("total:", total)
for k in ("positive", "hard-negative", "literal"):
    print("  %-13s %4d  %.1f%%" % (k, catc[k], 100.0 * catc[k] / total))
for k in ("en-to-zh", "zh-to-en"):
    print("  %-9s %4d" % (k, modec[k]))
print("written:", out_file)
