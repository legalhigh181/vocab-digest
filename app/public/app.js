/* 词汇库前端：原生 JS，无框架、无构建。所有数据都从 /api/* 取。 */
(function () {
  'use strict';

  var state = { lists: [], runs: [], dims: [], activeId: '', runId: '', view: null, filter: {}, listCache: {}, videoUrl: '', detailWord: '' };

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
    laugh: '/img/emo-laugh.png',   // 开心 / 成功
    pout: '/img/emo-pout.png',     // 有点小情绪 / 提醒
    humph: '/img/emo-humph.png',   // 得意 / 哼
    shock: '/img/emo-shock.png',   // 惊讶 / 出错
    sleepy: '/img/emo-sleepy.png', // 等待 / 工作中
    love: '/img/emo-love.png',     // 喜欢 / 选中
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
      bubble.textContent = '这次挑出的词都在右边啦，点开看看用法～';
    } else if (hasList) {
      img.setAttribute('src', EMO.laugh);
      bubble.textContent = '把视频地址贴进来，我来帮你把词捞出来！';
    } else {
      img.setAttribute('src', EMO.pout);
      bubble.textContent = '还没有词表呢…先去「词表」新建一个吧。';
    }
  }

  function toast(msg, mood) {
    var t = $('toast');
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

  function renderLists() {
    var sel = $('wordlistSelect');
    var sel2 = $('digestWordlist');
    sel.innerHTML = '';
    sel2.innerHTML = '';
    var keep = sel2.value;
    var optNone = el('option', null, '（不用词表）');
    optNone.value = '';
    sel2.appendChild(optNone);
    state.lists.forEach(function (l) {
      var o = el('option', null, l.name + '（' + l.count + '）');
      o.value = l.id;
      if (l.id === state.activeId) o.selected = true;
      sel.appendChild(o);
      var o2 = el('option', null, l.name + '（' + l.count + '）');
      o2.value = l.id;
      sel2.appendChild(o2);
    });
    if (keep) sel2.value = keep;
    var cur = state.lists.find(function (l) { return l.id === state.activeId; }) || {};
    $('listHint').textContent = state.lists.length
      ? '当前词表：' + (cur.name || '') + (cur.count != null ? ' · ' + cur.count + ' 条' : '')
      : '还没有词表，点「新建」或「导入」。';
    loadListCards(sel.value);
  }

  function renderRuns() {
    var box = $('runs');
    box.innerHTML = '';
    if (!state.runs.length) {
      box.appendChild(el('div', 'empty', '还没有运行记录'));
      return;
    }
    state.runs.forEach(function (r) {
      var d = el('div', 'run' + (r.runId === state.runId ? ' active' : ''));
      var r1 = el('div', 'r1');
      r1.appendChild(el('span', null, r.title || r.runId));
      var ok = el('span', null, r.ok ? '✓' : '!');
      ok.style.color = r.ok ? 'var(--ok)' : 'var(--bad)';
      r1.appendChild(ok);
      d.appendChild(r1);
      d.appendChild(el('div', 'r2', r.generatedAt + ' · ' + r.keptCount + ' 词' + (r.wordlist ? ' · 词表 ' + r.wordlist : '')));
      d.onclick = function () { selectRun(r.runId); };
      box.appendChild(d);
    });
  }

  async function loadListCards(id) {
    var box = $('listCards');
    box.innerHTML = '';
    if (!id) { box.appendChild(el('div', 'empty', '选择词表后显示内容')); return; }
    var r = await postJSON('/api/wordlist/cards', { id: id });
    if (!r.ok || !r.cards || !r.cards.length) {
      box.appendChild(el('div', 'empty', '这张表还是空的'));
      return;
    }
    r.cards.slice(0, 200).forEach(function (c) {
      var row = el('div', 'c');
      row.appendChild(el('span', 'w', c.display));
      row.appendChild(el('span', 'm', c.meaning || '—'));
      box.appendChild(row);
    });
    if (r.cards.length > 200) box.appendChild(el('div', 'empty', '…共 ' + r.cards.length + ' 条'));
  }

  // ── 中间：视图 ─────────────────────────────────────────────────────────

  function renderStats(v) {
    // 标题：优先显示原视频标题；有来源文件就再挂一行小字
    var t = $('title');
    t.textContent = v.title || v.runId || '';
    t.title = v.title || '';
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
    var parts = [];
    if (s.keptCount != null) parts.push('词条 ' + s.keptCount);
    if (s.fragmentCount != null) parts.push('片段 ' + s.fragmentCount);
    parts.push('当前显示 ' + (v.itemCount || 0) + ' 个');
    $('stats').textContent = parts.join(' · ');
  }

  function renderChips(v) {
    var box = $('chips');
    box.innerHTML = '';
    var dim = $('dim').value || 'pos';
    var tags = (v.tags && v.tags[dim]) || [];
    var names = { pos: '词性', difficulty: '难度', freq: '频次', source: '来源' };
    var allChip = el('span', 'chip' + (state.filter.tag ? '' : ' on'), '全部 ' + (v.itemCount || 0));
    allChip.onclick = function () { state.filter = {}; refreshView(); };
    box.appendChild(allChip);
    tags.forEach(function (t) {
      var on = state.filter.tag === dim + ':' + t.key;
      var c = el('span', 'chip' + (on ? ' on' : ''), (names[dim] || dim) + ' · ' + t.label);
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
        pic.src = '/img/logo-main.png';
        pic.className = 'guide-logo';
        pic.alt = '';
        guide.appendChild(pic);
        var txt = el('div', 'guide-text');
        txt.appendChild(el('div', 'guide-title', '左边的立绘在等你贴地址'));
        txt.appendChild(el('div', 'guide-sub', '找一个 B 站英语视频，把链接贴进「视频地址」，点抓取字幕。' +
          '没有字幕也没关系，勾上语音识别，我会自己听。'));
        var steps = el('ol', 'guide-steps');
        ['贴视频地址', '挑一张词表（也可以新建）', '点「抓取字幕」等结果', '按标签看词，需要就出 Word'].forEach(function (s) {
          steps.appendChild(el('li', '', s));
        });
        txt.appendChild(steps);
        guide.appendChild(txt);
        box.appendChild(guide);
      } else {
        box.appendChild(el('div', 'empty', '这个标签下没有词条'));
      }
      return;
    }
    v.items.forEach(function (it) {
      var card = el('div', 'item');
      card.dataset.word = it.word;
      if (state.detailWord === it.word) card.classList.add('active');
      var head = el('div', 'head');
      var w = el('span', 'w', it.display || it.word);
      if (it.phonetic) w.appendChild(el('span', 'phon', ' /' + it.phonetic + '/'));
      head.appendChild(w);
      var posBadge = el('span', 'badge' + (it.pos === 'phr.' ? ' phr' : ''), it.posLabel || it.pos || '');
      head.appendChild(posBadge);
      head.appendChild(el('span', 'badge tag', '×' + it.count));
      if (it.colloquial) head.appendChild(el('span', 'badge col', '口语'));
      (it.scene || []).forEach(function (s) { head.appendChild(el('span', 'badge tag', s)); });
      if (it.meaning) head.appendChild(el('span', 'meaning', it.meaning));
      card.appendChild(head);
      var first = (it.usages || [])[0];
      if (first) {
        var u = el('div', 'usage');
        u.appendChild(el('span', 'sk', first.skeleton || first.text));
        var tm = el('span', 'time', '▶ ' + fmtTime(first.t));
        tm.onclick = function (e) { e.stopPropagation(); openVideoTime(first.t); };
        u.appendChild(tm);
        card.appendChild(u);
      }
      card.onclick = function () {
        state.detailWord = it.word;
        Array.prototype.forEach.call(box.children, function (c) { c.classList.remove('active'); });
        card.classList.add('active');
        showDetail(it);
      };
      box.appendChild(card);
    });
  }

  function fmtTime(sec) {
    var s = Math.max(0, Math.floor(Number(sec) || 0));
    var m = Math.floor(s / 60);
    var r = s % 60;
    return m + ':' + (r < 10 ? '0' : '') + r;
  }

  function openVideoTime(sec) {
    var t = Math.floor(Number(sec) || 0);
    var url = state.videoUrl ? state.videoUrl.split('?')[0] + '?t=' + t : '';
    if (url) window.open(url, '_blank');
    else toast('这条运行不是从视频抓来的，没有可跳转的地址');
  }

  function showDetail(it) {
    var box = $('detail');
    box.innerHTML = '';
    var title = el('h3', null, it.display || it.word);
    if (it.phonetic) title.appendChild(el('span', 'phon', ' /' + it.phonetic + '/'));
    box.appendChild(title);
    var meta = [];
    if (it.posLabel) meta.push(it.posLabel);
    meta.push('出现 ' + it.count + ' 次');
    box.appendChild(el('div', 'm', meta.join(' · ')));
    if (it.meaning) box.appendChild(el('div', 'mean', it.meaning));
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
    // 点开词条时立绘也换情绪：短语/口语词多点爱心，普通词得意一下
    try {
      var isPhr = it.pos === 'phr.';
      var isColloq = !!it.colloquial;
      if (isPhr || isColloq) setMood('love', '「' + (it.display || it.word) + '」这种说法超口语的，学会就能用！');
      else setMood('humph', '「' + (it.display || it.word) + '」出现 ' + it.count + ' 次，记一下～');
    } catch (e) { /* 表情出错不影响主流程 */ }    (it.usages || []).forEach(function (u) {
      var d = el('div', 'u');
      d.appendChild(el('div', 'sk', u.skeleton || u.text));
      d.appendChild(el('div', null, u.text));
      var line = el('div', null, u.src + ' · ' + fmtTime(u.t));
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
          senses: it.meaning ? [{ pos: it.pos === 'phr.' ? 'phr.' : (it.pos || 'other'), meaning: it.meaning }] : [],
          source: 'app',
        }],
      }).then(function (r) { toast(r.message); if (r.ok) reloadState(); });
    };
    box.appendChild(btn);
  }

  async function refreshView() {
    if (!state.runId) {
      state.view = { ok: false, items: [], message: '先在左边选一个运行' };
      renderStats(state.view);
      renderChips(state.view);
      renderItems(state.view);
      return;
    }
    var q = new URLSearchParams();
    q.set('runId', state.runId);
    q.set('dim', $('dim').value || 'pos');
    Object.keys(state.filter).forEach(function (k) {
      if (state.filter[k]) q.set(k, state.filter[k]);
    });
    var v = await getJSON('/api/view?' + q.toString());
    state.view = v;
    if (v.videoUrl) state.videoUrl = v.videoUrl;
    renderStats(v);
    renderChips(v);
    renderItems(v);
  }

  function selectRun(runId) {
    state.runId = runId;
    state.filter = {};
    renderRuns();
    var r = state.runs.find(function (x) { return x.runId === runId; });
    state.videoUrl = (r && r.videoUrl) || '';
    setMood('love', '这次分析完啦，点中间的词条看看它在原句里怎么用～');
    refreshView();
  }

  // ── 动作 ──────────────────────────────────────────────────────────────

  async function reloadState() {
    var s = await getJSON('/api/state');
    state.lists = s.lists || [];
    state.runs = s.runs || [];
    state.activeId = s.activeId || '';
    state.dims = s.dims || [];
    $('dataHint').textContent = s.dataOk ? '词表目录就绪' : '词表目录缺文件：' + (s.missingFiles || []).join('；');
    renderLists();
    renderRuns();
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
    var r = await postJSON('/api/run/fetch', {
      link: link,
      withDanmaku: $('withDanmaku').checked,
      asr: $('asr').checked,
    });
    if (r.logs && r.logs.length) log.textContent = r.logs.join('\n');
    if (!r.ok) {
      // 失败必须留在日志框里，光靠 toast 一闪就看不见了
      log.textContent += (log.textContent ? '\n' : '') + '抓取失败：' + (r.message || '未知原因');
      setMood('shock', '诶？！取数没成功…看看左下角的日志？');
      toast(r.message || '抓取失败', 'shock');
      return;
    }
    state.videoUrl = link;
    toast(r.message, 'humph');
    log.textContent += '\n正在分析…';
    setMood('sleepy', '词都捞到了，正在按词性分类整理～', true);
    var d = await postJSON('/api/run/digest', {
      inputs: r.inputs,
      wordlist: $('digestWordlist').value || '',
      title: r.title || '',
      link: link,
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
    var d = await postJSON('/api/run/digest', { inputs: list, wordlist: $('digestWordlist').value || '' });
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
    var r = await postJSON('/api/wordlist/create', { name: name });
    toast(r.message, moodOf(r.message, r.ok));
    await reloadState();
    if (r.ok) setMood('laugh', '新词表「' + name + '」建好啦！');
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

    $('btnFetch').onclick = doFetch;
    $('btnDigestLocal').onclick = doDigestLocal;
    $('btnBuild').onclick = doBuild;
    $('btnNewList').onclick = doNewList;
    $('btnRenameList').onclick = doRenameList;
    $('btnImportList').onclick = doImportList;
    $('btnExportCards').onclick = doExportList;
    $('btnFromRun').onclick = doFromRun;
    $('btnDocx').onclick = function () {
      postJSON('/api/open', { what: 'runs' }).then(function (r) {
        toast(r.message, moodOf(r.message, r.ok));
        setMood(r.ok ? 'humph' : 'pout', r.ok ? '文件夹打开啦，Word 都在里面！' : '打不开…可能是路径不对？');
      });
    };
    $('dim').onchange = function () { state.filter = {}; refreshView(); };
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
      // 一次都没选运行时也要把中栏的引导画出来，否则中间是空白
      if (!state.runId) renderItems({ ok: true, items: [] });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
