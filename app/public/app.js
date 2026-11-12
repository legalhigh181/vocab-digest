/* 词汇库前端：原生 JS，无框架、无构建。所有数据都从 /api/* 取。 */
(function () {
  'use strict';

  var state = { lists: [], runs: [], dims: [], activeId: '', runId: '', view: null, filter: {}, listCache: {}, videoUrl: '', videoPage: 0, detailWord: '', lang: 'en', detailKey: '' };

  function $(id) { return document.getElementById(id); }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }

  // ── 表情系统：立绘随状态换表情 + 气泡说话 ─────────────────────────────
  // 六个表情对应六种情绪，名字要和 app/public/img/emo-*.png 一致
  var EMO = {
    laugh: '/img/studio-happy.png',
    pout: '/img/studio-annoyed.png',
    humph: '/img/studio-proud.png',
    shock: '/img/studio-surprised.png',
    sleepy: '/img/studio-sleepy.png',
    love: '/img/studio-loving.png',
  };
  var moodTimer = null;

  function setMood(name, text, stay) {
    var img = $('heroEmo');
    var bubble = $('heroBubble');
    var src = EMO[name] || EMO.laugh;
    if (img.getAttribute('src') !== src) {
      img.setAttribute('src', src);
      // 重启动画：先移除再加回，保证每次换表情都有「蹦一下」
      img.style.animation = 'none';
      void img.offsetWidth;
      img.style.animation = '';
    }
    if (text && bubble.textContent !== text) bubble.textContent = text;
    clearTimeout(moodTimer);
    if (!stay) {
      // 4 秒后自己回到常驻表情，免得一直挂着「惊讶」
      moodTimer = setTimeout(function () { setIdleMood(); }, 4200);
    }
  }

  function setIdleMood() {
    var img = $('heroEmo');
    var bubble = $('heroBubble');
    var hasRun = !!state.runId;
    var hasList = state.lists.length > 0;
    if (hasRun) {
      img.setAttribute('src', EMO.love);
      bubble.textContent = '每一个词都有来处，点开看看它的故事。';
    } else if (hasList) {
      img.setAttribute('src', EMO.laugh);
      bubble.textContent = '把视频地址贴进来，我来帮你把词捞出来！';
    } else {
      img.setAttribute('src', EMO.pout);
      bubble.textContent = '从一段喜欢的视频开始，我陪你慢慢积累。';
    }
  }

  function toast(msg, mood) {
    var t = $('toast');
    // A native modal is in the top layer; keep feedback in that same layer.
    var parent = document.querySelector('dialog[open]') || document.body;
    if (t.parentNode !== parent) parent.appendChild(t);
    $('toastText').textContent = String(msg);
    if (mood && EMO[mood]) $('toastEmo').setAttribute('src', EMO[mood]);
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.classList.remove('show'); }, 2800);
  }

  // 根据消息内容猜该用哪个表情（后端返回的中文提示足够当作判断依据）
  function moodOf(msg, ok) {
    var s = String(msg || '');
    if (!ok) return /失败|错误|不能|缺少|为空|不存在/.test(s) ? 'shock' : 'pout';
    if (/完成|已生成|已加入|已导入|已新建|已重命名|已导出|已记录|通过/.test(s)) return 'laugh';
    if (/正在|开始|分析中/.test(s)) return 'sleepy';
    if (/词条|个词/.test(s)) return 'love';
    return 'humph';
  }

  function readSlot(id) {
    try { return JSON.parse($(id).textContent || '{}'); } catch (e) { return {}; }
  }

  function openImport() {
    var dialog = $('importDialog');
    if (!dialog.open) dialog.showModal();
    $('link').focus();
  }

  function setPanel(name) {
    document.body.dataset.panel = name;
    document.querySelectorAll('[data-panel-target]').forEach(function (button) {
      button.setAttribute('aria-pressed', String(button.dataset.panelTarget === name));
    });
  }

  async function getJSON(url) {
    var r = await fetch(url, { cache: 'no-store' });
    return r.json();
  }

  async function postJSON(url, body, isForm) {
    try {
      var r = await fetch(url, {
        method: 'POST',
        headers: isForm ? {} : { 'content-type': 'application/json' },
        body: isForm ? body : JSON.stringify(body || {}),
      });
      return await r.json();
    } catch (e) {
      // 服务断了或返回的不是 JSON —— 别让按钮静默失效
      return { ok: false, message: '请求失败：' + ((e && e.message) || e) };
    }
  }

  // ── 左侧：地址 / 词表 / 运行 ────────────────────────────────────────────

  // ── 语言 ──────────────────────────────────────────────────────────────
  // 一张表一种语言、一次运行一种语言。界面上的「语言」是「下次分析用什么」，
  // 「界面语言」是「这次运行按什么语言显示」。两者不联动，切任何一个都会重置当前筛选。

  var LANG_NAMES = { en: '英语', ja: '日语' };
  var LANG_TAGS = { en: 'EN', ja: 'JA' };

  function langOf(v) {
    return v && v.language === 'ja' ? 'ja' : 'en';
  }

  /** 词条卡/详情里的读音行：日文给片假名 + 平假名，未收录只标红不给读音 */
  function readingLine(it) {
    if (!it || it.language !== 'ja') return null;
    var d = el('div', 'reading');
    if (it.unknown) {
      d.appendChild(el('span', 'uk', '未收录'));
    } else if (it.reading) {
      d.appendChild(el('span', 'kata', it.reading));
      if (it.readingHiragana && it.readingHiragana !== it.reading) {
        d.appendChild(el('span', 'hira', it.readingHiragana));
      }
    } else {
      return null;
    }
    return d;
  }

  function langBadge(v) {
    var b = $('langBadge');
    if (!b) return;
    var lang = langOf(v);
    if (!v || !v.runId) { b.hidden = true; return; }
    b.hidden = false;
    b.textContent = LANG_TAGS[lang] || 'EN';
    b.className = 'langBadge' + (lang === 'ja' ? ' ja' : '');
    b.title = LANG_NAMES[lang] || '';
  }

  function renderLists() {
    var sel = $('wordlistSelect');
    var sel2 = $('digestWordlist');
    sel.innerHTML = '';
    var keep = sel2.value;
    sel2.innerHTML = '';
    var optNone = el('option', null, '（不用词表）');
    optNone.value = '';
    sel2.appendChild(optNone);
    state.lists.forEach(function (l) {
      // 词表名后面挂语言：日文表用音标去查英文词典是没意义的
      var tag = l.language === 'ja' ? '［日］' : '';
      var o = el('option', null, tag + l.name + '（' + l.count + '）');
      o.value = l.id;
      if (l.id === state.activeId) o.selected = true;
      sel.appendChild(o);
      var o2 = el('option', null, tag + l.name + '（' + l.count + '）');
      o2.value = l.id;
      sel2.appendChild(o2);
    });
    if (keep) sel2.value = keep;
    var cur = state.lists.find(function (l) { return l.id === state.activeId; }) || {};
    var listLang = cur.language === 'ja' ? '（日语）' : '';
    $('listHint').textContent = state.lists.length
      ? '当前词表：' + (cur.name || '') + listLang + (cur.count != null ? ' · ' + cur.count + ' 条' : '')
      : '还没有词表，点「新建」或「导入」。';
    loadListCards(sel.value);
  }

  function renderRuns() {
    var box = $('runs');
    box.innerHTML = '';
    if ($('runCount')) $('runCount').textContent = state.runs.length;
    if (!state.runs.length) {
      box.appendChild(el('div', 'empty', '还没有运行记录'));
      return;
    }
    state.runs.slice().sort(function (a, b) { return String(b.generatedAt || '').localeCompare(String(a.generatedAt || '')); }).forEach(function (r) {
      var d = el('button', 'run' + (r.runId === state.runId ? ' active' : ''));
      d.type = 'button';
      d.title = r.title || r.runId;
      d.setAttribute('aria-pressed', String(r.runId === state.runId));
      var r1 = el('div', 'r1');
      r1.appendChild(el('span', null, r.title || r.runId));
      var ok = el('span', null, r.ok ? '✓' : '!');
      ok.style.color = r.ok ? 'var(--ok)' : 'var(--bad)';
      r1.appendChild(ok);
      d.appendChild(r1);
      d.appendChild(el('div', 'r2', r.generatedAt + ' · ' + r.keptCount + ' 词'
        + (r.language === 'ja' ? ' · 日语' : '')
        + (r.wordlist ? ' · 词表 ' + r.wordlist : '')));
      d.onclick = function () { selectRun(r.runId); };
      box.appendChild(d);
    });
  }

  var listRequest = 0;
  async function loadListCards(id) {
    var request = ++listRequest;
    var box = $('listCards');
    box.innerHTML = '';
    var list = state.lists.find(function (l) { return l.id === id; });
    if ($('notebookName')) $('notebookName').textContent = list ? list.name : '尚未选择词表';
    if ($('notebookCount')) $('notebookCount').textContent = list ? list.count : 0;
    if (!id) { box.appendChild(el('div', 'empty', '选择词表后显示内容')); return; }
    var r = await postJSON('/api/wordlist/cards', { id: id });
    if (request !== listRequest) return;
    if ($('notebookCount')) $('notebookCount').textContent = r.ok && r.cards ? r.cards.length : 0;
    if (!r.ok || !r.cards || !r.cards.length) {
      box.appendChild(el('div', 'empty', '这张表还是空的'));
      return;
    }
    r.cards.slice(0, 200).forEach(function (c) {
      var row = el('div', 'c');
      var w = el('span', 'w', c.display);
      if (c.language === 'ja' && c.reading) w.title = c.unknown ? '未收录' : c.reading;
      row.appendChild(w);
      var meaning = el('span', 'm', c.meaning || '—');
      meaning.title = c.meaning || '尚未收录释义';
      row.appendChild(meaning);
      box.appendChild(row);
    });
    if (r.cards.length > 200) box.appendChild(el('div', 'empty', '…共 ' + r.cards.length + ' 条'));
  }

  // ── 中间：视图 ─────────────────────────────────────────────────────────

  function renderStats(v) {
    // 标题：优先显示原视频标题；有来源文件就再挂一行小字
    var t = $('title');
    t.textContent = v.title || v.runId || '从这里，开启新的一页';
    t.title = v.title || '';
    langBadge(v);
    var sub = $('subtitle');
    if (sub) {
      sub.innerHTML = '';
      if (v.videoUrl) {
        var a = el('a', 'vlink', '打开原视频 ↗');
        a.href = v.videoUrl;
        a.target = '_blank';
        a.rel = 'noopener';
        sub.appendChild(a);
        if (v.fileTitle) sub.appendChild(el('span', 'muted tiny', ' · ' + v.fileTitle));
      } else if (v.fileTitle && v.fileTitle !== v.title) {
        sub.appendChild(el('span', 'muted tiny', v.fileTitle));
      }
    }
    var s = v.meta && v.meta.stats ? v.meta.stats : {};
    var stats = $('stats');
    stats.innerHTML = '';
    var parts = [['收集词条', s.keptCount], ['语料片段', s.fragmentCount], ['筛选结果', v.itemCount]];
    parts.forEach(function (part) {
      if (part[1] == null) return;
      var stat = el('div', 'stat');
      stat.appendChild(el('strong', '', part[1]));
      stat.appendChild(el('span', '', part[0]));
      stats.appendChild(stat);
    });
    if ($('btnBuild')) $('btnBuild').disabled = !v.ok || !v.runId;
    if ($('btnFromRun')) $('btnFromRun').disabled = !v.ok || !v.runId;
  }

  function renderChips(v) {
    var box = $('chips');
    box.innerHTML = '';
    var dim = $('dim').value || 'pos';
    var tags = (v.tags && v.tags[dim]) || [];
    var names = { pos: '词性', difficulty: '难度', freq: '频次', source: '来源' };
    var allChip = el('button', 'chip' + (state.filter.tag ? '' : ' on'), '全部 ' + (v.itemCount || 0));
    allChip.setAttribute('aria-pressed', String(!state.filter.tag));
    allChip.onclick = function () { state.filter = {}; refreshView(); };
    box.appendChild(allChip);
    tags.forEach(function (t) {
      var on = state.filter.tag === dim + ':' + t.key;
      var c = el('button', 'chip' + (on ? ' on' : ''), t.label);
      c.setAttribute('aria-pressed', String(on));
      var n = el('span', 'n', t.count);
      c.appendChild(n);
      c.onclick = function () {
        if (on) state.filter = {};
        else state.filter = { tag: dim + ':' + t.key, pos: '', difficulty: '', source: '', freq: '' };
        refreshView();
      };
      box.appendChild(c);
    });
  }

  function renderItems(v) {
    var box = $('items');
    box.innerHTML = '';
    if (!v.ok) {
      box.appendChild(el('div', 'empty', v.message || '没有数据'));
      return;
    }
    if (!v.items || !v.items.length) {
      // 完全没选运行时给一块引导，而不是留一大片空白
      if (!state.runId) {
        var guide = el('div', 'guide');
        var pic = document.createElement('img');
        pic.src = '/img/studio-whale.png';
        pic.className = 'guide-logo';
        pic.alt = '';
        guide.appendChild(pic);
        var txt = el('div', 'guide-text');
        txt.appendChild(el('div', 'guide-title', '你的下一次「听懂了」，从这里开始'));
        txt.appendChild(el('div', 'guide-sub', '导入一段英语或日语视频，让零散的生词变成有语境的收藏。也可以从「最近学习」继续。'));
        var steps = el('ol', 'guide-steps');
        ['导入喜欢的视频', '读例句，收藏词条', '带走你的 Word 词表'].forEach(function (s) {
          steps.appendChild(el('li', '', s));
        });
        txt.appendChild(steps);
        var start = el('button', 'primary', '导入我的第一段视频');
        start.onclick = openImport;
        txt.appendChild(start);
        guide.appendChild(txt);
        box.appendChild(guide);
      } else {
        var empty = el('div', 'empty', '没有找到匹配的词条，试试其他关键词或筛选。');
        var reset = el('button', 'text-button', '清除搜索与筛选');
        reset.onclick = function () { $('q').value = ''; state.filter = {}; refreshView(); };
        empty.appendChild(el('br'));
        empty.appendChild(reset);
        box.appendChild(empty);
      }
      return;
    }
    // Progressive DOM rendering: filtering still operates on the complete server result.
    // Keep the existing API contract; append 50 entries at a time without rebuilding prior rows.
    var cursor = 0;
    var footer;
    function appendPage() {
      if (footer) footer.remove();
      v.items.slice(cursor, cursor + 50).forEach(function (it) {
        var card = el('div', 'item');
        card.dataset.word = it.word;
        if (it.entryKey) card.dataset.entryKey = it.entryKey;
        // 日文同形异读（日本 ニホン / ニッポン）是两个词条，高亮必须按 entryKey 认，否则会一起亮
        var selKey = it.entryKey || it.word;
        if (state.detailKey && state.detailKey === selKey) card.classList.add('active');
        var head = el('div', 'head');
        var w = el('button', 'w word-open', it.display || it.word);
        w.setAttribute('aria-label', '查看词条 ' + (it.display || it.word));
        w.setAttribute('aria-haspopup', 'dialog');
        if (it.phonetic) w.appendChild(el('span', 'phon', ' /' + it.phonetic + '/'));
        head.appendChild(w);
        var posBadge = el('span', 'badge' + (it.pos === 'phr.' ? ' phr' : ''), it.posLabel || it.pos || '');
        head.appendChild(posBadge);
        head.appendChild(el('span', 'badge tag', '×' + it.count));
        if (it.colloquial) head.appendChild(el('span', 'badge col', '口语'));
        (it.scene || []).forEach(function (s) { head.appendChild(el('span', 'badge tag', s)); });
        if (it.meaning) head.appendChild(el('span', 'meaning', it.meaning));
        card.appendChild(head);
        var rd = readingLine(it);
        if (rd) card.appendChild(rd);
        var first = (it.usages || [])[0];
        if (first) {
          var u = el('div', 'usage');
          var sentence = el('span', 'sk', first.skeleton || first.text);
          sentence.title = first.text || first.skeleton || '';
          u.appendChild(sentence);
          var tm = el('button', 'time', '▶ ' + fmtTime(first.t));
          tm.setAttribute('aria-label', '回到视频 ' + fmtTime(first.t));
          tm.onclick = function (e) { e.stopPropagation(); openVideoTime(first.t); };
          u.appendChild(tm);
          card.appendChild(u);
        }
        card.onclick = function () {
          state.detailWord = it.word;
          state.detailKey = it.entryKey || it.word;
          Array.prototype.forEach.call(box.children, function (c) { c.classList.remove('active'); });
          card.classList.add('active');
          showDetail(it);
        };
        card.appendChild(el('span', 'item-arrow', '↗'));
        box.appendChild(card);
      });
      cursor = Math.min(cursor + 50, v.items.length);
      footer = el('div', 'more-row');
      footer.appendChild(el('span', '', '已展示 ' + cursor + ' / ' + v.items.length + ' 个词条'));
      if (cursor < v.items.length) {
        var more = el('button', '', '再看 50 个词条 ↓');
        more.onclick = function () {
          var previousCount = cursor;
          appendPage();
          var nextWord = box.querySelectorAll('.word-open')[previousCount];
          if (nextWord) nextWord.focus();
        };
        footer.appendChild(more);
      } else { footer.appendChild(el('span', '', '每一点积累，都算数。')); }
      box.appendChild(footer);
    }
    appendPage();
  }

  function fmtTime(sec) {
    var s = Math.max(0, Math.floor(Number(sec) || 0));
    var m = Math.floor(s / 60);
    var r = s % 60;
    return m + ':' + (r < 10 ? '0' : '') + r;
  }

  function openVideoTime(sec) {
    var t = Math.floor(Number(sec) || 0);
    if (!state.videoUrl) {
      toast('这条运行不是从视频抓来的，没有可跳转的地址');
      return;
    }
    // 多 P 视频必须带 &p=N，否则会跳到第 1 P 的同一秒（原来是 &t= 被 ? 拼错，t 根本没生效）
    var base = state.videoUrl.split('#')[0];
    var head = base.split('?')[0];
    var params = [];
    var has = base.indexOf('?') >= 0 ? base.slice(base.indexOf('?') + 1) : '';
    has.split('&').forEach(function (kv) {
      if (!kv) return;
      var k = kv.split('=')[0];
      if (k === 't' || k === 'p') return;      // 旧的 t / p 丢掉，用新的替换
      params.push(kv);
    });
    if (state.videoPage) params.push('p=' + state.videoPage);
    params.push('t=' + t);
    window.open(head + '?' + params.join('&'), '_blank');
  }

  function showDetail(it) {
    var box = $('detail');
    box.innerHTML = '';
    var title = el('h3', null, it.display || it.word);
    if (it.phonetic) title.appendChild(el('span', 'phon', ' /' + it.phonetic + '/'));
    box.appendChild(title);
    var rd = readingLine(it);
    if (rd) box.appendChild(rd);
    var meta = [];
    if (it.posLabel) meta.push(it.posLabel);
    if (it.language === 'ja' && it.posDetail && it.posDetail !== it.posLabel) meta.push('细分 ' + it.posDetail);
    meta.push('出现 ' + it.count + ' 次');
    if (it.language === 'ja' && it.lemmaSource === 'basic_form') meta.push('已还原为基本形');
    box.appendChild(el('div', 'm', meta.join(' · ')));
    if (it.meaning) box.appendChild(el('div', 'mean', it.meaning));
    else if (it.language === 'ja') box.appendChild(el('div', 'mean muted', '这个词暂时没有收录释义。可以先阅读原句，核对含义后再收藏。'));
    else box.appendChild(el('div', 'mean muted', '（词库里还没有这个词的释义，可点下方加入词表后自己补）'));
    if (it.dictMeaning && it.dictMeaning !== it.meaning) {
      box.appendChild(el('div', 'mean sub', it.dictMeaning));
    }
    if (it.cambridge) {
      var a = el('a', 'camb', '在剑桥词典里查 ↗');
      a.href = it.cambridge;
      a.target = '_blank';
      a.rel = 'noopener';
      box.appendChild(a);
    }
    // 定位不精确时别假装能高亮：只说明只能给整句
    if (it.offsetExact === false) {
      box.appendChild(el('div', 'm', '定位提示：这条词的原文位置无法精确对应，下面只给整句。'));
    }
    // 点开词条时立绘也换情绪：短语/口语词多点爱心，普通词得意一下
    try {
      var isPhr = it.pos === 'phr.';
      var isColloq = !!it.colloquial;
      if (isPhr || isColloq) setMood('love', '「' + (it.display || it.word) + '」这种说法超口语的，学会就能用！');
      else setMood('humph', '「' + (it.display || it.word) + '」出现 ' + it.count + ' 次，记一下～');
    } catch (e) { /* 表情出错不影响主流程 */ }
    (it.usages || []).forEach(function (u) {
      var d = el('div', 'u');
      d.appendChild(el('div', 'sk', u.skeleton || u.text));
      if (u.skeleton && u.skeleton !== u.text) d.appendChild(el('div', null, u.text));
      var line = el('button', null, '▶ ' + fmtTime(u.t) + ' · 回到原视频');
      line.style.fontSize = '12px';
      line.style.color = 'var(--muted)';
      line.style.cursor = 'pointer';
      line.onclick = function () { openVideoTime(u.t); };
      d.appendChild(line);
      box.appendChild(d);
    });
    var btn = el('button', 'add', '加入词表');
    btn.onclick = function () {
      var id = $('wordlistSelect').value;
      if (!id) { toast('先选一个词表'); return; }
      postJSON('/api/wordlist/add', {
        id: id,
        cards: [{
          word: it.word,
          display: it.display || it.word,
          kind: it.pos === 'phr.' ? 'phrase' : 'word',
          language: it.language === 'ja' ? 'ja' : 'en',
          ...(it.language === 'ja' ? {
            entryKey: it.entryKey || '',
            reading: it.reading || '',
            readingHiragana: it.readingHiragana || '',
            unknown: Boolean(it.unknown),
          } : {}),
          senses: it.meaning ? [{ pos: it.pos === 'phr.' ? 'phr.' : (it.pos || 'other'), meaning: it.meaning }] : [],
          source: 'app',
        }],
      }).then(function (r) { toast(r.message); if (r.ok) reloadState(); });
    };
    box.appendChild(btn);
    var dialog = $('detailDialog');
    if (dialog && !dialog.open) dialog.showModal();
  }

  var viewRequest = 0;
  async function refreshView() {
    var request = ++viewRequest;
    if (!state.runId) {
      state.view = { ok: true, items: [] };
      renderStats(state.view);
      renderChips(state.view);
      renderItems(state.view);
      return;
    }
    var q = new URLSearchParams();
    q.set('runId', state.runId);
    q.set('dim', $('dim').value || 'pos');
    q.set('sort', ($('sortSel') && $('sortSel').value) || 'freq');
    var needle = ($('q') && $('q').value || '').trim();
    if (needle) q.set('q', needle);
    Object.keys(state.filter).forEach(function (k) {
      if (state.filter[k]) q.set(k, state.filter[k]);
    });
    var v = await getJSON('/api/view?' + q.toString());
    if (request !== viewRequest) return;
    // 视图里的语言必须和这次的 runId 一起落地：先记 runId 再记语言，
    // 否则切语言时切到一半的旧响应会把语言改回去
    state.view = v;
    state.lang = langOf(v);
    state.videoUrl = v.videoUrl || '';
    state.videoPage = v.videoPage || 0;
    renderStats(v);
    renderChips(v);
    renderItems(v);
  }

  function selectRun(runId) {
    state.runId = runId;
    state.filter = {};
    state.detailKey = '';
    state.detailWord = '';
    setPanel('workspace');
    if ($('detailDialog') && $('detailDialog').open) $('detailDialog').close();
    if ($('importDialog') && $('importDialog').open) $('importDialog').close();
    $('q').value = '';
    // 语言先用状态里已知的猜一个，等 /api/view 回来再以服务端为准（见 refreshView）
    var rr = state.runs.find(function (x) { return x.runId === runId; });
    state.lang = rr && rr.language === 'ja' ? 'ja' : 'en';
    $('detail').innerHTML = '';
    renderRuns();
    var r = state.runs.find(function (x) { return x.runId === runId; });
    state.videoUrl = (r && r.videoUrl) || '';
    state.videoPage = (r && r.page) || 0;
    setMood('love', '这次分析完啦，点中间的词条看看它在原句里怎么用～');
    refreshView();
  }

  /** 分析语言：左侧「语言」是下次分析要用的语言 */
  function digestLanguage() {
    var el2 = $('langSel');
    return el2 && el2.value === 'ja' ? 'ja' : 'en';
  }

  /** 左侧「语言」下拉的提示：说清这次分析会用哪套规则 */
  function updateDigestHint() {
    var h = $('langHint');
    if (h) h.textContent = digestLanguage() === 'ja' ? '提取日语词条，保留片假名和平假名读音。' : '提取英语单词与短语，保留音标和原句。';
    updateJaAsrNote();
  }

  /**
   * 日语语音识别的质量限制，得让用户在点「抓取」之前就看见。
   * 这里是本地 ggml-small 模型，短词/长音/促音/撥音会听错，偶尔整句幻觉——
   * 实测（两段母语发音练习）只能算部分正确，所以不能只在文档里写。
   */
  function updateJaAsrNote() {
    var n = $('jaAsrNote');
    if (!n) return;
    var asrOn = $('asr') ? $('asr').checked : false;
    n.hidden = !(digestLanguage() === 'ja' && asrOn);
  }

  /** 界面语言 → 只影响展示，不影响已跑出来的运行 */
  function setViewLanguage(lang) {
    var next = lang === 'ja' ? 'ja' : 'en';
    state.lang = next;
    var sd = $('viewLang');
    if (sd) sd.value = next;
  }

  // ── 动作 ──────────────────────────────────────────────────────────────

  async function reloadState() {
    var s = await getJSON('/api/state');
    state.lists = s.lists || [];
    state.runs = s.runs || [];
    state.activeId = s.activeId || '';
    state.dims = s.dims || [];
    $('dataHint').textContent = s.dataOk ? '词表目录就绪' : '词表目录缺文件：' + (s.missingFiles || []).join('；');
    $('dataHint').classList.toggle('bad', !s.dataOk);
    renderLists();
    renderRuns();
  }

  // ---- 长任务：抓取/转写可能要几分钟，必须能看见进度、能取消 ----
  // 走 /api/run/fetch/start：服务端立刻把 taskId 交出来，取数在后台跑。
  // 这样「取消」是在任务还在跑的时候点下去的，而不是等它做完了才拿到 id。
  // 也不靠「任务列表里最新那条」猜归属——两个窗口同时抓不同视频会猜错。
  var busyTask = null; // { id }

  function taskBar(text) {
    var bar = $('taskBar');
    if (!bar) return;
    if (!text) { bar.hidden = true; bar.textContent = ''; return; }
    bar.hidden = false;
    bar.textContent = text;
  }

  /** 轮询单个任务直到它结束，返回任务最终结果（查不到就返回 null） */
  function waitTask(id) {
    return new Promise(function (resolve) {
      var tries = 0;
      var timer = setInterval(async function () {
        tries += 1;
        var t = await getJSON('/api/tasks?id=' + encodeURIComponent(id)).catch(function () { return null; });
        if (!t || !t.ok || !t.task) {
          // 任务表里查不到了（服务重启或被清理）：别无限等下去
          if (tries > 2) { clearInterval(timer); resolve(null); }
          return;
        }
        taskBar('正在抓取/转写…（任务 ' + id + '）');
        if (t.task.done) { clearInterval(timer); resolve(t.task.result || null); }
      }, 700);
    });
  }

  function stopWatch() {
    taskBar('');
    busyTask = null;
  }

  async function doCancelFetch() {
    // 正常情况下 taskId 在任务一开始就拿到了；拿不到才去列表里找
    var id = busyTask && busyTask.id;
    if (!id) {
      var t = await getJSON('/api/tasks').catch(function () { return null; });
      var f = ((t && t.tasks) || []).filter(function (x) { return x.kind === 'fetch'; })[0];
      id = f && f.id;
    }
    if (!id) { toast('现在没有正在跑的抓取任务', 'pout'); return; }
    var r = await postJSON('/api/tasks/cancel', { id: id });
    $('fetchLog').textContent += '\n' + (r.message || '已请求取消');
    toast(r.message || '已请求取消', r.ok ? 'humph' : 'pout');
  }

  async function doFetch() {
    var link = $('link').value.trim();
    if (!link) {
      setMood('pout', '地址还没贴呢…把视频链接粘进来吧！');
      toast('先粘贴一个视频地址', 'pout');
      return;
    }
    var log = $('fetchLog');
    log.textContent = '开始抓取…';
    setMood('sleepy', '收到！我正在翻字幕和弹幕，稍等一下～', true);
    if ($('btnCancelFetch')) $('btnCancelFetch').disabled = false;
    var r = null;
    try {
      // 第一步：只拿到 taskId 就返回，这样取消按钮立刻有效
      var start = await postJSON('/api/run/fetch/start', {
        link: link,
        withDanmaku: $('withDanmaku').checked,
        asr: $('asr').checked,
        // 关键：语言要传给转写。不传的话服务端按 en 转写，日语人声会被写成英文 SRT，
        // 日文分词一个词都抓不到（表现为「0 词条」）
        language: digestLanguage(),
      });
      if (!start.ok || !start.taskId) {
        log.textContent += '\n抓取失败：' + (start.message || '服务端没有给出任务号');
        setMood('shock', '诶？！取数没启动起来…');
        toast(start.message || '抓取失败', 'shock');
        return;
      }
      busyTask = { id: start.taskId };
      taskBar('正在抓取/转写…（任务 ' + start.taskId + '）');
      // 第二步：轮询这一个任务，直到它出结果（成功/失败/被取消都会出结果）
      r = await waitTask(start.taskId);
    } finally {
      if ($('btnCancelFetch')) $('btnCancelFetch').disabled = true;
    }
    stopWatch();
    if (!r) {
      log.textContent += '\n抓取任务的状态查不到了（服务可能重启过），请重新试一次。';
      setMood('shock', '诶…任务状态查不到了。');
      toast('任务状态查不到', 'shock');
      return;
    }
    if (r.logs && r.logs.length) log.textContent = r.logs.join('\n');
    // 日语语音识别是本地小模型，质量有限；在日志里留一句，免得用户把它当准字幕
    if (digestLanguage() === 'ja' && $('asr') && $('asr').checked) {
      log.textContent += '\n注意：日语语音识别用的是本地小模型，长音／促音／撥音容易听错，偶尔整句幻觉，请对照原视频核对。';
    }
    if (!r.ok) {
      // 失败必须留在日志框里，光靠 toast 一闪就看不见了
      log.textContent += (log.textContent ? '\n' : '') + '抓取失败：' + (r.message || '未知原因');
      setMood('shock', '诶？！取数没成功…看看左下角的日志？');
      toast(r.message || '抓取失败', 'shock');
      return;
    }
    state.videoUrl = link;
    state.videoPage = r.page || 0;
    if (r.playUrl) state.videoUrl = r.playUrl;
    toast(r.message, 'humph');
    log.textContent += '\n正在分析…';
    setMood('sleepy', '词都捞到了，正在按词性分类整理～', true);
    var d = await postJSON('/api/run/digest', {
      // r.inputs 是真实存在的文件路径（不再是 .p2.srt 这种展示标签）
      inputs: r.inputs,
      wordlist: $('digestWordlist').value || '',
      title: r.title || '',
      link: link,
      // 语言一起交给分析：跑出来的运行按它决定分词 / 读音 / Word 标题
      language: digestLanguage(),
      // 多 P：把分 P 号一起交给分析，点时间戳才能跳到正确的那一 P
      page: r.page || 0,
      totalPages: r.totalPages || 0,
    });
    log.textContent += '\n' + d.message;
    if (d.ok) {
      setMood('laugh', '整理好啦！左边这次运行的词都在中间，点开看用法～');
      toast(d.message, 'laugh');
      await reloadState();
      selectRun(d.runId);
    } else {
      setMood('shock', '分析卡住了…' + (d.message || ''));
      toast(d.message, 'shock');
    }
  }

  async function doDigestLocal() {
    var inputs = window.prompt('本地文件路径（每行一个，可以是字幕 srt/json 或弹幕 xml）');
    if (!inputs) return;
    var list = inputs.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
    if (!list.length) return;
    setMood('sleepy', '读本地文件，马上就好～', true);
    var d = await postJSON('/api/run/digest', {
      inputs: list,
      wordlist: $('digestWordlist').value || '',
      language: digestLanguage(),
    });
    toast(d.message, moodOf(d.message, d.ok));
    if (d.ok) { setMood('laugh', '本地文件也整理好啦！'); await reloadState(); selectRun(d.runId); }
    else setMood('shock', '这个文件我读不懂…' + (d.message || ''));
  }

  async function doBuild() {
    if (!state.runId) { setMood('pout', '先在左边选一个运行，我才有东西可以排版呀。'); toast('先选一个运行', 'pout'); return; }
    setMood('sleepy', '按新的维度重新排版 Word 中…', true);
    var d = await postJSON('/api/run/build', { runId: state.runId, by: $('dim').value || 'pos' });
    toast(d.message, moodOf(d.message, d.ok));
    if (d.ok) setMood('laugh', 'Word 重新生成好了！');
    else setMood('pout', '呃…重排版没成功。');
  }

  async function doNewList() {
    var name = window.prompt('新词表名称', '新词表');
    if (!name) return;
    var sel = $('newListLang');
    var language = sel && sel.value === 'ja' ? 'ja' : 'en';
    var r = await postJSON('/api/wordlist/create', { name: name, language: language });
    toast(r.message, moodOf(r.message, r.ok));
    await reloadState();
    if (r.ok) setMood('laugh', '新词表「' + name + '」（' + (LANG_NAMES[language] || '') + '）建好啦！');
  }

  async function doRenameList() {
    var id = $('wordlistSelect').value;
    if (!id) { setMood('pout', '先选一个要改名的词表吧。'); toast('先选一个词表', 'pout'); return; }
    var name = window.prompt('新名称');
    if (!name) return;
    var r = await postJSON('/api/wordlist/rename', { id: id, name: name });
    toast(r.message, moodOf(r.message, r.ok));
    await reloadState();
    if (r.ok) setMood('humph', '名字换好啦！');
  }

  async function doImportList() {
    // 优先用文件选择框上传（浏览器拿不到本地路径，所以走 FormData 把内容发给服务端）
    var picker = $('importFile');
    if (picker && picker.files && picker.files[0]) {
      var fd = new FormData();
      fd.append('file', picker.files[0]);
      setMood('sleepy', '在数你的词呢…', true);
      var up = await postJSON('/api/wordlist/import', fd, true);
      toast(up.message, moodOf(up.message, up.ok));
      if (up.ok) { picker.value = ''; var nm = $('importName'); if (nm) nm.textContent = '未选择文件'; setMood('laugh', '词表收好啦！'); await reloadState(); }
      else setMood('shock', '这个文件我读不进去…');
      return;
    }
    var file = window.prompt('要导入的 txt 绝对路径（或者用上面的「导入文件」选择框）');
    if (!file) return;
    var r = await postJSON('/api/wordlist/import', { file: file });
    toast(r.message, moodOf(r.message, r.ok));
    await reloadState();
    if (r.ok) setMood('laugh', '导入完成～');
  }

  async function doExportList() {
    var id = $('wordlistSelect').value;
    if (!id) { setMood('pout', '先选一个词表哦。'); toast('先选一个词表', 'pout'); return; }
    var out = window.prompt('导出到哪里（绝对路径）', 'data/wordlists/export.txt');
    if (!out) return;
    var r = await postJSON('/api/wordlist/export', { id: id, out: out });
    toast(r.message, moodOf(r.message, r.ok));
    if (r.ok) setMood('humph', '导出了！');
  }

  async function doFromRun() {
    if (!state.runId) { setMood('pout', '先选一个运行，我才知道用哪次结果建表呀。'); toast('先选一个运行', 'pout'); return; }
    var name = window.prompt('用这次结果新建词表，名称：', (state.view && state.view.title) || state.runId);
    if (!name) return;
    var r = await postJSON('/api/wordlist/fromRun', { runId: state.runId, name: name });
    toast(r.message, moodOf(r.message, r.ok));
    await reloadState();
    if (r.ok) setMood('love', '这些词都收进「' + name + '」啦！');
  }

  // ── 启动 ──────────────────────────────────────────────────────────────

  function boot() {
    ['importDialog', 'detailDialog'].forEach(function (id) {
      var dialog = $(id);
      if (dialog) dialog.addEventListener('close', function () {
        if ($('toast').parentNode === dialog) document.body.appendChild($('toast'));
      });
    });
    if ($('btnImportVideo')) $('btnImportVideo').onclick = openImport;
    if ($('btnWelcomeImport')) $('btnWelcomeImport').onclick = openImport;
    if ($('btnCloseImport')) $('btnCloseImport').onclick = function () { $('importDialog').close(); };
    if ($('btnCloseDetail')) $('btnCloseDetail').onclick = function () { $('detailDialog').close(); };
    if ($('navWorkspace')) $('navWorkspace').onclick = function () { setPanel('workspace'); $('workspace').scrollIntoView({ behavior: 'smooth' }); };
    document.querySelectorAll('[data-panel-target]').forEach(function (button) {
      button.onclick = function () { setPanel(button.dataset.panelTarget); };
    });
    var s0 = readSlot('d-state');
    if (s0 && s0.ok) {
      state.lists = s0.lists || [];
      state.runs = s0.runs || [];
      state.activeId = s0.activeId || '';
      state.dims = s0.dims || [];
      $('dataHint').textContent = s0.dataOk ? '词表目录就绪' : '词表目录缺文件';
      renderLists();
      renderRuns();
    }
    var v0 = readSlot('d-view');
    if (v0 && v0.runId) { state.runId = v0.runId; refreshView(); }

    $('btnFetch').onclick = async function () {
      if (this.disabled) return;
      var controls = ['btnFetch', 'btnDigestLocal', 'link', 'langSel', 'digestWordlist', 'asr', 'withDanmaku'];
      controls.forEach(function (id) { $(id).disabled = true; });
      try { await doFetch(); }
      finally { controls.forEach(function (id) { $(id).disabled = false; }); }
    };
    $('btnDigestLocal').onclick = doDigestLocal;
    if ($('btnCancelFetch')) $('btnCancelFetch').onclick = doCancelFetch;
    $('btnBuild').onclick = doBuild;
    $('btnNewList').onclick = doNewList;
    $('btnRenameList').onclick = doRenameList;
    $('btnImportList').onclick = doImportList;
    $('btnExportCards').onclick = doExportList;
    $('btnExportList').onclick = doExportList;
    $('btnFromRun').onclick = doFromRun;
    $('btnDocx').onclick = function () {
      postJSON('/api/open', { what: 'runs' }).then(function (r) {
        toast(r.message, moodOf(r.message, r.ok));
        setMood(r.ok ? 'humph' : 'pout', r.ok ? '文件夹打开啦，Word 都在里面！' : '打不开…可能是路径不对？');
      });
    };
    $('dim').onchange = function () { state.filter = {}; refreshView(); };
    // 分析语言：只影响下一次分析，不动已经跑出来的运行
    $('langSel').onchange = function () { updateDigestHint(); };
    // 勾/不勾语音识别，也会决定「日语识别质量」提示要不要出现
    if ($('asr')) $('asr').onchange = function () { updateJaAsrNote(); };
    // 界面语言：只切展示；当前运行的筛选先重置，免得切过去还挂着上一种语言的标签
    $('viewLang').onchange = function () {
      setViewLanguage(this.value);
      state.filter = {};
      refreshView();
    };
    // 搜索：边打边搜，但停手 220ms 才发请求，免得每敲一个字就查一次
    var qTimer = null;
    $('q').oninput = function () {
      clearTimeout(qTimer);
      qTimer = setTimeout(function () { refreshView(); }, 220);
    };
    $('q').onkeydown = function (e) { if (e.key === 'Escape') { $('q').value = ''; refreshView(); } };
    $('sortSel').onchange = function () { refreshView(); };
    $('wordlistSelect').onchange = function () {
      loadListCards(this.value);
      var cur = state.lists.find(function (l) { return l.id === this.value; }, this);
      if (cur) setMood('humph', '切到「' + cur.name + '」了，' + cur.count + ' 条词条在手～');
    };
    // 地址框有内容时给个期待的表情
    $('link').oninput = function () {
      if (this.value.trim()) setMood('humph', '地址收到！点「抓取字幕」我就开工～');
    };
    // 选好文件后把文件名显示出来（原生控件被藏起来了）
    $('importFile').onchange = function () {
      var nm = $('importName');
      if (!nm) return;
      nm.textContent = this.files && this.files[0] ? this.files[0].name : '未选择文件';
    };

    reloadState().then(function () {
      setIdleMood();
      updateDigestHint();
      // 一次都没选运行时也要把中栏的引导画出来，否则中间是空白
      if (!state.runId) renderItems({ ok: true, items: [] });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
