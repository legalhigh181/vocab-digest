/**
 * 词表种子：首次运行时生成 data/ 下的默认词表骨架。
 *
 * 已经存在的文件一律不覆盖 —— 用户自己维护的内容最高优先级。
 * 初始内容是「够用的最小集」，用户可随时在 data/ 里自己改。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 停用词：功能词 + 弹幕高频噪声 */
export const STOPWORDS = `# 停用词表：一行一个，# 开头为注释。这些词不会进入词汇正文。
a an the
and or but nor so yet
of in on at to for from by with about against between into through during before after above below
up down out off over under again further then once here there when where why how all any both each
few more most other some such no not only own same than too very
i me my myself we our ours ourselves you your yours yourself yourselves he him his himself she her hers
herself it its itself they them their theirs themselves
am is are was were be been being
have has had having
do does did doing done
will would shall should can could may might must ought
this that these those what which who whom whose
if as because while though although unless until since
also just even still ever never always often sometimes usually rather quite almost enough
get got make made take took taken go went gone come came see saw seen know knew known think thought
say said tell told want wanted like liked need needed use used keep kept put going gonna wanna
yeah yep ok okay oh ah um uh er hmm wow hey hi hello bye please thanks thank sorry yes no
lol lmao rofl wtf omg btw imo tbh idk idc bilibili up av bv
good great nice cool fine bad really very much many lot lots little bit kind sort thing things way ways
one two three four five six seven eight nine ten first second third
`

/** 基础词：初高中核心词（在文档里标记「基础词」，可设置不进正文） */
export const BASE = `# 基础词表：一行一个。默认只做标记，不单独成章（docx.includeBase=false 时仍会出现在词频表）。
about above accept across act add admit afraid after again against age agree air allow almost alone along
already also although always among amount ancient angry animal answer anyone anything appear apple area
argue arm around arrive art ask attention aunt autumn avoid awake
baby back bad bag ball bank bar base basket battle beach bear beat beautiful because become bed before
begin behind believe below beside best better between big bird birth bit black blood blue board boat body
book born both bottle bottom box boy brain branch brave bread break breakfast breathe bridge bright bring
brother brown build burn business busy but buy
cake call calm camera camp can capital car card care careful carry case castle catch cause center century
certain chair chance change character cheap check cheese child choose church circle city class clean clear
clever climb clock close clothes cloud club coach cold collect college color come comfortable common
company compare complete computer concern condition connect consider contain continue control cook cool
copy corner correct cost count country course cover create cross crowd cry culture cup cut
daily damage dance danger dark date daughter day dead deal dear death decide deep degree delay deliver
demand depend describe desert design desk detail develop die difference difficult dinner direct dirty
discover discuss dish distance divide doctor dog door double doubt down draw dream dress drink drive drop
dry during duty
each ear early earth east easy eat edge education effect effort egg eight either else empty end enemy
energy enjoy enough enter entire environment equal escape especially even evening event ever every
everyone everything exactly example excellent except exchange excited exercise expect expensive
experience explain express eye
face fact fail fair fall family famous far farm fast father fear feed feel few field fight fill film
final find fine finger finish fire first fish fit five fix flat floor flower fly follow food foot for
forest forget form free fresh friend from front fruit full fun future
game garden gas general gentle get gift girl give glad glass go goal good government grass great green
grow guard guess guest guide
half hand happen happy hard hat hate have head health hear heart heavy help here high hill history hit
hold hole holiday home hope horse hospital hot hour house how huge human hundred hurt
ice idea if imagine important improve include increase indeed industry information inside instead
interest into introduce invite issue
join joke journey joy judge jump just
keep key kid kill kind king kitchen know knowledge
lake land language large last late laugh law lay lead learn leave left leg less lesson letter level lie
life light like line listen little live local long look lose lot loud love low lucky
machine main make man manage many map mark market marry match matter may maybe meal mean meat medicine
meet member memory mention middle might mile milk mind minute miss mistake mix model modern moment
money month moon morning most mother mountain mouth move movie music must
name narrow nation natural near necessary need neighbor neither never new news next nice night nobody
noise none north nose note nothing notice now number
ocean offer office often oil old once only open opinion or order other outside over own
page pain paint pair paper parent park part party pass past patient pay peace people perfect perhaps
person picture piece place plan plant play please pleasure point police poor popular position possible
power practice prepare present pressure pretty price problem produce program progress project promise
protect prove provide public pull push put
question quick quiet quite
race radio rain raise reach read ready real reason receive recent recognize record red reduce remember
remove reply report require rest result return rich right ring rise river road rock role room round
rule run
safe sail same save say school science sea season seat second see seem sell send sense serious serve
service set several share sharp short should show sick side sign silence silver simple since single
sister sit size skill sky sleep slow small smile snow soft soldier solve some someone something
sometimes son song soon sorry sound south space speak special speed spend spirit sport spring stand
star start state stay steal step stick still stone stop store story straight strange street strong
student study stupid succeed such sudden suggest summer sun support suppose sure surface surprise
sweet swim system
table tail take talk tall taste teach team tell temperature ten term test than thank that theater
their then there thick thin thing think third this though thousand three through throw ticket tidy
tie time tiny tired today together tomato tomorrow tonight too tool tooth top total touch toward
town trade train translate travel tree trip trouble true trust try turn twelve twenty twice two type
ugly uncle under understand unit until up upon use useful usual
value various vegetable very view village visit voice
wait wake walk wall want war warm wash watch water way weak wear weather week welcome well west wet
what wheel when where whether which while white who whole why wide wife wild will win wind window
wine winter wish with within without woman wonder wood word work world worry write wrong
year yellow yes yesterday yet young
zero`
;

/** POS 表：一行一个词性分组，导出成 {"word": "n."} 的 JSON */
export const POS_TABLES = {
  'n.': `ability accident action activity advantage advice agreement aim airport album amount analysis anger
animal answer apartment appearance application area argument army article artist attention audience
author baby background balance beach beauty behavior benefit birthday body book boss bottom box brand
brother budget building business camera campaign candidate career cash cause center century challenge
chance change channel character check child choice city class client climate club coast code colleague
collection college comment community company competition computer concert conference condition conflict
connection consumer context contract conversation cost country couple course court culture customer
danger data daughter death debate decade decision degree demand department design desk detail
development device difference difficulty direction director discussion disease distance doctor document
driver economy education effort election element employee energy engine environment equipment error
event evidence example exchange experience expert explanation factor factory failure family farm father
feature fee field figure film financial fish food foot force form friend function future game garden gas
girl goal government grade group growth guest habit half head health heart height history holiday home
hope hospital hotel hour house idea image impact income industry information injury instance interest
interview investment issue item job journey judge key kid kind knowledge labor lady lake language law
leader lesson letter level library life line list location loss machine magazine major manager market
marriage material meal meaning measure medical medicine member memory message method middle mind minute
mistake model moment money month mother movie music name nation nature network news night noise number
object office officer opinion option order organization other page pain paint pair paper parent park
part partner party passenger past path patient pattern pay peace people period person phone photo
picture piece place plan plant player point police policy position power practice president pressure
price problem process product program project promise property protection purpose quality question race
radio rain rate reason record region relationship report research resource response rest result return
right river road role room rule safety school science sea season seat second secretary section security
sense series service shape share side sign signal skill sky sleep smile society soldier son song sound
space speech spirit sport spring staff stage star state station step stone story street strength
student study style subject success summer sun support surface system table task tax teacher team
technology teeth temperature term test text thing thought time title today tool tooth top topic total
trade tradition traffic train tree trip trouble truth type unit university value vegetable video view
village voice wall war waste watch water way weather week weight west wheel wife wind window wine
winter woman wood word work worker world yard year`,
  'v.': `accept achieve add admit advance advise affect agree aim allow announce answer appear apply argue
arrange arrive ask attack attempt attend avoid bake balance become begin believe belong bend bet bite
blow break breathe bring build burn buy call calm camp care carry catch cause celebrate change charge
check choose climb close collect combine come comment communicate compare complain complete concern
confirm connect consider contain continue control cook copy cost count cover create cross cry cut
damage dance deal decide declare decrease deliver demand deny depend describe design destroy develop die
disagree discover discuss divide do doubt draw dream dress drink drive drop earn eat educate elect
emerge employ enable encourage end enjoy enter escape establish examine exist expect experience explain
express fail fall feed feel fight fill find finish fit fix fly follow forget forgive form get give go
grow guess happen hate have hear help hide hit hold hope hurt identify ignore imagine improve include
increase indicate influence inform insist introduce invest invite join judge jump keep kill knock know
land last laugh lead learn leave lend let lie lift like listen live look lose love make manage mean meet
mention mind miss move need notice obtain occur offer open order own paint pass pay perform permit
persuade pick plan play point prefer prepare present prevent produce promise protect prove provide
publish pull punch purchase push put raise reach react read realize receive recognize recommend reduce
reflect refuse regard regret relax release remain remember remind remove repeat replace reply report
represent require rescue research respond rest result return reveal ride ring rise risk roll run save
say search see seem sell send serve set shake share shoot show shut sing sit sleep smile solve sound
speak spend stand stare start stay steal step stick stop study suggest suffer supply support suppose
surprise survive swim take talk taste teach tell test thank think throw touch train travel treat trust
try turn understand use visit wait wake walk want warn wash watch wear win wish wonder work worry write`,
  'adj.': `able absent absolute academic acceptable accurate active actual additional adequate advanced afraid
afraid alive alone amazing ancient angry annual anxious appropriate available average awake aware bad
basic beautiful best better big bitter black blank blind blue bold boring born brave brief bright broad
broken brown busy calm careful cash certain cheap chief civil classical clean clear clever close cold
comfortable common complete complex confident confused conscious cool correct crazy creative critical
cultural curious current daily dangerous dark dead dear deep delicious different difficult digital
direct dirty distant double dry due dull eager early eastern easy economic effective efficient elderly
electric electronic empty entire equal essential even every exact excellent excited expensive
experienced extra extreme fair familiar famous fantastic far fast fat favorite federal final financial
fine firm fit flat foreign formal former free fresh friendly full funny future general generous gentle
giant glad global golden good grand grateful great green grey gross guilty happy hard harsh healthy
heavy helpful high historic holy honest horrible hot huge human hungry ideal ill illegal important
impossible impressive individual industrial informal inner innocent intense interesting international
invisible joint joyful junior keen kind large last late lazy leading legal light likely limited linear
liquid little live local logical lonely long loose loud lovely low lucky mad magical main major male
massive mature maximum mean medium mental mere mild minor mixed mobile modern moral multiple mutual
narrow national native natural near nearby neat necessary negative nervous new next nice noble normal
northern obvious odd official old open opposite ordinary original outdoor outer outstanding painful
pale parallel particular passive past patient peaceful perfect permanent personal physical plain
plastic pleasant political poor popular positive possible potential powerful practical precious
precise pregnant present pretty previous primary prime private probable professional proper proud
public pure quick quiet rare raw ready real reasonable recent red regular relevant reliable religious
remote responsible rich right rough round royal rural sad safe sane scared scientific secret secure
senior sensitive separate serious severe shallow sharp sick silent silly similar simple single slight
slim slow small smart smooth social soft solar solid sophisticated sorry sound southern spacious
spare special specific spiritual splendid stable standard steady steep stiff still straight strange
strategic strict strong stupid subject substantial successful sudden sufficient suitable super
superior sure surprised sweet swift tall technical temporary tender tense terrible thick thin thirsty
tight tiny tired tough traditional tremendous tricky true typical ugly ultimate unable unique united
universal unknown unusual upper urban urgent useful useless usual valid various vast verbal vertical
visible vital warm weak wealthy weird wet whole wide wild willing wise wonderful wooden working worthy
wrong young`,
  'adv.': `abroad absolutely accidentally actually adequately afterwards again ago ahead almost alone already
also alternatively altogether always angrily annually anyway apart apparently approximately around
aside automatically awfully badly barely basically beautifully before behind below beneath besides
better beyond carefully certainly clearly closely commonly completely constantly correctly currently
daily deeply definitely deliberately directly downstairs downtown dramatically easily effectively
either else elsewhere enormously equally especially essentially eventually ever everywhere evidently
exactly extremely fairly faithfully finally firmly fortunately frequently fully generally gently
gradually greatly happily hardly heavily highly honestly hopefully immediately increasingly indeed
independently initially instantly instead jointly just largely lately later least less likely
literally little locally long loudly mainly mostly much naturally nearly necessarily nervously never
nevertheless normally obviously occasionally often once only openly opposite otherwise out outside
overall particularly perfectly personally politely possibly precisely presumably pretty previously
probably properly publicly purely quickly quietly quite rapidly rarely rather readily really recently
regularly relatively remarkably repeatedly repeatedly roughly sadly safely scarcely seriously sharply
shortly silently similarly simply simultaneously slightly slowly smoothly softly sometimes soon
specifically steadily still strange strictly strongly successfully suddenly sufficiently surely
surprisingly terribly then there therefore thoroughly thus today together tomorrow tonight too totally
truly typically ultimately unfortunately universally unusually usually utterly very virtually well
widely wildly willingly yesterday yet`,
};

/** 默认例外：与 src/lexicon/lemmatize.js 的 DEFAULT_EXCEPTIONS 对齐 */
export const EXCEPTIONS = {
  us: 'us', is: 'is', news: 'news', bus: 'bus', yes: 'yes', his: 'his', hers: 'hers',
  its: 'its', does: 'does', goes: 'goes', always: 'always', perhaps: 'perhaps',
  unless: 'unless', sometimes: 'sometimes', serious: 'serious', previous: 'previous',
  obvious: 'obvious', various: 'various', famous: 'famous', dangerous: 'dangerous',
  generous: 'generous', nervous: 'nervous', glorious: 'glorious', campus: 'campus',
  bonus: 'bonus', status: 'status', virus: 'virus', physics: 'physics',
  mathematics: 'mathematics', ethics: 'ethics', economics: 'economics', genius: 'genius',
  canvas: 'canvas', atlas: 'atlas', bias: 'bias', chaos: 'chaos', chorus: 'chorus',
  focus: 'focus', thus: 'thus', gas: 'gas', plus: 'plus', minus: 'minus', cross: 'cross',
  class: 'class', glass: 'glass', grass: 'grass', press: 'press', bless: 'bless',
  address: 'address', process: 'process', access: 'access', success: 'success',
  business: 'business', witness: 'witness', goodness: 'goodness', happiness: 'happiness',
  darkness: 'darkness', kindness: 'kindness', illness: 'illness', fitness: 'fitness',
  during: 'during', evening: 'evening', morning: 'morning', building: 'building',
  feeling: 'feeling', meeting: 'meeting', painting: 'painting', writing: 'writing',
  reading: 'reading', learning: 'learning', meaning: 'meaning', ending: 'ending',
  beginning: 'beginning', everything: 'everything', something: 'something',
  nothing: 'nothing', anything: 'anything', thing: 'thing', spring: 'spring',
  string: 'string', king: 'king', ring: 'ring', sing: 'sing', bring: 'bring',
  going: 'go', doing: 'do', being: 'be', seeing: 'see', lying: 'lie', dying: 'die',
  tying: 'tie', skiing: 'ski', ageing: 'age', aging: 'age',
};

function writeIfAbsent(file, content, created) {
  if (existsSync(file)) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
  created.push(file);
}

/** 由 POS_TABLES 生成 { word: 'n.' } 的 JSON（按词性顺序展开，后写覆盖前写） */
export function builtinPos() {
  const out = {};
  for (const [pos, block] of Object.entries(POS_TABLES)) {
    for (const w of block.split(/\s+/)) {
      if (!w) continue;
      if (!out[w]) out[w] = pos;
    }
  }
  return out;
}

/**
 * 保证 data/ 目录结构存在。幂等：已存在的文件不动。
 * @returns {string[]} 新建的文件列表
 */
export function ensureData(dataDir) {
  const created = [];
  const knownFile = join(dataDir, 'known', 'known.txt');
  if (!existsSync(knownFile)) {
    mkdirSync(dirname(knownFile), { recursive: true });
    writeFileSync(knownFile, '# 已掌握词表：一行一个。出现在这里的词不会进入词汇正文。\n', 'utf8');
    created.push(knownFile);
  }
  writeIfAbsent(join(dataDir, 'stopword.txt'), STOPWORDS, created);
  writeIfAbsent(join(dataDir, 'base', 'base.txt'), BASE, created);
  writeIfAbsent(join(dataDir, 'pos.json'), JSON.stringify(builtinPos(), null, 2), created);
  writeIfAbsent(join(dataDir, 'lemmatize.exceptions.json'), JSON.stringify(EXCEPTIONS, null, 2), created);
  writeIfAbsent(join(dataDir, 'README.md'), dataReadme(), created);
  return created;
}

function dataReadme() {
  return `# data/ 说明

这个目录是**你的词库**，所有文件都可以自己改（一行一个词，# 开头是注释）。

| 文件 | 作用 | 填错的后果 |
| --- | --- | --- |
| \`stopword.txt\` | 停用词，永远不进正文 | 漏词（噪声词混进来） |
| \`base/base.txt\` | 基础词标记（初高中核心词） | 只是标记错，不影响正文 |
| \`known/known.txt\` | 你已掌握的词，不重复出 | 想看的词不出现 |
| \`pos.json\` | 词性表 \`{"word": "n."}\` | 词性分类不准（可用启发式兜底） |
| \`lemmatize.exceptions.json\` | 词形还原例外 \`{"was": "be"}\` | 还原错（如 us→u） |

词性代码：\`n.\` 名词、\`v.\` 动词、\`adj.\` 形容词、\`adv.\` 副词、\`phr.\` 短语、\`prop.\` 专有名词、\`num\` 数词、\`other\` 其他。
`;
}
