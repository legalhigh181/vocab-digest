/**
 * 词形还原（lemmatize）：规则表 + 不规则表 + 例外表。
 *
 * 原则：宁可少还原，不要造出不存在的词。
 *
 * 两条轨道：
 *   1) 强后缀（-ing / -ed / -ies / -es / -s / -est / -ier）
 *      这类形态几乎不可能是原形，**不需要词典佐证**，裁完就接受。
 *      例外表优先，保证 bus / news / us 不被误裁。
 *   2) 弱后缀（-er / -ly / -ness / -ment / -tion …）
 *      歧义大（cleaner 可以是「清洁工」也可以是「更干净」），
 *      **必须命中词典**才接受。
 */

/** 不规则变化表：变形 → 原形 */
export const IRREGULAR = {
  children: 'child', men: 'man', women: 'woman', people: 'person', feet: 'foot', teeth: 'tooth',
  mice: 'mouse', geese: 'goose', oxen: 'ox', lives: 'life', knives: 'knife', wives: 'wife',
  leaves: 'leaf', halves: 'half', wolves: 'wolf', thieves: 'thief', shelves: 'shelf',
  selves: 'self', loaves: 'loaf', crises: 'crisis', analyses: 'analysis', theses: 'thesis',
  criteria: 'criterion', phenomena: 'phenomenon',
  indices: 'index', matrices: 'matrix', vertices: 'vertex', octopi: 'octopus',
  was: 'be', were: 'be', been: 'be',
  went: 'go', gone: 'go', did: 'do', done: 'do', had: 'have', has: 'have', having: 'have',
  said: 'say', made: 'make', knew: 'know', known: 'know', took: 'take', taken: 'take',
  saw: 'see', seen: 'see', came: 'come', got: 'get', gotten: 'get', gave: 'give', given: 'give',
  found: 'find', thought: 'think', told: 'tell', became: 'become', left: 'leave',
  felt: 'feel', brought: 'bring', began: 'begin', begun: 'begin', kept: 'keep',
  held: 'hold', wrote: 'write', written: 'write', stood: 'stand', heard: 'hear',
  meant: 'mean', met: 'meet', ran: 'run', paid: 'pay', sat: 'sit',
  spoke: 'speak', spoken: 'speak', led: 'lead', grew: 'grow', grown: 'grow',
  lost: 'lose', fell: 'fall', fallen: 'fall', sent: 'send', built: 'build',
  understood: 'understand', drew: 'draw', drawn: 'draw', broke: 'break', broken: 'break',
  spent: 'spend', rose: 'rise', risen: 'rise', drove: 'drive', driven: 'drive',
  bought: 'buy', wore: 'wear', chose: 'choose', chosen: 'choose',
  ate: 'eat', eaten: 'eat', threw: 'throw', thrown: 'throw', caught: 'catch',
  taught: 'teach', sold: 'sell', fought: 'fight', flew: 'fly', flown: 'fly',
  forgot: 'forget', forgotten: 'forget', hid: 'hide', hidden: 'hide', hung: 'hang',
  struck: 'strike', swam: 'swim', swum: 'swim', shook: 'shake', shaken: 'shake',
  stole: 'steal', stolen: 'steal', woke: 'wake', woken: 'wake', beaten: 'beat',
  bitten: 'bite', blew: 'blow', blown: 'blow', dug: 'dig', fed: 'feed',
  froze: 'freeze', frozen: 'freeze', laid: 'lay', lent: 'lend',
  rode: 'ride', ridden: 'ride', sang: 'sing', sung: 'sing', sank: 'sink', sunk: 'sink',
  slept: 'sleep', slid: 'slide', sought: 'seek', spun: 'spin',
  swept: 'sweep', swung: 'swing', tore: 'tear', torn: 'tear',
  borne: 'bear', bore: 'bear',
  better: 'good', best: 'good', worse: 'bad', worst: 'bad', further: 'far', furthest: 'far',
  least: 'little',
};

/**
 * 默认例外表。
 * 这里的键**不会被裁**（值是它自己表示「原样保留」，值是别的词表示「映射过去」）。
 */
export const DEFAULT_EXCEPTIONS = {
  // ── -s 结尾但不是复数（裁了就不成词） ──
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
  // ── -ing 结尾但是名词/介词 ──
  during: 'during', evening: 'evening', morning: 'morning', building: 'building',
  feeling: 'feeling', meeting: 'meeting', painting: 'painting', writing: 'writing',
  reading: 'reading', learning: 'learning', meaning: 'meaning', ending: 'ending',
  beginning: 'beginning', everything: 'everything', something: 'something',
  nothing: 'nothing', anything: 'anything', thing: 'thing', spring: 'spring',
  string: 'string', king: 'king', ring: 'ring', sing: 'sing', bring: 'bring',
  // ── 去 e 加 ing 的常见词（裁完要补回 e，写死最稳） ──
  going: 'go', doing: 'do', being: 'be', seeing: 'see', lying: 'lie', dying: 'die',
  tying: 'tie', skiing: 'ski', ageing: 'age', aging: 'age',
  making: 'make', taking: 'take', giving: 'give', having: 'have', coming: 'come',
  becoming: 'become', writing: 'write', leaving: 'leave', believing: 'believe',
  moving: 'move', living: 'live', loving: 'love', losing: 'lose', closing: 'close',
  choosing: 'choose', using: 'use', causing: 'cause', facing: 'face',
  // ── -ed 结尾但是形容词/名词 ──
  need: 'need', hundred: 'hundred', sacred: 'sacred', naked: 'naked', wicked: 'wicked',
  indeed: 'indeed', speed: 'speed', feed: 'feed', seed: 'seed', bed: 'bed', red: 'red',
  // ── 其它裁了会出问题的 ──
  least: 'least', lost: 'lose', most: 'most', must: 'must', best: 'good',
  quizzes: 'quiz', whizzes: 'whiz', buzzes: 'buzz',
};

/** 强后缀：裁完直接接受，不需要词典佐证 */
const STRONG_SUFFIX = /(?:ing|ed|ies|es|s|est|ier|iest)$/;

/**
 * 构建还原器。
 * @param {object} opts { dictionary:Set<string>, exceptions:object }
 */
export function createLemmatizer(opts = {}) {
  const dictionary = opts.dictionary instanceof Set ? opts.dictionary : new Set(opts.dictionary ?? []);
  const exceptions = { ...DEFAULT_EXCEPTIONS, ...(opts.exceptions ?? {}) };
  const hasDict = dictionary.size > 0;

  const inDict = (w) => !hasDict || dictionary.has(w);

  /** 弱后缀候选：必须在词典里才算 */
  const weak = (orig, cand) => {
    if (!cand || cand === orig || cand.length < 3) return null;
    // 原形不足 3 字母说明裁过头了（vocab→voca、amazing→amaz），保留原词
    if (cand.length < 3) return null;
    return inDict(cand) ? cand : null;
  };

  /**
   * 强后缀候选：只要不退回停用词/太短就直接接受。
   * 去 e 类动词（stabilize→stabilizes、organize→organized）裁完必须补回 e，
   * 否则会造出不存在的 *stabiliz* / *organiz*。
   */
  const strong = (orig, cand) => {
    if (!cand || cand === orig || cand.length < 3) return null;
    // 裁完变成常见虚词（is→i，as→a）说明裁错了
    if (STOP_LEFTOVER.has(cand)) return null;
    // 有词典且能查到候选 → 候选就是原形，直接用（teach / push / stabilize 都在词典里）
    if (hasDict && dictionary.has(cand)) return cand;
    // 按结尾推断：合法实词结尾不补 e，-v 结尾补 e
    if (SAFE_TAIL.test(cand)) return cand;
    if (NEEDS_E.test(cand)) return cand + 'e';
    return cand;
  };

  return function lemmatize(word) {
    const w = String(word ?? '').toLowerCase();
    if (!w) return w;
    if (Object.prototype.hasOwnProperty.call(exceptions, w)) {
      const ex = exceptions[w];
      return ex === w ? w : ex;
    }
    if (Object.prototype.hasOwnProperty.call(IRREGULAR, w)) return IRREGULAR[w];

    const tryStrong = (...cands) => {
      for (const c of cands) {
        const hit = strong(w, c);
        if (hit) return hit;
      }
      return null;
    };
    const tryWeak = (...cands) => {
      for (const c of cands) {
        const hit = weak(w, c);
        if (hit) return hit;
      }
      return null;
    };
    const dblStem = (stem) => (stem.length > 2 && stem.at(-1) === stem.at(-2) ? stem.slice(0, -1) : '');

    /**
     * -ing 分支专用：先去 e 补回试一轮（making→make / using→use），
     * 再按普通规则试（teaching→teach / running→run）。
     */
    const tryIng = (stem) => {
      // 第一轮：只认「词典里确实有的补 e 形式」（making→make / using→use）
      const eCand = stem + 'e';
      if (hasDict && dictionary.has(eCand)) return eCand;
      const dbl = dblStem(stem);
      if (dbl && hasDict && dictionary.has(dbl)) return dbl;
      // 第二轮：词典里没有，按普通规则推断（teaching→teach / running→run）
      return tryStrong(dbl, stem);
    };

    // ── 名词复数 / 三单 ──
    if (w.endsWith('ies') && w.length > 4) {
      const hit = tryStrong(`${w.slice(0, -3)}y`);
      if (hit) return hit;
    }
    // 名词 -f/-fe 复数（knives → knife）。必须排除 improves / behaves / lives 这类三单动词：
    // 词干以 -v 结尾且补 e 后是动词的话，交给下面的 -s 分支。
    if (w.endsWith('ves') && w.length > 4) {
      const base = w.slice(0, -3);
      // 先确认去掉 s 后的原形（improves → improve）是真的，否则才按 -f/-fe 处理
      const asS = w.slice(0, -1);
      const verbLike = hasDict && (dictionary.has(asS));
      if (!verbLike) {
        const fCand = base + 'f';
        const feCand = base + 'fe';
        if (hasDict && dictionary.has(fCand)) return fCand;
        if (hasDict && dictionary.has(feCand)) return feCand;
        // 词典找不到时按经验：knives/leaves 走 f/fe，其余让 -s 分支处理
        if (/^(?:kni|lea|wol|hal|shel|thie|sel|loa|wi|li)$/.test(base)) {
          return dictionary.has(feCand) ? feCand : fCand;
        }
      }
    }
    if (/(?:ses|xes|zes|ches|shes)$/.test(w) && w.length > 4) {
      const s2 = w.slice(0, -2);
      const plainEs = w.slice(0, -1); // nurses → nurse（补 e 形态）
      // 词典优先：词典里有的直接认（pushes→push / nurses→nurse / finishes→finish）
      if (hasDict) {
        if (dictionary.has(w)) return w;
        // 词典里没有合并后的词：先试「词本身 / 去 s 的补 e 形态 / 去 es」三个候选
        for (const c of [plainEs, s2]) {
          if (c && c.length > 2 && dictionary.has(c)) return c;
        }
        // 复数形态的组合（buses→bus / glasses→glass / horses→horse / knives→knife）
        const plusS = s2.length > 2 && (dictionary.has(s2 + 's') || /[sxh]$/.test(s2));
        const fCand = s2.endsWith('v') ? `${s2.slice(0, -2)}f` : '';
        const feCand = s2.endsWith('v') ? `${s2}e` : '';
        if (plusS) {
          if (fCand && dictionary.has(fCand)) return fCand;
          if (feCand && dictionary.has(feCand)) return feCand;
          return s2;
        }
        // nurses 这类：去 es 是 nurs（残形）、补 e 是 nurse。词干以 -s 结尾时补 e 更像原形
        if (s2.endsWith('s') && s2.length > 3) return `${s2}e`;
        // 拿不准就不裁（nurses→nurs 比原文更误导）。
        // 例外：-zes 是「去 e 动词 + s」的强信号（stabilizes→stabilize / realizes→realize）
        if (/zes$/.test(w)) return s2 + 'e';
        return w;
      }
      // buses / glasses / boxes / watches / pushes / finishes → 去掉 -es 后仍是合法词
      // 注意：z 不在这里，z 结尾是去 e 的形态（stabiliz→stabilize）
      if (/[sxh]$/.test(s2) && s2.length > 2) {
        return s2;
      }
      if (s2.endsWith('z') || s2.endsWith('v')) {
        // stabilize→stabilizes / realize→realizes：去掉 s 后没法直接用，补 e
        const plain = w.slice(0, -1);
        if (hasDict && dictionary.has(plain)) return plain;
        return s2 + 'e';
      }
      // use→uses / change→changes：去掉 s 就是原形
      const plain = w.slice(0, -1);
      if (hasDict && dictionary.has(plain)) return plain;
      const hit = tryStrong(s2 + 'e', s2);
      if (hit) return hit;
    }
    if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is') && w.length > 3) {
      const plain = w.slice(0, -1);          // meals → meal / hurts → hurt
      const stem = plain.endsWith('e') ? plain.slice(0, -1) : plain; // nurses → nurs
      // 0) 词典里已经收录的词不再动（news/meals 这类 S 结尾但不是复数的词）
      if (hasDict && dictionary.has(w)) return w;
      // 1) 词典里确实有的原形优先（hurts→hurt，meals→meal）
      if (hasDict && dictionary.has(plain)) return plain;
      // 2) 原形不合法、但补 e 是词典词（nurses→nurse，bruises→bruise）
      const withE = stem + 'e';
      if (hasDict && dictionary.has(withE)) return withE;
      // 2.5) 词典里既没有 plain 也没有补 e 形态：走规则推断会造出 nurs 这类残形，
      //      复数情况已经被上面的 -es 分支接管，所以这里遇到词典词就停手
      if (hasDict && !dictionary.has(stem) && /[^s]ses$/.test(w)) {
        const hitStrong = tryStrong(plain);
        return hitStrong ?? w;
      }
      // 3) 规则推断
      const hit = tryStrong(plain);
      if (hit) return hit;
      if (!hasDict) {
        if (/(?:se|ze|ce|ge)$/.test(stem) && stem.length >= 4 && !/(?:ies|ous|eas)$/.test(w)) return withE;
      }
    }

    // ── 过去式 / 过去分词 ──
    if (w.endsWith('ied') && w.length > 4) {
      const hit = tryStrong(`${w.slice(0, -3)}y`);
      if (hit) return hit;
    }
    if (w.endsWith('ed') && w.length > 4) {
      const stem = w.slice(0, -2);
      // 先试词典里确实有的：restored→restore / stopped→stop
      if (hasDict) {
        for (const c of [stem, stem + 'e', dblStem(stem)]) {
          if (c && dictionary.has(c)) return c;
        }
      }
      const hit = tryStrong(dblStem(stem), stem + 'e', stem);
      if (hit) return hit;
    }

    // ── 比较级 / 最高级 ──
    if (w.endsWith('ier') && w.length > 4) {
      const hit = tryStrong(`${w.slice(0, -3)}y`, `${w.slice(0, -2)}y`, w.slice(0, -1));
      if (hit) return hit;
    }
    if (w.endsWith('iest') && w.length > 5) {
      const hit = tryStrong(`${w.slice(0, -4)}y`, w.slice(0, -3));
      if (hit) return hit;
    }
    if (w.endsWith('est') && w.length > 5) {
      const stem = w.slice(0, -3);
      const hit = tryStrong(dblStem(stem), stem, `${stem}e`);
      if (hit) return hit;
    }

    // ── 进行时 / 动名词 ──
    if (w.endsWith('ing') && w.length > 5) {
      // 双写优先：running→run、stopping→stop；补 e：making→make / using→use；原样：teaching→teach
      const hit = tryIng(w.slice(0, -3));
      if (hit) return hit;
    }

    // ── 弱后缀：必须词典佐证 ──
    if (w.endsWith('ly') && w.length > 4) {
      const stem = w.slice(0, -2);
      const hit = tryWeak(stem, `${stem}le`, stem.endsWith('i') ? `${stem.slice(0, -1)}y` : '');
      if (hit) return hit;
    }
    if (w.endsWith('er') && w.length > 5) {
      const stem = w.slice(0, -2);
      const hit = tryWeak(stem, `${stem}e`, dblStem(stem), `${w.slice(0, -2)}y`);
      if (hit) return hit;
    }
    if (/(?:ness|ment|tion|sion|ity|ance|ence|ism|ist|ship|hood|dom|ure|age)$/.test(w) && w.length > 7) {
      for (const cut of [3, 4, 5]) {
        const stem = w.slice(0, -cut);
        const hit = tryWeak(stem, `${stem}e`, `${stem}y`, `${stem}t`, `${stem}te`);
        if (hit) return hit;
      }
    }

    return w;
  };
}

/** 裁完变成这些就不接受（说明裁错了） */
const STOP_LEFTOVER = new Set([
  'a', 'an', 'i', 'as', 'at', 'be', 'by', 'do', 'go', 'he', 'if', 'in', 'is', 'it', 'me',
  'my', 'no', 'of', 'on', 'or', 'so', 'to', 'up', 'us', 'we', 'id', 'hi', 'ok',
]);

/** 英语实词不会以 v 结尾 */
const NEEDS_E = /v$/;

/**
 * 这些结尾本身就是合法实词，裁完不要再补 e。
 * `-ch/-sh/-th` 结尾的动词（teach / push）去 ing 后就是原形；
 * `-s/-z` 结尾的（stabilize / organize）去 s/ed 后必须补 e。
 */
const SAFE_TAIL = /(?:ch|sh|th|ss|ll|ng|ce|ge|se|ze|ve|le|re|pe|ke|te|de|ne|me|be|fe)$/;
