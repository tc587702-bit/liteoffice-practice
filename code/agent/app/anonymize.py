"""
语料脱敏：把知识库文本里的个人敏感信息替换为占位符。

为什么需要：项目要把知识库部署到云服务器，而 gongwen 库里有一份
真实村民的经济补偿申请（含姓名、年龄、身份证号、村社住址、已故父亲姓名）。
上云前必须脱敏，否则个人信息进入外部服务器后可能被日志、快照、运维渠道留存。

扫描实测（2486 块 / 77 份文档）的真实分布：
  真 PII     身份证号 1 处、手机号 1 处、机构联系人姓名 2 处、资金专户账号 1 处
  可接受     高校教师公开邮箱 24 处、机构公开固话 18 处（仍统一脱敏，RAG 不需要联系方式）
  纯误报     「疑似银行卡号」6 处实为 DOI 号（10.1017/S0022226700012949）
             「人名」30 处中多数是「直达」「七十岁的」「处多年的」被称谓规则误匹配

设计要点：
  1. 宁可漏报不可误伤语料：DOI、年份、金额、条号等数字串必须排除
  2. 人名用「种子扩散法」而非姓名字典 —— 先从高置信上下文取种子名，
     再在该文档内全局替换。字典法在中文里误报率极高（会把机构名、地名当人名）。
  3. 每条规则都给掩码样例，便于人工抽查是否误伤
"""
from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass

# ---------------------------------------------------------------- 占位符

MASK_ID = "[身份证号]"
MASK_PHONE = "[手机号]"
MASK_TEL = "[联系电话]"
MASK_EMAIL = "[邮箱]"
MASK_ACCOUNT = "[银行账号]"
MASK_ADDR = "[住址]"


# ---------------------------------------------------------------- 规则

# 身份证号：18 位（含出生日期与校验位约束）与 15 位老证
ID18 = re.compile(
    r"(?<!\d)"
    r"[1-9]\d{5}"
    r"(?:19|20)\d{2}"
    r"(?:0[1-9]|1[0-2])"
    r"(?:0[1-9]|[12]\d|3[01])"
    r"\d{3}[\dXx]"
    r"(?!\d)"
)
ID15 = re.compile(
    r"(?<!\d)"
    r"[1-9]\d{5}"
    r"\d{2}"
    r"(?:0[1-9]|1[0-2])"
    r"(?:0[1-9]|[12]\d|3[01])"
    r"\d{3}"
    r"(?!\d)"
)

# 手机号：1[3-9] 开头 11 位
PHONE = re.compile(r"(?<!\d)1[3-9]\d{9}(?!\d)")

# 固定电话：区号 + 号码（允许 - 或空格分隔）
TEL = re.compile(r"(?<!\d)0\d{2,3}[-\s]?\d{7,8}(?!\d)")

# 邮箱
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")

# 银行/资金账号：12–19 位连续数字，且上下文必须出现账号类词。
# 加上下文约束是因为纯长度匹配会命中 DOI、订单号等 —— 实测 6 处「银行卡」全是 DOI。
ACCOUNT_CTX = re.compile(r"(?:账号|账户|帐号|开户行|银行卡号|收款账户|专户)")
ACCOUNT_NUM = re.compile(r"(?<![\dXx/.-])\d{12,19}(?![\dXx/.-])")

# DOI / 版本号 / 条号等「长得像账号但不是账号」的排除模式
NOT_ACCOUNT = re.compile(
    r"(?:doi|DOI|10\.\d{4,}|ISBN|issn|ISSN|第\s*\d+\s*条|\d{4}\s*年|版本|v\d+\.\d+)"
)

# 个人住址：必须精确到「社/组/队/号/栋/单元/室」这一级才算可识别信息。
#
# 三处收紧都是演练实测逼出来的，缺一不可：
#   ① 单位后缀必需 —— 否则《分界镇优化村居财务管理的实施意见》会被改成
#      《[住址]居财务管理的实施意见》（行政区划名是公开信息，不是 PII）
#   ② 前面必须是边界字符且原样写回 —— 否则「该项目主要涉及徐家堰村5社」会被
#      整体吞掉，变成「该项[住址]」，动词短语凭空消失
#   ③ 村名首字不能是虚词/动词 —— 否则同一句会从「涉」开始匹配，把「及」当成
#      村名的一部分吞掉，输出「主要涉[住址]」，动词被劈开
ADDR_PRE = "，。；、：:；！？\\s（）()《》系在住址于到属及至为是有和与从即共涉及"

# 村名首字黑名单：虚词与常见动词/介词。
# 这些字可以作前置边界（原样保留），但不能作村名首字（否则会被吞进 [住址]）。
# 常见村名首字是姓氏与方位字（王/李/徐/东/西/大/新/金/石…），都不在此表，
# 所以这处收紧只会漏掉极罕见的村名，换来的是语料不被破坏 —— 符合本模块
# 「宁可漏报不可误伤」的原则。
VILLAGE_NAME_NOT_START = "及涉至为是有和与从即共在到属于系的了或但而又"

ADDR = re.compile(
    rf"(?P<pre>[{ADDR_PRE}]|镇|乡|街道|^)"
    r"(?:[\u4e00-\u9fa5]{2,6}(?:镇|乡|街道))?"
    rf"(?![{VILLAGE_NAME_NOT_START}])"
    r"[\u4e00-\u9fa5]{1,6}(?:村|社区|屯|寨)"
    r"\d{1,3}\s*(?:社|组|队|号|栋|单元|室)"
)

# 住址占位符后紧跟的户主姓名：「[住址]徐文平家的」「[住址]王某户」
# 必须在 ADDR 替换之后执行，因为它匹配的是 [住址] 这个占位符而不是原始地址。
# 姓氏用常见百家姓收窄，避免把「[住址]附近的」「[住址]东侧的」这类方位描述误当人名。
NAME_AFTER_ADDR = re.compile(
    # re.escape() 是函数调用，不能与字符串字面量隐式拼接，必须显式 +
    re.escape(MASK_ADDR)
    + r"(?:[王李张刘陈杨黄赵周吴徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾肖田董袁潘"
    r"蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛])"
    r"[\u4e00-\u9fa5]{1,2}"
    r"(?=家|户|等\d|一家|夫妇|本人|同志)"
)

# 人名种子：高置信上下文（带身份标签的冒号后 2–3 字）
#
# 标签分两组：
#   ① 法律/公务身份 —— 申请人、原告、联系人等
#   ② 亲属称谓 —— 父亲、母亲、配偶等
# 第②组是补漏：实测「申请人张禄（父亲：张文兴已故）」中，已故父亲姓名
# 与当事人关系同属可识别个人信息，只收第①组会漏掉它。
#
# 边界用「正向白名单」而非「负向排除」：
#   原写法 (?![\u4e00-\u9fa5]{2,}) 在中文里不成立 —— 名字后面直接跟汉字是常态
#   （「张文兴已故」「张禄系村民」），负向断言要么漏报、要么贪婪多吃一个字
#   （实测把「张文兴已」当成名字）。
#   改为：名字后必须紧跟标点/空白/行尾，或「已故/系/男/女」等固定接续词。
#   这样「负责人王珺带领团队」会因为「带」不在白名单而被正确拒绝。
NAME_SEED_CTX = re.compile(
    r"(?:申请人|被申请人|原告|被告|上诉人|被上诉人|当事人|联系人|负责人|"
    r"承办人|举报人|信访人|法定代表人|委托代理人|监护人|"
    r"父亲|母亲|父|母|配偶|丈夫|妻子|儿子|女儿|兄|弟|姐|妹)"
    r"\s*[：:]\s*"
    r"([\u4e00-\u9fa5]{2,3})"
    r"(?=[，。；、：:（）()\s]|已故|系|男|女|现年|今年|$)"
)

# 种子名后的排除词：这些是称谓/量词误匹配，不是人名
NAME_STOPWORDS = {
    "有关", "相关", "本人", "我方", "贵方", "该同", "同志", "直达", "直接",
    "七十", "八十", "九十", "处多", "多年", "全体", "各方", "双方", "三方",
}


@dataclass
class MaskResult:
    text: str
    hits: Counter
    names: list[str]


def _mask_account(text: str) -> tuple[str, int]:
    """
    掩码银行账号：必须同时满足「有账号类上下文」+「数字串不在 DOI/条号等模式中」。
    """
    if not ACCOUNT_CTX.search(text):
        return text, 0

    count = 0
    for m in list(ACCOUNT_NUM.finditer(text)):
        # 取数字前后各 40 字判断是否为 DOI/年份/条号
        window = text[max(0, m.start() - 40): min(len(text), m.end() + 40)]
        if NOT_ACCOUNT.search(window):
            continue
        # 已确认该数字不是 DOI 等，但还要确认它紧邻账号类词（同句内）
        sentence_start = max(text.rfind(c, 0, m.start()) for c in "。；;\n")
        sentence = text[sentence_start + 1: m.end() + 20]
        if not ACCOUNT_CTX.search(sentence):
            continue
        count += 1

    if count == 0:
        return text, 0

    # 第二次遍历执行替换（从后往前，避免位移）
    out = text
    for m in reversed(list(ACCOUNT_NUM.finditer(text))):
        window = text[max(0, m.start() - 40): min(len(text), m.end() + 40)]
        if NOT_ACCOUNT.search(window):
            continue
        sentence_start = max(text.rfind(c, 0, m.start()) for c in "。；;\n")
        sentence = text[sentence_start + 1: m.end() + 20]
        if not ACCOUNT_CTX.search(sentence):
            continue
        out = out[: m.start()] + MASK_ACCOUNT + out[m.end():]
    return out, count


def _extract_seed_names(text: str) -> list[str]:
    """
    从高置信上下文提取人名种子。

    只信「申请人：张三」「联系人：李四」这类带身份标签的形式，
    不信「张三同志」这类称谓后缀 —— 实测后者会把「直达」「七十岁的」当人名。
    """
    names: list[str] = []
    for m in NAME_SEED_CTX.finditer(text):
        cand = m.group(1)
        if cand in NAME_STOPWORDS:
            continue
        if cand not in names:
            names.append(cand)
    return names


def mask_text(text: str, mask_names: bool = True, mask_contact: bool = True) -> MaskResult:
    """
    对一段文本做全量脱敏。

    mask_names   ：是否替换人名（种子扩散法）
    mask_contact ：是否替换邮箱/固话（机构公开联系方式，RAG 不需要，默认也脱敏）

    返回替换后的文本、各类命中计数、以及识别出的人名列表（供人工抽查）。
    """
    hits: Counter = Counter()
    out = text or ""
    if not out.strip():
        return MaskResult(out, hits, [])

    # 顺序有讲究：先长模式（身份证 18 位）再短模式（手机号 11 位），
    # 否则手机号会先吃掉身份证号的中间片段。
    out, n = ID18.subn(MASK_ID, out)
    hits["身份证号"] += n
    out, n = ID15.subn(MASK_ID, out)
    hits["身份证号(15位)"] += n

    out, n = PHONE.subn(MASK_PHONE, out)
    hits["手机号"] += n

    out, n = _mask_account(out)
    hits["银行账号"] += n

    # 住址：pre 是边界字符（标点/介词/镇乡街道），必须原样写回，
    # 否则「该项目主要涉及徐家堰村5社」会被整体吞成「该项[住址]」。
    out, n = ADDR.subn(lambda m: m.group("pre") + MASK_ADDR, out)
    hits["住址"] += n

    # 住址后紧跟的户主姓名：「涉及[住址]徐文平家的」→「涉及[住址][姓名]家的」
    #
    # 为什么必须锚定住址：全库扫「姓+名+家」会命中 135 处，实测绝大多数是误报 ——
    #   · legal 库 123 处是法院已脱敏格式（戴某1、白某某），不能二次处理
    #   · essay_narr 7 处是文学作品（马孔多居民、李驼背家）
    #   · thesis 2 处是论文作者，属公开信息
    # 真正需要脱敏的是公文里绑定到具体住址的村民姓名。用 [住址] 做锚点，
    # 精度足够且天然避开上述三类误报。此规则必须在 ADDR 替换之后执行。
    out, n = NAME_AFTER_ADDR.subn(MASK_ADDR + "[姓名]", out)
    hits["住址关联人名"] += n

    if mask_contact:
        out, n = EMAIL.subn(MASK_EMAIL, out)
        hits["邮箱"] += n
        out, n = TEL.subn(MASK_TEL, out)
        hits["固定电话"] += n

    names = _extract_seed_names(text)  # 用原文提取，避免被前面的替换破坏上下文
    if mask_names and names:
        for name in names:
            cnt = out.count(name)
            if cnt:
                out = out.replace(name, "[姓名]")
                hits["人名"] += cnt

    return MaskResult(out, hits, names)


def scan_text(text: str) -> dict[str, int]:
    """只扫描不修改，返回各类 PII 命中数（供报告与自检用）"""
    r = mask_text(text)
    return {k: v for k, v in r.hits.items() if v}


def has_pii(text: str) -> bool:
    return bool(scan_text(text))


# ---------------------------------------------------------------- 自测

def _selftest() -> int:
    """用真实结构的合成样本验证：真 PII 全部命中，且不误伤 DOI/金额/条号。"""
    fails: list[str] = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  {detail}" if detail else ""))
        if not ok:
            fails.append(name)

    print("\n=== 1) 身份证号 ===")
    src = "申请人：张某，男，45岁，身份证号码：510902197903275392，系某镇某村村民。"
    r = mask_text(src)
    check("18 位身份证被替换", "510902197903275392" not in r.text and MASK_ID in r.text, r.text[:70])
    check("命中计数为 1", r.hits["身份证号"] == 1, str(dict(r.hits)))
    check("不误伤 15 位规则", r.hits["身份证号(15位)"] == 0)
    r15 = mask_text("证件号：510902790327532")
    check("15 位老证被替换", MASK_ID in r15.text, r15.text[:50])

    print("\n=== 2) 手机号 ===")
    r = mask_text("（联系人：王某；联系电话；13778702214）")
    check("手机号被替换", "13778702214" not in r.text and MASK_PHONE in r.text, r.text[:60])
    check("不误伤 10 位数字", mask_text("编号 1377870221").text == "编号 1377870221")
    check("不误伤 12 位数字", mask_text("编号 137787022145").hits["手机号"] == 0)

    print("\n=== 3) 银行账号（关键：不误伤 DOI）===")
    doi = "Journal of Linguistics, 1967, 3(1):37-81. doi: 10.1017/S0022226700012949 [48]"
    r = mask_text(doi)
    check("DOI 不被当账号", "0022226700012949" in r.text and MASK_ACCOUNT not in r.text, r.text[:60])
    acct = "遂宁高新段征地拆迁资金专户 账号：505003294300018 开户行：遂宁银行高新支行"
    r = mask_text(acct)
    check("资金专户账号被替换", "505003294300018" not in r.text and MASK_ACCOUNT in r.text, r.text[:60])
    check("无账号上下文时不替换长数字", mask_text("编号 505003294300018").hits["银行账号"] == 0)

    print("\n=== 4) 联系方式 ===")
    r = mask_text("负责人 Tel：021-31243528 Email：jun_wang@fudan.edu.cn")
    check("固话被替换", "021-31243528" not in r.text and MASK_TEL in r.text, r.text[:60])
    check("邮箱被替换", "jun_wang@fudan.edu.cn" not in r.text and MASK_EMAIL in r.text)
    r2 = mask_text("Tel：021-31243528", mask_contact=False)
    check("关闭联系方式脱敏时保留", "021-31243528" in r2.text)

    print("\n=== 5) 住址 ===")
    r = mask_text("系会龙镇花亭村8社村民，多年来居住于此。")
    check("村社级住址被替换", "花亭村8社" not in r.text and MASK_ADDR in r.text, r.text[:60])
    check("不误伤普通地名", mask_text("遂宁市船山区城乡统筹发展服务中心").hits["住址"] == 0)
    # 演练实测抓到的误报：行政区划名 + 政策文件名被当成住址，会把语料改坏
    fp_addr = "出台《分界镇优化村居财务管理的实施意见》，配套制定村居集体用工管理办法。"
    r_fp = mask_text(fp_addr)
    check("不误伤「镇+村居」政策文件名（演练实测误报）",
          r_fp.text == fp_addr and r_fp.hits["住址"] == 0, r_fp.text[:60])
    check("不误伤纯行政区划名", mask_text("船山区人民政府关于征地拆迁的通知").hits["住址"] == 0)
    check("精确到组的住址仍被识别", MASK_ADDR in mask_text("居住在某某村3组").text)
    # 演练实测抓到的第二个误报：动词「涉及」被劈开成「涉[住址]」，语义被毁
    verb = "韶华桥建设项目，该项目主要涉及徐家堰村5社徐文平家的再生资源回收补偿工作。"
    r_verb = mask_text(verb)
    check("住址被脱敏且动词完整（演练实测误报）",
          "徐家堰村5社" not in r_verb.text and "主要涉及" in r_verb.text,
          r_verb.text[:70])
    check("不误吞「及」字", "涉[" not in r_verb.text, r_verb.text[:70])
    # 住址后紧跟的户主姓名：种子扩散法抓不到（无身份标签），靠 [住址] 锚点补
    check("住址后户主姓名被脱敏（实测漏报）",
          "徐文平" not in r_verb.text and "[住址][姓名]家" in r_verb.text, r_verb.text[:70])
    # 锚点必须精确：住址后的方位描述不能被当人名
    r_dir = mask_text("补偿款发放到某某村3组附近的临时安置点")
    check("住址后方位词不被误当人名", r_dir.hits.get("住址关联人名", 0) == 0, r_dir.text[:60])
    # 法院已脱敏格式不能被二次处理
    r_court = mask_text("祝某某诉戴某1、白某某、戴某2婚约财产纠纷案，判决如下")
    check("不误伤法院已脱敏文本", "祝某某" in r_court.text and "戴某1" in r_court.text, r_court.text[:60])

    print("\n=== 6) 人名种子扩散（关键：不误伤）===")
    r = mask_text("申请人：张禄，男，45岁。多年来，申请人张禄（父亲：张文兴已故）已多次反映。")
    check("种子名被提取", "张禄" in r.names and "张文兴" in r.names, str(r.names))
    check("当事人所有出现都被替换", "张禄" not in r.text, r.text[:80])
    check("亲属称谓后的姓名也被脱敏（补漏）", "张文兴" not in r.text and r.text.count("[姓名]") >= 3, r.text[:80])
    r_only_label = mask_text("负责人王珺带领团队完成了实验。")
    check("无冒号身份标签时不猜测人名", r_only_label.names == [] and "王珺" in r_only_label.text,
          "只信带冒号的身份标签，避免把机构名/普通名词误当人名")

    print("\n=== 7) 误报防护（实测踩过的坑）===")
    fp = "这项工作直达基层，七十岁的老人处多年的难题终于解决。"
    r = mask_text(fp)
    check("「直达」不被当人名", "直达" in r.text and r.names == [], str(r.names))
    check("「七十岁的」不被当人名", "七十岁" in r.text)
    r2 = mask_text("联系人：有关；负责人：本人")
    check("停用词被排除", r2.names == [], str(r2.names))

    print("\n=== 8) 不误伤公文正常内容 ===")
    normal = ("关于安置房建设和拆迁安置工作有关情况的汇报：一、项目建设基本情况。"
              "2024年8月7日，涉及资金120万元，第一条规定，遂府函（2024）218号文件。")
    r = mask_text(normal)
    check("正常公文零命中", sum(r.hits.values()) == 0, str(dict(r.hits)))
    check("文本完全不变", r.text == normal)

    print("\n=== 9) 幂等性（重复脱敏不叠加占位符）===")
    once = mask_text("身份证号码：510902197903275392").text
    twice = mask_text(once).text
    check("二次脱敏结果不变", once == twice, twice[:50])

    print("\n=== 10) 边界输入 ===")
    check("空字符串不崩", mask_text("").text == "")
    check("None 不崩", mask_text(None).text == "")
    check("纯空白不崩", mask_text("   \n  ").text == "   \n  ")

    print(f"\n结果：{'全部通过' if not fails else f'失败 {len(fails)} 项：' + '、'.join(fails)}")
    return len(fails)


if __name__ == "__main__":
    raise SystemExit(1 if _selftest() else 0)
