/* 万圣节怪物测试：所有文案只来自 halloween-quiz-cn.json / halloween-quiz-en.json，本文件不含任何界面文字。
   音效和怪物叫声都用 Web Audio 现场合成（无音频文件、断网可用）。 */
(function () {
  "use strict";

  var LANG_FILE = { zh: "cn", en: "en" };          // URL 参数 lang=zh|en → JSON 文件后缀
  var DEFAULT_LANG = "zh";
  var FONTS = ["ZCOOL KuaiLe", "Fredoka"];         // 中文 / 英文圆体
  var FONT_TIMEOUT = 2000;                         // 2 秒内字体没到就一直用系统字体
  var STORE_KEY = "halloween-quiz:last";          // 只存“上次结果”的怪物 id
  var NEXT_DELAY = 220;                            // 点选后短暂动画再进下一题
  var SUMMON_MS = 1500;                            // 揭晓前的召唤时长
  var reduceMotion = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

  var app = document.getElementById("app");
  var toastEl = document.getElementById("toast");
  var params = new URLSearchParams(location.search);
  var cache = {};
  var state = {
    lang: LANG_FILE[params.get("lang")] ? params.get("lang") : DEFAULT_LANG,
    data: null,
    view: "start",            // start | quiz | summon | result
    step: 0,
    answers: [],              // 每题所选选项的下标
    resultId: null,
    friendId: params.get("r"),
    sheetId: null,
    sound: true,
    reveal: false             // 刚揭晓，播放一次动画和声音
  };

  /* ---------- 数据 ---------- */
  function loadLang(lang) {
    var key = LANG_FILE[lang];
    if (cache[key]) return Promise.resolve(cache[key]);
    var embedded = window.QUIZ_EMBED && window.QUIZ_EMBED[key];
    // 双击打开（file://）浏览器不允许读本地 JSON，用 quiz-embed.js 里同步生成的副本
    if (location.protocol === "file:") return Promise.resolve(cache[key] = embedded);
    return fetch("halloween-quiz-" + key + ".json", { cache: "no-cache" })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .catch(function (e) { if (embedded) return embedded; throw e; })
      .then(function (d) { return (cache[key] = d); });
  }

  function resultById(id) {
    var list = state.data.results;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  /* 计分：累加每个所选选项的 score；最高分胜出。
     平分时取 results 数组中排在前面的——只有“严格大于”才替换当前最高者，所以先出现的保留。 */
  function computeResult(data, answers) {
    var total = {};
    data.results.forEach(function (r) { total[r.id] = 0; });
    answers.forEach(function (optIndex, qi) {
      var score = data.questions[qi].options[optIndex].score;
      Object.keys(score).forEach(function (id) { if (id in total) total[id] += score[id]; });
    });
    var best = data.results[0].id;
    data.results.forEach(function (r) { if (total[r.id] > total[best]) best = r.id; });
    return { id: best, total: total };
  }
  window.HalloweenQuiz = { computeResult: computeResult };   // 供测试矩阵脚本调用

  /* ---------- 工具 ---------- */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fill(tpl, vars) {
    return String(tpl).replace(/\{(\w+)\}/g, function (m, k) { return k in vars ? vars[k] : m; });
  }
  function readLast() { try { return localStorage.getItem(STORE_KEY); } catch (e) { return null; } }
  function saveLast(id) { try { localStorage.setItem(STORE_KEY, id); } catch (e) { /* 隐私模式等情况忽略 */ } }
  function shareUrl(id) {
    // 等同 origin + pathname；双击打开时 origin 为 "null"，这样写也能得到正确地址
    return location.href.split(/[?#]/)[0] + "?r=" + encodeURIComponent(id) + "&lang=" + state.lang;
  }
  function syncUrl() {
    var p = new URLSearchParams(location.search);
    p.set("lang", state.lang);
    try { history.replaceState(null, "", location.pathname + "?" + p.toString() + location.hash); } catch (e) { /* 沙箱环境可能禁止 */ }
  }
  function idNumber(answers) {         // 同样的答案得到同样的“身份证号”，四位数
    var h = 7;
    answers.forEach(function (a, i) { h = (h * 31 + a * 7 + i * 13) % 9973; });
    return String(1000 + (h % 9000));
  }

  /* ---------- 音效：Web Audio 现场合成 ---------- */
  var Sound = (function () {
    var ctx = null;
    function ac() {
      if (!state.sound) return null;
      if (!ctx) { var C = window.AudioContext || window.webkitAudioContext; if (!C) return null; ctx = new C(); }
      if (ctx.state === "suspended") ctx.resume();
      return ctx;
    }
    function tone(o) {
      var c = ac(); if (!c) return;
      var t = c.currentTime + (o.at || 0), osc = c.createOscillator(), g = c.createGain();
      osc.type = o.type || "sine";
      osc.frequency.setValueAtTime(o.f0, t);
      if (o.f1) osc.frequency.exponentialRampToValueAtTime(o.f1, t + o.dur);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(o.vol || 0.15, t + (o.attack || 0.012));
      g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
      if (o.vib) {
        var lfo = c.createOscillator(), lg = c.createGain();
        lfo.frequency.value = o.vib[0]; lg.gain.value = o.vib[1];
        lfo.connect(lg); lg.connect(osc.frequency); lfo.start(t); lfo.stop(t + o.dur);
      }
      osc.connect(g); g.connect(c.destination); osc.start(t); osc.stop(t + o.dur + 0.03);
    }
    function noise(o) {
      var c = ac(); if (!c) return;
      var t = c.currentTime + (o.at || 0), len = Math.max(1, Math.floor(c.sampleRate * o.dur));
      var buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0);
      for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      var src = c.createBufferSource(), bp = c.createBiquadFilter(), g = c.createGain();
      src.buffer = buf; bp.type = "bandpass"; bp.Q.value = o.q || 1;
      bp.frequency.setValueAtTime(o.f || 1000, t);
      if (o.f1) bp.frequency.exponentialRampToValueAtTime(o.f1, t + o.dur);
      g.gain.setValueAtTime(o.vol || 0.2, t); g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
      src.connect(bp); bp.connect(g); g.connect(c.destination); src.start(t);
    }
    var FX = {
      pop: function () { tone({ f0: 500, f1: 980, dur: 0.09, vol: 0.16 }); },
      step: function (n) { tone({ type: "triangle", f0: 330 + n * 45, f1: 420 + n * 45, dur: 0.12, vol: 0.12 }); },
      start: function () {           // 幽灵特雷门琴
        tone({ f0: 260, f1: 880, dur: 0.9, vol: 0.12, vib: [6, 18], attack: 0.08 });
        tone({ f0: 880, f1: 520, dur: 0.6, vol: 0.08, vib: [7, 22], at: 0.75 });
      },
      drum: function () {            // 召唤鼓点，越来越快
        [0, 0.28, 0.5, 0.68, 0.82, 0.93, 1.02, 1.1, 1.17, 1.23].forEach(function (at, i) {
          noise({ at: at, dur: 0.07, f: 180 + i * 25, q: 0.8, vol: 0.18 + i * 0.02 });
        });
        tone({ type: "triangle", f0: 220, f1: 660, dur: 0.25, vol: 0.14, at: 1.3 });
      },
      bat: function () { [0, 0.11, 0.24].forEach(function (at) { tone({ type: "square", f0: 2300, f1: 3300, dur: 0.07, vol: 0.05, at: at }); }); },
      vampire: function () {
        [110, 131, 165, 196].forEach(function (f) { tone({ type: "sawtooth", f0: f, dur: 1.3, vol: 0.04, attack: 0.05 }); });
        tone({ f0: 300, f1: 140, dur: 0.5, vol: 0.12, at: 0.9, vib: [12, 15] });
      },
      mummy: function () { tone({ type: "sawtooth", f0: 190, f1: 85, dur: 1.2, vol: 0.08, vib: [5, 9], attack: 0.15 }); },
      zombie: function () {
        tone({ type: "square", f0: 120, f1: 70, dur: 0.9, vol: 0.07, vib: [10, 25] });
        tone({ type: "sine", f0: 90, f1: 60, dur: 0.25, vol: 0.2, at: 0.95 });
      },
      reaper: function () {
        noise({ dur: 0.6, f: 300, f1: 3500, q: 2, vol: 0.25 });
        tone({ f0: 98, dur: 1.6, vol: 0.2, at: 0.45 }); tone({ f0: 196, dur: 1.2, vol: 0.06, at: 0.45 });
      },
      pumpkin: function () {         // 失落的长号：哇 哇 哇 哇——
        [392, 370, 349].forEach(function (f, i) { tone({ type: "triangle", f0: f, dur: 0.32, vol: 0.13, at: i * 0.34 }); });
        tone({ type: "triangle", f0: 330, f1: 300, dur: 0.9, vol: 0.13, at: 1.02, vib: [6, 10] });
      },
      joker: function () {           // 叭叭！+ 滑哨
        [0, 0.2].forEach(function (at) { tone({ type: "square", f0: 440, dur: 0.14, vol: 0.08, at: at }); tone({ type: "square", f0: 554, dur: 0.14, vol: 0.06, at: at }); });
        tone({ f0: 500, f1: 1500, dur: 0.45, vol: 0.12, at: 0.45 });
      },
      cat: function () {             // 喵——
        tone({ type: "sawtooth", f0: 520, f1: 900, dur: 0.18, vol: 0.06 });
        tone({ type: "sawtooth", f0: 900, f1: 420, dur: 0.45, vol: 0.06, at: 0.17, vib: [8, 12] });
      }
    };
    return { play: function (name, arg) { try { if (FX[name]) FX[name](arg); } catch (e) { /* 部分浏览器不支持时静默 */ } } };
  })();

  /* ---------- 插画：results[].art 填图片地址即替换；为空时用内置贴纸风占位 ---------- */
  function artHTML(r, cls) {
    if (r.art) return '<img class="art ' + cls + '" src="' + esc(r.art) + '" alt="' + esc(r.name) + '">';
    return '<div class="art ' + cls + '" data-monster="' + esc(r.id) + '" role="img" aria-label="' + esc(r.name) + '">' + (ART[r.id] || ART._) + "</div>";
  }
  function eyes(l, r, y, rad, pupil) {   // 一对会眨的眼睛
    var p = pupil || "#1a1410";
    return '<g class="blink">' + [l, r].map(function (x) {
      return '<circle cx="' + x + '" cy="' + y + '" r="' + rad + '" fill="#fff"/><circle cx="' + (x + 1.5) + '" cy="' + (y + 1) + '" r="' + (rad * 0.55) + '" fill="' + p + '" class="pupil"/>' +
        '<circle cx="' + (x + 3) + '" cy="' + (y - 2) + '" r="' + (rad * 0.2) + '" fill="#fff"/>';
    }).join("") + "</g>";
  }
  function blush(l, r, y) { return '<ellipse cx="' + l + '" cy="' + y + '" rx="9" ry="5" fill="#ff8fb8" opacity=".75"/><ellipse cx="' + r + '" cy="' + y + '" rx="9" ry="5" fill="#ff8fb8" opacity=".75"/>'; }
  var OUT = ' stroke="#1a1410" stroke-width="5" stroke-linejoin="round"';
  var SVG = function (inner) { return '<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' + inner + "</svg>"; };
  var ART = {
    bat: SVG('<g class="flap"><path d="M62 108 Q22 70 6 112 Q24 102 28 126 Q40 108 52 128Z M138 108 Q178 70 194 112 Q176 102 172 126 Q160 108 148 128Z" fill="#2b2118"' + OUT + '/></g>' +
      '<path d="M70 74 L78 36 L96 66Z M130 74 L122 36 L104 66Z" fill="#1a1410"' + OUT + '/><circle cx="100" cy="110" r="48" fill="#1a1410"' + OUT + '/>' +
      eyes(82, 118, 104, 11) + '<path d="M68 88 L94 96 M132 88 L106 96" stroke="#ff7a1a" stroke-width="6" stroke-linecap="round"/>' +
      blush(72, 128, 124) + '<path d="M88 132 Q100 126 112 132" stroke="#fff" stroke-width="4" fill="none" stroke-linecap="round"/><path d="M93 131 L96 140 L99 131Z" fill="#fff"/>'),
    vampire: SVG('<path d="M34 182 L58 116 L100 152 L142 116 L166 182Z" fill="#d6224a"' + OUT + '/><path d="M54 182 L70 132 L100 158 L130 132 L146 182Z" fill="#1a1410"/>' +
      '<circle cx="100" cy="100" r="48" fill="#fff3d6"' + OUT + '/><path d="M52 96 Q54 50 100 50 Q146 50 148 96 Q126 70 100 88 Q74 70 52 96Z" fill="#1a1410"' + OUT + '/>' +
      '<g class="blink"><path d="M74 104 Q85 96 96 104 M104 104 Q115 96 126 104" stroke="#1a1410" stroke-width="5" fill="none" stroke-linecap="round"/></g>' +
      blush(72, 128, 116) + '<path d="M84 126 Q100 136 116 126" stroke="#1a1410" stroke-width="4" fill="none" stroke-linecap="round"/><path d="M90 128 L93 139 L97 130Z M103 130 L107 139 L110 128Z" fill="#fff"/>'),
    mummy: SVG('<rect x="52" y="44" width="96" height="128" rx="46" fill="#fff3d6"' + OUT + '/>' +
      '<path d="M58 76 L142 64 M54 102 L146 92 M56 136 L144 148 M64 158 L136 164" stroke="#d6c59d" stroke-width="7" stroke-linecap="round"/>' +
      '<rect x="64" y="106" width="72" height="24" rx="12" fill="#2a1f33"/>' + '<g class="blink"><circle cx="86" cy="118" r="8" fill="#fff"/><circle cx="87" cy="119" r="4.5" fill="#1a1410" class="pupil"/></g>' +
      '<path d="M104 118 L126 118" stroke="#fff3d6" stroke-width="6" stroke-linecap="round"/>' + blush(76, 124, 142) +
      '<path d="M140 70 Q160 60 168 76 Q156 74 150 84" fill="#fff3d6"' + OUT + '/>'),
    zombie: SVG('<circle cx="100" cy="106" r="56" fill="#a6cf3f"' + OUT + '/><path d="M70 68 L98 62 M76 60 L78 72 M86 58 L88 70" stroke="#33461a" stroke-width="4" stroke-linecap="round"/>' +
      '<g class="blink"><circle cx="80" cy="102" r="12" fill="#fff"/><path d="M68 102 Q80 92 92 102Z" fill="#a6cf3f"/><circle cx="81" cy="105" r="4.5" fill="#1a1410" class="pupil"/>' +
      '<circle cx="122" cy="106" r="9" fill="#fff"/><circle cx="120" cy="107" r="4" fill="#1a1410" class="pupil"/></g>' + blush(70, 132, 124) +
      '<ellipse cx="102" cy="136" rx="13" ry="9" fill="#33461a"/><path d="M110 142 Q112 154 108 158" stroke="#7fd3ff" stroke-width="4" fill="none" stroke-linecap="round"/>'),
    reaper: SVG('<path d="M162 28 L162 188" stroke="#8a7b66" stroke-width="7" stroke-linecap="round"/><path d="M162 32 Q114 24 100 58 Q130 42 162 52Z" fill="#e3ddee"' + OUT + '/>' +
      '<path d="M100 28 Q38 38 40 112 Q40 162 54 184 L146 184 Q160 162 160 112 Q162 38 100 28Z" fill="#1a1410"' + OUT + '/>' +
      '<ellipse cx="100" cy="108" rx="38" ry="42" fill="#3b3027"/>' +
      '<g class="blink"><path d="M76 96 L96 104 L78 110Z M124 96 L104 104 L122 110Z" fill="#ff7a1a"/></g>' +
      '<path d="M84 134 Q100 124 116 134" stroke="#ff7a1a" stroke-width="5" fill="none" stroke-linecap="round"/><path d="M60 30 l6 -10 M70 22 l4 -8" stroke="#ff7a1a" stroke-width="4" stroke-linecap="round"/>'),
    pumpkin: SVG('<path d="M100 56 Q102 36 118 30" stroke="#3f7a2e" stroke-width="9" fill="none" stroke-linecap="round"/><path d="M110 40 Q126 30 134 42 Q120 46 110 40Z" fill="#6cc24a"/>' +
      '<ellipse cx="100" cy="116" rx="72" ry="60" fill="#ff7a1a"' + OUT + '/><path d="M100 58 Q76 116 100 174 M100 58 Q124 116 100 174 M60 72 Q42 116 60 162 M140 72 Q158 116 140 162" stroke="#d95f0a" stroke-width="4" fill="none"/>' +
      '<g class="blink"><path d="M68 104 L92 98 L86 118Z M132 104 L108 98 L114 118Z" fill="#3a1d05"/></g>' + blush(66, 134, 130) +
      '<path d="M80 150 Q100 136 120 150" stroke="#3a1d05" stroke-width="6" fill="none" stroke-linecap="round"/><path class="tear" d="M122 120 Q127 130 122 135 Q117 130 122 120Z" fill="#8fd3ff"/>'),
    joker: SVG('<path d="M100 66 L54 22 L62 74Z" fill="#1a1410"' + OUT + '/><path d="M100 66 L146 22 L138 74Z" fill="#ff7a1a"' + OUT + '/><circle cx="54" cy="22" r="9" fill="#fff3d6"' + OUT + '/><circle cx="146" cy="22" r="9" fill="#fff3d6"' + OUT + '/>' +
      '<circle cx="100" cy="114" r="52" fill="#fff3d6"' + OUT + '/>' + blush(70, 130, 126) + eyes(82, 118, 104, 9) +
      '<circle cx="100" cy="120" r="10" fill="#e5383b"' + OUT + '/><path d="M74 134 Q100 164 126 134 Q100 146 74 134Z" fill="#1a1410"/><path d="M88 146 Q100 154 112 146" fill="#ff8fb8"/>'),
    cat: SVG('<path class="tail" d="M150 152 Q194 142 178 100" stroke="#1d1628" stroke-width="12" fill="none" stroke-linecap="round"/>' +
      '<path d="M56 86 L62 36 L94 66Z M144 86 L138 36 L106 66Z" fill="#1a1410"' + OUT + '/><path d="M64 70 L66 50 L80 64Z M136 70 L134 50 L120 64Z" fill="#ff8fb8"/>' +
      '<circle cx="100" cy="112" r="54" fill="#1a1410"' + OUT + '/>' +
      '<g class="blink"><path d="M68 106 Q81 94 94 106 Q81 113 68 106Z M106 106 Q119 94 132 106 Q119 113 106 106Z" fill="#fff3d6"/>' +
      '<path d="M74 101 L92 101 M108 101 L126 101" stroke="#1a1410" stroke-width="6" stroke-linecap="round"/></g>' + blush(70, 130, 124) +
      '<path d="M92 126 Q96 132 100 126 Q104 132 108 126" stroke="#ff8fb8" stroke-width="3" fill="none" stroke-linecap="round"/>' +
      '<path d="M58 122 L34 118 M58 130 L34 134 M142 122 L166 118 M142 130 L166 134" stroke="#8a7b66" stroke-width="3" stroke-linecap="round"/>'),
    _: SVG('<circle cx="100" cy="104" r="54" fill="#1a1410"' + OUT + '/>' + eyes(82, 100, 100, 10))
  };
  var CAULDRON = SVG('<ellipse cx="100" cy="72" rx="58" ry="16" fill="#a6cf3f"/>' +
    '<g class="bubbles"><circle cx="80" cy="60" r="9" fill="#c9e86f"/><circle cx="112" cy="54" r="12" fill="#c9e86f"/><circle cx="96" cy="40" r="6" fill="#c9e86f"/></g>' +
    '<path d="M38 74 Q34 168 100 172 Q166 168 162 74Z" fill="#1a1410"' + OUT + '/><rect x="32" y="66" width="136" height="14" rx="7" fill="#3b3027"' + OUT + '/>' +
    '<path d="M70 188 L80 168 M130 188 L120 168" stroke="#1a1410" stroke-width="8" stroke-linecap="round"/>' +
    '<path d="M60 186 Q80 170 100 186 Q120 170 140 186" stroke="#ff7a1a" stroke-width="10" fill="none" stroke-linecap="round"/>');
  var BAT = '<svg viewBox="0 0 120 50"><path d="M60 22 L52 8 L56 24 Q40 6 18 4 Q26 14 22 20 Q12 16 0 20 Q14 28 16 40 Q28 30 40 36 Q44 26 60 42 Q76 26 80 36 Q92 30 104 40 Q106 28 120 20 Q108 16 98 20 Q94 14 102 4 Q80 6 64 24 L68 8Z" fill="#1a1410"/></svg>';
  var HERO_DECOR = '<div class="hero-decor" aria-hidden="true"><span class="moon"></span>' +
    '<span class="bat b1">' + BAT + '</span><span class="bat b2">' + BAT + '</span><span class="bat b3">' + BAT + "</span>" +
    '<span class="flyby">' + BAT + "</span></div>";
  var GHOST = SVG('<path d="M40 170 L40 90 Q40 30 100 30 Q160 30 160 90 L160 170 L140 150 L120 170 L100 150 L80 170 L60 150Z" fill="#fff6e5"' + OUT + '/>' +
    '<circle cx="80" cy="90" r="9" fill="#1a1410" class="pupil"/><circle cx="120" cy="90" r="9" fill="#1a1410" class="pupil"/><ellipse cx="100" cy="118" rx="8" ry="10" fill="#1a1410"/>');
  var BITS = [   // 撒出来的小东西：糖果、蝙蝠、星星
    '<svg viewBox="0 0 40 20"><path d="M10 10 L2 3 L2 17Z M30 10 L38 3 L38 17Z" fill="#ff8fb8"/><circle cx="20" cy="10" r="9" fill="#ff7a1a"/></svg>',
    '<svg viewBox="0 0 40 20"><path d="M20 12 Q10 0 2 8 Q8 8 8 14 Q14 8 20 16 Q26 8 32 14 Q32 8 38 8 Q30 0 20 12Z" fill="#1a1410"/></svg>',
    '<svg viewBox="0 0 20 20"><path d="M10 0 L13 7 L20 8 L14 12 L16 20 L10 15 L4 20 L6 12 L0 8 L7 7Z" fill="#fff3d6"/></svg>',
    '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="8" fill="#a6cf3f"/></svg>'
  ];

  function burst(x, y, n) {
    if (reduceMotion) return;
    var layer = document.createElement("div");
    layer.className = "burst";
    for (var i = 0; i < n; i++) {
      var s = document.createElement("span"), a = Math.random() * Math.PI * 2, d = 80 + Math.random() * 160;
      s.innerHTML = BITS[i % BITS.length];
      s.style.left = x + "px"; s.style.top = y + "px";
      s.style.setProperty("--dx", Math.cos(a) * d + "px");
      s.style.setProperty("--dy", Math.sin(a) * d - 60 + "px");
      s.style.setProperty("--rot", (Math.random() * 720 - 360) + "deg");
      s.style.animationDelay = (Math.random() * 0.12) + "s";
      layer.appendChild(s);
    }
    document.body.appendChild(layer);
    setTimeout(function () { layer.remove(); }, 1600);
  }

  /* ---------- 渲染 ---------- */
  function topbar() {
    var ui = state.data.ui;
    return '<div class="topbar">' +
      '<button class="pill" type="button" data-act="sound" aria-pressed="' + state.sound + '">' + esc(state.sound ? ui.soundOn : ui.soundOff) + "</button>" +
      '<button class="pill" type="button" data-act="lang" aria-label="' + esc(ui.langSwitchLabel) + '">' + esc(ui.langSwitch) + "</button></div>";
  }

  function friendBanner() {
    var r = state.friendId && resultById(state.friendId);
    if (!r) return "";                               // 非法 r 参数直接忽略
    var ui = state.data.ui;
    return '<section class="friend">' + artHTML(r, "friend-art") +
      '<div class="friend-text"><p class="eyebrow">' + esc(ui.friendEyebrow) + "</p>" +
      '<p class="friend-got">' + esc(ui.friendGot) + " <b>" + esc(r.name) + "</b></p>" +
      '<p class="friend-ask">' + esc(ui.friendAsk) + "</p>" +
      '<p class="friend-lead">' + esc(ui.friendLead) + "</p>" +
      '<button class="btn btn-primary" type="button" data-act="start">' + esc(ui.friendGo) + "</button></div></section>";
  }

  function renderStart() {
    var d = state.data, ui = d.ui, last = resultById(readLast());
    document.title = d.meta.title;
    app.innerHTML = topbar() + friendBanner() +
      '<section class="start">' + HERO_DECOR +
      '<div class="parade">' + d.results.map(function (r, i) {
        return '<button class="poke" type="button" data-act="poke" data-id="' + esc(r.id) + '" style="--i:' + i + '" aria-label="' + esc(r.name) + '">' + artHTML(r, "parade-art") + "</button>";
      }).join("") + "</div>" +
      '<p class="poke-hint">' + esc(ui.pokeHint) + "</p>" +
      '<h1 class="title" aria-label="' + esc(d.meta.title) + '"><span aria-hidden="true">' +
      Array.from(d.meta.title).map(function (c, i) { return '<span class="ch" style="--c:' + i + '">' + esc(c) + "</span>"; }).join("") + "</span></h1>" +
      '<p class="subtitle">' + esc(d.meta.subtitle) + "</p>" +
      '<p class="intro">' + esc(d.meta.intro) + "</p>" +
      '<ul class="facts"><li>' + esc(ui.factQ) + "</li><li>" + esc(ui.factMin) + "</li><li>" + esc(ui.factR) + "</li></ul>" +
      '<button class="btn btn-primary btn-big" type="button" data-act="start">' + esc(ui.start) + "</button>" +
      (last ? '<p class="last">' + esc(ui.lastResult) + " <b>" + esc(last.name) + "</b></p>" : "") +
      '<div class="maybe"><p class="eyebrow">' + esc(ui.maybeYou) + '</p><p class="maybe-list">' +
      d.results.map(function (r) { return "<span>" + esc(r.name) + "</span>"; }).join("") + "</p></div>" +
      "</section>" + footer();
  }

  function renderQuiz() {
    var d = state.data, ui = d.ui, q = d.questions[state.step], total = d.questions.length;
    var chosen = state.answers[state.step], pct = (state.step + 1) / total * 100;
    document.title = d.meta.title;
    app.innerHTML = topbar() +
      '<section class="quiz">' +
      '<div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="' + total + '" aria-valuenow="' + (state.step + 1) + '">' +
      '<div class="progress-bar" style="width:' + pct + '%"></div>' +
      '<span class="progress-ghost" style="left:' + pct + '%">' + GHOST + "</span></div>" +
      '<p class="progress-text">' + esc(fill(ui.progress, { n: state.step + 1, total: total })) + "</p>" +
      '<h2 class="question">' + esc(q.text) + "</h2>" +
      '<div class="options">' + q.options.map(function (o, i) {
        return '<button class="option' + (chosen === i ? " is-chosen" : "") + '" type="button" data-act="answer" data-i="' + i + '" style="--o:' + i + '">' + esc(o.text) + "</button>";
      }).join("") + "</div>" +
      '<button class="btn btn-ghost prev" type="button" data-act="prev"' + (state.step === 0 ? " disabled" : "") + ">" + esc(ui.prev) + "</button>" +
      "</section>";
  }

  function renderSummon() {
    app.innerHTML = topbar() + '<section class="summon"><div class="cauldron">' + CAULDRON +
      '<span class="orbit o1">' + BAT + '</span><span class="orbit o2">' + BAT + '</span><span class="orbit o3">' + BAT + "</span></div>" +
      '<p class="summon-text">' + esc(state.data.ui.summoning) + "</p></section>";
  }

  function chip(id) {
    var r = resultById(id);
    return r ? '<button class="chip" type="button" data-act="peek" data-id="' + esc(r.id) + '">' + esc(r.name) + "</button>" : "";
  }

  function renderResult() {
    var d = state.data, ui = d.ui, r = resultById(state.resultId);
    document.title = fill(ui.titleResult, { name: r.name, title: d.meta.title });
    var showEn = r.nameEn && r.nameEn.toLowerCase() !== r.name.toLowerCase();   // 英文版 name 已是英文时不重复
    app.innerHTML = topbar() +
      '<article class="card' + (state.reveal ? " is-reveal" : "") + '" id="card">' +
      '<header class="card-head"><span>' + esc(ui.idTitle) + "</span><span>" + esc(fill(ui.idNo, { n: idNumber(state.answers) })) + "</span></header>" +
      '<p class="eyebrow">' + esc(d.meta.resultLabel) + "</p>" +
      '<h1 class="name">' + esc(r.name) + "</h1>" +
      (showEn ? '<p class="name-en">' + esc(r.nameEn) + "</p>" : "") +
      '<div class="art-wrap" data-act="jump">' + artHTML(r, "card-art") + '<span class="stamp">' + esc(ui.stamp) + "</span></div>" +
      '<p class="tagline"><span>' + esc(r.tagline) + "</span></p>" +
      '<p class="desc">' + esc(r.desc) + "</p>" +
      '<dl class="traits"><div><dt>' + esc(ui.power) + "</dt><dd>" + esc(r.power) + "</dd></div>" +
      "<div><dt>" + esc(ui.weakness) + "</dt><dd>" + esc(r.weakness) + "</dd></div></dl>" +
      '<div class="match"><div class="match-row"><span class="match-label good">' + esc(ui.best) + "</span>" + r.match.best.map(chip).join("") + "</div>" +
      '<div class="match-row"><span class="match-label bad">' + esc(ui.worst) + "</span>" + r.match.worst.map(chip).join("") + "</div></div>" +
      '<p class="card-brand">' + esc(ui.cardBrand) + "</p>" +
      "</article>" +
      '<p class="match-hint">' + esc(ui.matchHint) + "</p>" +
      '<section class="share">' +
'<button class="btn btn-voice" type="button" data-act="listen">' + esc(ui.listen) + "</button>" +
      '<p class="share-hint">' + esc(ui.shareHint) + "</p>" +
      '<div class="share-btns"><button class="btn btn-primary" type="button" data-act="copyRes">' + esc(ui.copyRes) + "</button>" +
      '<button class="btn btn-ghost" type="button" data-act="copyLink">' + esc(ui.copyLink) + "</button>" +
      '<button class="btn btn-ghost" type="button" data-act="retry">' + esc(ui.retry) + "</button></div>" +
      '<div class="manual" id="manual" hidden><p>' + esc(ui.copyManual) + '</p><textarea id="manual-text" readonly rows="3"></textarea></div>' +
      "</section>" +
      "<!-- premium-slot -->" +                         /* 付费解锁等扩展内容的预留位 */
      footer();
    var tag = app.querySelector(".card .tagline");                    // 判语超过两行就缩小一号字，保证一屏截得下
    if (tag && tag.getBoundingClientRect().height > 2.2 * parseFloat(getComputedStyle(tag).lineHeight)) tag.classList.add("long");
    if (state.reveal) {
      state.reveal = false;
      var box = app.querySelector(".card-art").getBoundingClientRect();
      burst(box.left + box.width / 2, box.top + box.height / 2, 26);
      Sound.play(r.id);
    }
  }

  function footer() { return '<footer class="footer">' + esc(state.data.ui.footer) + "</footer>"; }

  function renderSheet() {
    var old = document.getElementById("sheet");
    if (old) old.remove();
    var r = state.sheetId && resultById(state.sheetId);
    if (!r) return;
    var el = document.createElement("div");
    el.id = "sheet";
    el.className = "sheet";
    el.innerHTML = '<div class="sheet-panel" role="dialog" aria-modal="true" aria-label="' + esc(r.name) + '">' +
      artHTML(r, "sheet-art") + '<h3 class="name small">' + esc(r.name) + "</h3>" +
      '<p class="tagline"><span>' + esc(r.tagline) + '</span></p><p class="desc">' + esc(r.desc) + "</p>" +
      '<button class="btn btn-primary" type="button" data-act="closeSheet">' + esc(state.data.ui.close) + "</button></div>";
    document.body.appendChild(el);
    el.querySelector("button").focus();
  }

  function render() {
    document.documentElement.lang = state.data.meta.lang;
    document.documentElement.style.setProperty("--brand", state.data.meta.brand);
    ({ start: renderStart, quiz: renderQuiz, summon: renderSummon, result: renderResult })[state.view]();
    renderSheet();
  }

  /* ---------- 交互 ---------- */
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(function () { toastEl.hidden = true; }, 1800);
  }

  function showManual(text) {          // 微信等环境没有剪贴板权限：展示并选中文字，用户长按复制
    var box = document.getElementById("manual"), ta = document.getElementById("manual-text");
    ta.value = text;
    box.hidden = false;
    ta.focus();
    ta.select();
    try { ta.setSelectionRange(0, text.length); } catch (e) { /* 旧浏览器 */ }
  }

  function copy(text) {
    Sound.play("pop");
    if (!navigator.clipboard || !navigator.clipboard.writeText) return showManual(text);
    navigator.clipboard.writeText(text).then(function () { toast(state.data.ui.copied); }, function () { showManual(text); });
  }

  function finish() {
    state.resultId = computeResult(state.data, state.answers).id;
    saveLast(state.resultId);
    state.view = "summon";
    render();
    Sound.play("drum");
    setTimeout(function () {
      state.view = "result";
      state.reveal = true;
      render();
      window.scrollTo(0, 0);
    }, reduceMotion ? 300 : SUMMON_MS);
  }

  var actions = {
    lang: function () {
      var next = state.lang === "zh" ? "en" : "zh";
      Sound.play("pop");
      loadLang(next).then(function (d) { state.lang = next; state.data = d; syncUrl(); render(); });   // 保留进度，只换文案
    },
    sound: function () {
      state.sound = !state.sound;
      Sound.play("pop");
      render();
    },
    start: function () { Sound.play("start"); state.view = "quiz"; state.step = 0; state.answers = []; render(); window.scrollTo(0, 0); },
    answer: function (btn, ev) {
      if (state.busy) return;                                  // 防止连点跳过一题
      state.busy = true;
      var i = Number(btn.getAttribute("data-i"));
      state.answers[state.step] = i;
      btn.classList.add("is-chosen");
      Sound.play("step", state.step);
      if (ev && ev.clientX) burst(ev.clientX, ev.clientY, 8);
      setTimeout(function () {
        state.busy = false;
        if (state.step < state.data.questions.length - 1) { state.step += 1; render(); window.scrollTo(0, 0); }
        else finish();
      }, NEXT_DELAY);
    },
    prev: function () { if (state.step > 0) { Sound.play("pop"); state.step -= 1; render(); } },
    retry: function () { Sound.play("start"); state.view = "start"; state.answers = []; state.step = 0; render(); window.scrollTo(0, 0); },
    copyLink: function () { copy(shareUrl(state.resultId)); },
    copyRes: function () { copy(resultById(state.resultId).shareLine + "\n" + shareUrl(state.resultId)); },
    listen: function () { var was = state.sound; state.sound = true; Sound.play(state.resultId); state.sound = was; },   // 主动点按就算静音也叫一声
    poke: function (btn) {
      var id = btn.getAttribute("data-id");
      Sound.play(id);
      btn.classList.remove("is-poked"); void btn.offsetWidth; btn.classList.add("is-poked");
    },
    jump: function (el) {
      Sound.play(state.resultId);
      el.classList.remove("is-jumping"); void el.offsetWidth; el.classList.add("is-jumping");
    },
    peek: function (btn) { Sound.play(btn.getAttribute("data-id")); state.sheetId = btn.getAttribute("data-id"); renderSheet(); },
    closeSheet: function () { state.sheetId = null; renderSheet(); }
  };

  document.addEventListener("click", function (ev) {
    var t = ev.target.closest("[data-act]");
    if (t && actions[t.getAttribute("data-act")]) { actions[t.getAttribute("data-act")](t, ev); return; }
    if (ev.target.id === "sheet") actions.closeSheet();          // 点遮罩关闭
  });
  document.addEventListener("keydown", function (ev) { if (ev.key === "Escape" && state.sheetId) actions.closeSheet(); });

  /* ---------- 字体：2 秒内加载成功才启用，否则保持系统字体，绝不白屏等字体 ---------- */
  function loadFonts(sample) {
    if (!document.fonts || !document.fonts.load) return;
    var timeout = new Promise(function (res) { setTimeout(res, FONT_TIMEOUT, false); });
    var loads = FONTS.map(function (f) { return document.fonts.load('1em "' + f + '"', sample).then(function (x) { return x.length > 0; }); });
    Promise.race([Promise.all(loads).then(function (ok) { return ok.some(Boolean); }), timeout])
      .then(function (ok) { if (ok) document.documentElement.classList.add("font-ok"); })
      .catch(function () { /* 断网时字体失败，保持系统字体 */ });
  }

  /* ---------- 小动画：眼珠跟着手指转；角落里的幽灵偶尔探头 ---------- */
  if (!reduceMotion) {
    var pending = false, px = 0, py = 0;
    document.addEventListener("pointermove", function (ev) {
      px = ev.clientX; py = ev.clientY;
      if (pending) return;
      pending = true;
      requestAnimationFrame(function () {
        pending = false;
        document.querySelectorAll(".pupil").forEach(function (el) {
          var b = el.getBoundingClientRect(), dx = px - (b.left + b.width / 2), dy = py - (b.top + b.height / 2);
          var len = Math.sqrt(dx * dx + dy * dy) || 1, k = Math.min(2.5, len / 40);
          el.style.transform = "translate(" + (dx / len * k) + "px," + (dy / len * k) + "px)";
        });
      });
    }, { passive: true });
    var peeker = document.createElement("div");
    peeker.className = "peeker";
    peeker.setAttribute("aria-hidden", "true");
    peeker.innerHTML = GHOST;
    document.body.appendChild(peeker);
  }

  loadLang(state.lang).then(function (d) {
    state.data = d;
    loadFonts(d.meta.title);
    render();
  }).catch(function () {
    app.innerHTML = '<div class="load-error" aria-hidden="true">' + ART._ + "</div>";
  });
})();
