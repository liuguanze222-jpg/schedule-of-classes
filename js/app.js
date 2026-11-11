/* ============================================================
 * 课程表主逻辑（app.js）
 * ------------------------------------------------------------
 * 模块划分：
 *   1. 常量与状态        2. 工具函数
 *   3. 数据持久化        4. 周次计算
 *   5. 课表渲染（网格 + 课程块）
 *   6. 悬浮详情气泡      7. 课程 新增/编辑/删除 弹窗
 *   8. 文件导入（ics/excel → 预览 → 入库）＋ 粘贴导入（教务系统网页表格）
 *   9. 导出图片          10. 设置面板
 *  11. 事件绑定与初始化
 * ============================================================ */
(function () {
  'use strict';

  /* ============================================================
   * 1. 常量与状态
   * ============================================================ */
  var LS_COURSES = 'kbc.courses.v1';    // localStorage 键：课程数据
  var LS_SETTINGS = 'kbc.settings.v1';  // localStorage 键：设置（学期起始日等）
  var MAX_WEEK = 30;                    // 学期最长周数

  var DAY_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

  // 色板（与 style.css 中 .c0~.c9 一一对应，仅取底色做选色圆点）
  var PALETTE_BG = ['#e6edff', '#e0f3e8', '#ffeedd', '#f0e8ff', '#ffe8ef',
                    '#def2f4', '#fdf4d7', '#e7e9ff', '#ffe5e5', '#e8eef4'];

  // 模块材质选项（id 对应 body[data-mat]，样式见 style.css 材质系统）
  var MATERIALS = [
    { id: 'solid',  name: '默认' },
    { id: 'glass',  name: '玻璃' },
    { id: 'frost',  name: '磨砂' },
    { id: 'fluid',  name: '流体透明' },
    { id: 'liquid', name: '液态玻璃' }
  ];

  // 各材质的默认参数（外观面板滑杆可按材质覆盖记忆）
  // blur=模糊px(frost)；alpha=面板不透明度；shine=动态高光强度；ripple=水纹强度；
  // sat=饱和度；dispersion=色散强度（SDF 滤镜的 RGB 分离量）
  var MAT_PARAMS = {
    solid:  { blur: 0,  alpha: 1,   shine: 0,   ripple: .6, sat: 1,   dispersion: 0 },
    glass:  { blur: 16, alpha: .5,  shine: .3,  ripple: .8, sat: 1.5, dispersion: .5 },
    frost:  { blur: 30, alpha: .78, shine: .18, ripple: .5, sat: 1.2, dispersion: .3 },
    fluid:  { blur: 10, alpha: .32, shine: .22, ripple: 1,  sat: 1.4, dispersion: .45 },
    liquid: { blur: 18, alpha: .42, shine: .45, ripple: 1,  sat: 1.9, dispersion: .8 }
  };

  // 内置渐变壁纸（css 为 background-image 值）
  var WALLS = [
    { id: 'w1', name: '晨雾', css: 'linear-gradient(135deg,#dbe4ff 0%,#f5f7fa 48%,#ffeef2 100%)' },
    { id: 'w2', name: '薄荷', css: 'linear-gradient(135deg,#d8f3e8 0%,#f0faf5 48%,#dff3ff 100%)' },
    { id: 'w3', name: '暖阳', css: 'linear-gradient(135deg,#ffecd9 0%,#fff6ea 48%,#ffe3ec 100%)' },
    { id: 'w4', name: '紫霞', css: 'linear-gradient(135deg,#e6d9ff 0%,#f6f2ff 48%,#ffe1f0 100%)' },
    { id: 'w5', name: '星夜', css: 'linear-gradient(135deg,#1b2340 0%,#10131a 55%,#2a1b3d 100%)' },
    { id: 'w6', name: '深海', css: 'linear-gradient(135deg,#0f2027 0%,#203a43 50%,#2c5364 100%)' }
  ];

  // 表头样式主题（外观面板 / 点击课表表头可切换）
  var HEADER_STYLES = [
    { id: 'blue',     name: '经典蓝', a: '#2f69ff', b: '#5884ff', text: '#2b5bd7', textDark: '#a8c0ee' },
    { id: 'teal',     name: '青碧',   a: '#0e9f8e', b: '#3cc2ae', text: '#0b7a6d', textDark: '#8fe0d4' },
    { id: 'purple',   name: '紫霞',   a: '#7c5cd6', b: '#a78bfa', text: '#5f42b8', textDark: '#c9b8f5' },
    { id: 'pink',     name: '玫粉',   a: '#d65c9e', b: '#f08ec0', text: '#b83e7f', textDark: '#f3b8d8' },
    { id: 'orange',   name: '暖阳',   a: '#e08a3c', b: '#f2b25c', text: '#a05f16', textDark: '#f5d3a0' },
    { id: 'graphite', name: '石墨',   a: '#55607a', b: '#7c86a0', text: '#3d465c', textDark: '#b8c2d8' },
    { id: 'none',     name: '无色',   a: '#c3cad6', b: '#eef1f5', text: '#4a5568', textDark: '#b6c0d0' }
  ];

  // 当前生效的节次表：默认取 parsers.js 的 12 节配置；
  // 设置里可改节数 / 采用贵校作息（导入时自动检测），rebuildPeriods() 重建
  var PERIODS = [];

  // 全局状态
  var state = {
    courses: [],                        // 课程数组
    week: 1,                            // 当前查看的周次
    settings: {                         // 持久化设置
      semesterStart: '',                // 学期第 1 周周一（'YYYY-MM-DD'，空=未设置）
      theme: 'light',                   // 主题：'light' | 'dark'
      remindOn: false,                  // 是否开启上课提醒
      remindMin: 10,                    // 提前提醒分钟数：5 / 10 / 15 / 20
      material: 'solid',                // 模块材质：solid/glass/frost/fluid/liquid
      wall: 'none',                     // 壁纸：none/w1~w6/custom
      wallCustom: '',                   // 自定义壁纸（dataURL，已压缩，保持原色清晰）
      perfMode: 'auto',                 // 渲染模式：auto/webgl/css
      headerStyle: 'blue',              // 表头样式主题 id（HEADER_STYLES）
      bg3d: true,                       // 背景光晕流动（WebGL 满血模式生效）
      schoolName: '',                   // 学校名称自定义（空 = 河北东方学院）
      appIcon: ''                       // 自定义应用图标（dataURL，空 = 玻璃日历）
    }
  };

  /* ---------- 手机号账号（本机多账号：每号独立课表+样式） ---------- */
  // 存储键：kbc.profiles.v1 → { [phone]: {courses, settings} }；kbc.curAcc.v1 → 当前手机号
  var LS_PROFILES = 'kbc.profiles.v1';
  var LS_CURACC = 'kbc.curAcc.v1';
  var SENSITIVE_KEYS = { wallCustom: 1 };   // 大体积/私密数据不进账号槽（壁纸太占空间）

  var editingId = null;                 // 弹窗正在编辑的课程 id（null=新增）
  var manualColor = null;               // 用户手动选的颜色（null=按课名自动）
  var textAuto = true;                  // 文字颜色是否为"自动适配卡片色"
  var pendingImport = null;             // 待确认的导入结果

  /* ============================================================
   * 2. 工具函数
   * ============================================================ */
  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  /** HTML 转义（课程名等用户输入会拼进 innerHTML，必须转义） */
  function esc(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** 轻提示（2.4 秒自动消失） */
  var toastTimer = null;
  function toast(msg, type) {
    var el = $('#toast');
    el.textContent = msg;
    el.className = 'toast' + (type === 'err' ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = 'toast hidden'; }, 2400);
  }

  /** 把日期规整到所在周的周一 0 点 */
  function mondayOf(d) {
    var x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
    return x;
  }

  /** 'YYYY-MM-DD' -> 本地 Date */
  function parseISODate(iso) {
    var m = String(iso || '').match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
  }

  /** Date -> 'M.D' 短格式 */
  function fmtMD(d) {
    return (d.getMonth() + 1) + '.' + d.getDate();
  }

  /** 数字补零：9 -> '09' */
  function p2(n) { return n < 10 ? '0' + n : '' + n; }

  /** 课程去重：同名同天同节次（含单双周类型）合并为一门，教师/教室/周次取并集 */
  function dedupeCourses(list) {
    var map = {}, out = [];
    (list || []).forEach(function (x) {
      if (!x || !x.name) return;
      if (!x.id) x.id = uid();
      var k = [x.name, x.day, x.start, x.end, x.weekType].join('|');
      var a = map[k];
      if (!a) { map[k] = x; out.push(x); return; }
      if (!a.teacher && x.teacher) a.teacher = x.teacher;
      if (!a.room && x.room) a.room = x.room;
      a.weekStart = Math.min(a.weekStart || 1, x.weekStart || 1);
      a.weekEnd = Math.max(a.weekEnd || 20, x.weekEnd || 20);
      var hs = {};
      (a.weeksOff || []).forEach(function (w) { hs[w] = 1; });
      (x.weeksOff || []).forEach(function (w) { hs[w] = 1; });
      var wl = Object.keys(hs).map(Number).sort(function (p, q) { return p - q; });
      a.weeksOff = wl.length ? wl : null;
    });
    return out;
  }

  /** 应用主题（浅色/深色），并同步切换按钮图标 */
  function applyTheme(t) {
    document.body.classList.toggle('dark', t === 'dark');
    var btn = $('#btnTheme');
    if (btn) btn.textContent = t === 'dark' ? '☀️' : '🌙';
  }

  /** 节次时间文本："08:00-09:40" */
  function periodTime(start, end) {
    return PERIODS[start - 1].start + '-' + PERIODS[end - 1].end;
  }

  /** "08:00" -> 480 分钟 */
  function toMinutes(hhmm) {
    var m = String(hhmm || '').split(':');
    return (+m[0] || 0) * 60 + (+m[1] || 0);
  }

  /** 重建生效节次表：直接采用学校专属配置（大节模式 + 可选晚自习） */
  function rebuildPeriods() {
    PERIODS = ScheduleParsers.config.PERIOD_TIMES.map(function (p, i) {
      return { no: i + 1, start: p.start, end: p.end, name: p.name || '',
               evening: !!p.evening, startMin: toMinutes(p.start), endMin: toMinutes(p.end) };
    });
    // 注入解析器：导入按贵校作息匹配节次
    if (ScheduleParsers.config.setActivePeriods) ScheduleParsers.config.setActivePeriods(PERIODS);
  }

  /** 可见节次：晚自习行常驻（没课时显示为空行） */
  function visiblePeriods() {
    return PERIODS;
  }

  /** 顶部标题 / 页签：学校名称可在设置里自定义（留空 = 河北东方学院）；
   *  顶栏图标：默认玻璃日历，可在 🎨 外观里上传自定义图片 */
  function currentSchoolName() {
    return (state.settings.schoolName || '').trim() || ScheduleParsers.config.SCHOOL_NAME;
  }
  function applyBrand() {
    var title = currentSchoolName() + '课程表';
    var logoText = document.querySelector('.logo-text');
    if (logoText) logoText.textContent = title;
    document.title = title;
    var idEl = $('#schoolIdText');
    if (idEl) idEl.textContent = ScheduleParsers.config.SCHOOL_ID;
    var nmEl = $('#schoolNameText');
    if (nmEl) nmEl.textContent = currentSchoolName();
    var cal = document.querySelector('.glass-cal');
    if (cal) {
      if (state.settings.appIcon) {
        cal.innerHTML = '<img class="gc-img" alt="">';
        cal.querySelector('img').src = state.settings.appIcon;
      } else if (cal.innerHTML.indexOf('gc-ring') < 0) {
        cal.innerHTML = '<span class="gc-ring gc-r1"></span><span class="gc-ring gc-r2"></span>' +
                        '<span class="gc-head"></span>' +
                        '<span class="gc-body"><i></i><i></i><i></i><i></i><i></i><i></i></span>';
      }
    }
  }

  /** "#rrggbb" → rgba(r,g,b,a) */
  function hexToRgba(hex, a) {
    var m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex || ''));
    if (!m) return hex;
    var n = parseInt(m[1], 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  /** 应用表头样式主题：写入 --hd-* CSS 变量（浅色/深色两套）。
   *  "无色"(none)：表头背景全透明，只留文字与分隔线（body.hd-none 控制）。 */
  function applyHeaderStyle() {
    var id = state.settings.headerStyle || 'blue';
    var h = HEADER_STYLES[0];
    HEADER_STYLES.forEach(function (x) { if (x.id === id) h = x; });
    var rs = document.documentElement.style;
    var transparent = (id === 'none');
    document.body.classList.toggle('hd-none', transparent);
    rs.setProperty('--hd-a', h.a);
    rs.setProperty('--hd-b', h.b);
    if (transparent) {
      rs.setProperty('--hd-day-bg', 'transparent');
      rs.setProperty('--hd-time-bg', 'transparent');
      rs.setProperty('--hd-day-bg-d', 'rgba(139, 149, 168, .14)');   // 今天列仍留一点灰底
      rs.setProperty('--hd-corner-c', '#4a5568');
      rs.setProperty('--hd-corner-c-d', '#b6c0d0');
    } else {
      rs.setProperty('--hd-day-bg', hexToRgba(h.a, .10));
      rs.setProperty('--hd-time-bg', hexToRgba(h.a, .055));
      rs.setProperty('--hd-day-bg-d', hexToRgba(h.a, .20));
      rs.setProperty('--hd-corner-c', '#fff');
      rs.setProperty('--hd-corner-c-d', '#e8eefc');
    }
    rs.setProperty('--hd-day-c', h.text);
    rs.setProperty('--hd-tm-c', hexToRgba(h.text, .78));
    rs.setProperty('--hd-day-c-d', h.textDark);
    rs.setProperty('--hd-tm-c-d', hexToRgba(h.textDark, .75));
  }

  function applyHeaderStyleId(id) {
    var ok = false;
    HEADER_STYLES.forEach(function (x) { if (x.id === id) ok = true; });
    if (!ok) return;
    state.settings.headerStyle = id;
    save();
    applyHeaderStyle();
  }

  /** 点击课表表头 → 表头样式弹层 */
  function openHeaderStylePopover(anchorEl) {
    closeHeaderStylePopover();
    var cur = state.settings.headerStyle || 'blue';
    var pop = document.createElement('div');
    pop.className = 'color-pop';
    pop.innerHTML =
      '<div class="cp-name">表头样式</div>' +
      '<div class="hdr-grid">' +
        HEADER_STYLES.map(function (h) {
          return '<div class="hdr-chip' + (h.id === cur ? ' active' : '') + '" data-hs="' + h.id + '">' +
                 '<span class="hdr-swatch" style="background:linear-gradient(135deg,' + h.a + ',' + h.b + ')"></span>' +
                 h.name + '</div>';
        }).join('') +
      '</div>' +
      '<div class="cp-acts"><button type="button" class="btn btn-sm" data-cp="close">关闭</button></div>';
    document.body.appendChild(pop);
    var r = anchorEl.getBoundingClientRect();
    pop.style.visibility = 'hidden';
    requestAnimationFrame(function () {
      var pw = pop.offsetWidth, ph = pop.offsetHeight;
      var x = Math.min(Math.max(8, r.left), window.innerWidth - pw - 8);
      var y = r.bottom + 6;
      if (y + ph > window.innerHeight - 8) y = Math.max(8, r.top - ph - 6);
      pop.style.left = x + 'px';
      pop.style.top = y + 'px';
      pop.style.visibility = '';
    });
    pop.addEventListener('click', function (e) {
      var chip = e.target.closest('[data-hs]');
      if (chip) {
        applyHeaderStyleId(chip.dataset.hs);
        Array.prototype.slice.call(pop.querySelectorAll('[data-hs]')).forEach(function (el) {
          el.classList.toggle('active', el.dataset.hs === chip.dataset.hs);
        });
        toast('表头样式已更新');
        return;
      }
      if (e.target.closest('[data-cp="close"]')) closeHeaderStylePopover();
    });
    window._hdrPop = pop;
    setTimeout(function () { document.addEventListener('click', hdrPopOutside, true); }, 0);
  }

  function hdrPopOutside(e) {
    if (window._hdrPop && !window._hdrPop.contains(e.target)) closeHeaderStylePopover();
  }

  function closeHeaderStylePopover() {
    if (window._hdrPop) {
      window._hdrPop.remove();
      window._hdrPop = null;
      document.removeEventListener('click', hdrPopOutside, true);
    }
  }

  /** 周次展示文本："1-16周·单"（默认 1-20 每周则返回空） */
  function weekText(c) {
    var t = '';
    if (c.weekStart > 1 || c.weekEnd < 20 || c.weekType !== 'all') {
      t = c.weekStart + '-' + c.weekEnd + '周';
      if (c.weekType === 'odd') t += '·单';
      else if (c.weekType === 'even') t += '·双';
    }
    return t;
  }

  /** 课程名 -> 稳定颜色下标（同一门课永远同色） */
  function autoColor(name) {
    var h = 0;
    for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return h % PALETTE_BG.length;
  }

  /* ============================================================
   * 3. 数据持久化（含手机号账号槽：每号独立课表+样式，仅存本机）
   * ============================================================ */

  /** 当前登录的手机号（null = 未登录，用公共本地数据） */
  function currentAccount() {
    try { return localStorage.getItem(LS_CURACC) || null; } catch (e) { return null; }
  }

  /** 读取全部账号槽 { phone: {courses, settings} } */
  function readProfiles() {
    try {
      var p = JSON.parse(localStorage.getItem(LS_PROFILES) || '{}');
      return (p && typeof p === 'object') ? p : {};
    } catch (e) { return {}; }
  }

  function writeProfiles(p) {
    try { localStorage.setItem(LS_PROFILES, JSON.stringify(p)); } catch (e) {}
  }

  /** 从账号槽恢复数据到 state（登录/切换时调用；渲染由调用方负责） */
  function applyProfile(phone) {
    var p = readProfiles()[phone];
    if (!p) return false;
    try {
      state.courses = Array.isArray(p.courses) ? dedupeCourses(JSON.parse(JSON.stringify(p.courses))) : [];
      var s = p.settings || {};
      state.settings.semesterStart = s.semesterStart || '';
      state.settings.theme = s.theme === 'dark' ? 'dark' : 'light';
      state.settings.remindOn = !!s.remindOn;
      state.settings.remindMin = [5, 10, 15, 20].indexOf(+s.remindMin) >= 0 ? +s.remindMin : 10;
      state.settings.material = ['solid', 'glass', 'frost', 'fluid', 'liquid'].indexOf(s.material) >= 0 ? s.material : 'solid';
      state.settings.wall = s.wall || 'none';
      state.settings.wallCustom = s.wallCustom || '';      // 壁纸随账号走
      state.settings.matParams = (s.matParams && typeof s.matParams === 'object') ? s.matParams : {};
      state.settings.perfMode = ['auto', 'webgl', 'css'].indexOf(s.perfMode) >= 0 ? s.perfMode : 'auto';
      state.settings.bg3d = s.bg3d !== false;
      state.settings.schoolName = String(s.schoolName || '').slice(0, 20);
      state.settings.appIcon = String(s.appIcon || '');
      state.settings.mail = String(s.mail || '');
      state.settings.headerStyle = (function () {
        var id = String(s.headerStyle || 'blue');
        var ok = false;
        HEADER_STYLES.forEach(function (x) { if (x.id === id) ok = true; });
        return ok ? id : 'blue';
      })();
      // 小组件设置（账号槽同病：漏恢复则换号/重登后小组件回退）
      state.settings.progressColor = (function () {
        var pc = String(s.progressColor || 'white');
        var okc = false;
        PROG_COLORS.forEach(function (x) { if (x.id === pc) okc = true; });
        return okc ? pc : 'white';
      })();
      state.settings.progressDir = s.progressDir === 'rev' ? 'rev' : 'fwd';
      state.settings.widgetStyle = (function () {
        var ws = String(s.widgetStyle || 'classic');
        var okw = false;
        WG_STYLES.forEach(function (x) { if (x.id === ws) okw = true; });
        return okw ? ws : 'classic';
      })();
      state.settings.weatherOn = s.weatherOn !== false;
      state.settings.city = (s.city && typeof s.city === 'object') ? s.city : null;
      state.settings.migratedSlots = true;
      return true;
    } catch (e) { return false; }
  }

  /** 把当前 state 快照写回账号槽（每次 save 时同步） */
  function persistProfile() {
    var phone = currentAccount();
    if (!phone) return;
    var p = readProfiles();
    p[phone] = {
      phone: phone,
      savedAt: Date.now(),
      courses: state.courses,
      settings: state.settings
    };
    writeProfiles(p);
    mirrorSave();
  }

  /** 原生镜像（安卓 APP）：localStorage 万一被系统清理时，登录态与账号槽可从原生恢复 */
  function mirrorSave() {
    try {
      if (window.KBBridge && window.KBBridge.saveData) {
        window.KBBridge.saveData(localStorage.getItem(LS_CURACC) || '',
                                 localStorage.getItem(LS_PROFILES) || '{}');
      }
    } catch (e) {}
  }
  function mirrorRestore() {
    // 返回 true 表示已从原生恢复并写回 localStorage
    try {
      if (!(window.KBBridge && window.KBBridge.getData)) return false;
      var acc = window.KBBridge.getData('acc');
      var prof = window.KBBridge.getData('profiles');
      if (!acc) return false;
      if (prof && prof !== '{}') localStorage.setItem(LS_PROFILES, prof);
      localStorage.setItem(LS_CURACC, acc);
      return true;
    } catch (e) { return false; }
  }

  /** 手机号登录：有槽恢复，无槽建新（样式用当前默认）；返回是否为新账号 */
  function loginAccount(phone) {
    var isNew = !readProfiles()[phone];
    localStorage.setItem(LS_CURACC, phone);
    if (isNew) {
      // 新号：继承当前的外观选择作起点，课表清空
      state.courses = [];
      save();
    } else {
      applyProfile(phone);
    }
    localStorage.setItem(LS_CURACC, phone);
    mirrorSave();                                    // 原生镜像：防止 WebView 清存储后掉登录
    return isNew;
  }

  /** 退出登录：数据已实时保存在槽里，直接回公共模式 */
  function logoutAccount() {
    try { localStorage.removeItem(LS_CURACC); } catch (e) {}
    try {
      if (window.KBBridge && window.KBBridge.saveData) window.KBBridge.saveData('', '{}');
    } catch (e) {}
  }

  function load() {
    // 已登录手机号 → 直接吃账号槽，公共数据不再读；
    // localStorage 里没有但原生镜像有（存储被清过）→ 先恢复镜像再登录
    var acc = currentAccount();
    if (!acc && mirrorRestore()) acc = currentAccount();
    if (acc && applyProfile(acc)) return;
    try {
      var s = JSON.parse(localStorage.getItem(LS_SETTINGS) || '{}');
      if (s && typeof s === 'object') {
        state.settings.semesterStart = s.semesterStart || '';
        state.settings.theme = s.theme === 'dark' ? 'dark' : 'light';
        state.settings.remindOn = !!s.remindOn;
        state.settings.remindMin = [5, 10, 15, 20].indexOf(+s.remindMin) >= 0 ? +s.remindMin : 10;
        state.settings.material = s.material === 'fluid2' ? 'liquid'
          : (['solid', 'glass', 'frost', 'fluid', 'liquid'].indexOf(s.material) >= 0 ? s.material : 'solid');
        state.settings.wall = s.wall || 'none';
        state.settings.wallCustom = s.wallCustom || '';
        state.settings.matParams = (s.matParams && typeof s.matParams === 'object') ? s.matParams : {};
        state.settings.perfMode = ['auto', 'webgl', 'css'].indexOf(s.perfMode) >= 0 ? s.perfMode : 'auto';
        state.settings.bg3d = s.bg3d !== false;            // 背景 3D 默认开
        state.settings.schoolName = String(s.schoolName || '').slice(0, 20);
        state.settings.appIcon = String(s.appIcon || '');
        state.settings.migratedSlots = !!s.migratedSlots;
        state.settings.headerStyle = (function () {
          var id = String(s.headerStyle || 'blue');
          var ok = false;
          HEADER_STYLES.forEach(function (x) { if (x.id === id) ok = true; });
          return ok ? id : 'blue';
        })();
        // 小组件设置（漏恢复会导致重启后小组件颜色/样式/天气回退）
        state.settings.progressColor = (function () {
          var pc = String(s.progressColor || 'white');
          var okc = false;
          PROG_COLORS.forEach(function (x) { if (x.id === pc) okc = true; });
          return okc ? pc : 'white';
        })();
        state.settings.progressDir = s.progressDir === 'rev' ? 'rev' : 'fwd';
        state.settings.widgetStyle = (function () {
          var ws = String(s.widgetStyle || 'classic');
          var okw = false;
          WG_STYLES.forEach(function (x) { if (x.id === ws) okw = true; });
          return okw ? ws : 'classic';
        })();
        state.settings.weatherOn = s.weatherOn !== false;
        state.settings.city = (s.city && typeof s.city === 'object') ? s.city : null;
      }
      var c = JSON.parse(localStorage.getItem(LS_COURSES) || '[]');
      if (Array.isArray(c)) {
        // 一次性迁移：仅针对旧版 12 小节编号（节次 > 5）→ 大节编号；
        // 已经是 1~5 的数据绝不再动（否则会把正确课表砍半）
        if (!state.settings.migratedSlots) {
          var changed = false;
          c.forEach(function (x) {
            if (x && ((x.start || 0) > 5 || (x.end || 0) > 5)) {
              x.start = Math.min(5, Math.ceil((x.start || 1) / 2));
              x.end = Math.min(5, Math.ceil((x.end || 1) / 2));
              changed = true;
            }
          });
          state.settings.migratedSlots = true;
          try { localStorage.setItem(LS_SETTINGS, JSON.stringify(state.settings)); } catch (e) {}
        }
        // 补发缺失 id + 去重（同名同天同节次的重复卡合并为一门）
        c.forEach(function (x) { if (x && !x.id) x.id = uid(); });
        state.courses = dedupeCourses(c);
        if (changed) {
          try { localStorage.setItem(LS_COURSES, JSON.stringify(state.courses)); } catch (e) {}
        }
      }
    } catch (e) {
      toast('本地数据读取失败，将使用空课表', 'err');
    }
  }

  function save() {
    try {
      localStorage.setItem(LS_COURSES, JSON.stringify(state.courses));
      localStorage.setItem(LS_SETTINGS, JSON.stringify(state.settings));
      persistProfile();                                    // 已登录 → 同步进账号槽
      pushWidgetToday();                                   // APP 里 → 刷新桌面小组件
    } catch (e) {
      toast('保存失败：浏览器存储不可用（可能是隐私模式）', 'err');
    }
  }

  /** 导出 .ics：每节课一个日历事件（按学期周推算日期，单双周/停周周全）+ 提前 N 分钟提醒。
   *  iPhone：下载后打开文件 → 全部添加到日历 → 系统级上课提醒（替代安卓的横幅/胶囊） */
  function exportIcs() {
    if (!state.courses.length) { toast('课表为空，先导入课程', 'err'); return; }
    var start = parseISODate(state.settings.semesterStart);
    if (!start) { toast('先在设置里填学期起始日（第一周的周一）', 'err'); return; }
    var mon0 = mondayOf(start);
    var remind = state.settings.remindOn ? (state.settings.remindMin || 10) : 10;
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    var ts = function (d, min) {
      return '' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + 'T' +
             pad(Math.floor(min / 60)) + pad(min % 60) + '00';
    };
    var lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//RainFall//KeBiao//CN',
                 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:RainFall课程表'];
    var n = 0;
    for (var w = 1; w <= MAX_WEEK && n < 600; w++) {
      state.courses.forEach(function (c) {
        if (n >= 600) return;
        if (!inWeek(c, w)) return;
        var p = PERIODS[c.start - 1];
        if (!p || p.startMin == null) return;
        var d = new Date(mon0.getTime() + ((w - 1) * 7 + (c.day - 1)) * 86400000);
        n++;
        lines.push('BEGIN:VEVENT');
        lines.push('UID:rf-' + (c.id || n) + '-w' + w + '@rainfall');
        lines.push('DTSTAMP:' + ts(new Date(), 0));
        lines.push('DTSTART:' + ts(d, p.startMin));
        lines.push('DTEND:' + ts(d, p.endMin));
        lines.push('SUMMARY:' + c.name + (c.room ? ' @' + c.room : ''));
        if (c.room) lines.push('LOCATION:' + c.room);
        lines.push('BEGIN:VALARM');
        lines.push('TRIGGER:-PT' + remind + 'M');
        lines.push('ACTION:DISPLAY');
        lines.push('DESCRIPTION:' + c.name + ' ' + (p.start || '') + ' 开始');
        lines.push('END:VALARM');
        lines.push('END:VEVENT');
      });
    }
    lines.push('END:VCALENDAR');
    var blob = new Blob([lines.join('\r\n')], { type: 'text/calendar;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'RainFall课程表.ics';
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    toast('已导出 ' + n + ' 节课（下载后打开文件 → 添加到日历）');
  }

  /** 桌面小组件（仅安卓 APP）：一次推"今天全天课 + tomorrow 包"两份数据，
     *  原生晚 9 点且今天课全部结束后，20 秒 tick 自动切明天视图（无需 APP 在线） */
  function pushWidgetToday() {
    if (!(window.KBBridge && window.KBBridge.saveWidget)) return;
    var push = function (wx) {
      var weather = state.settings.weatherOn === false ? '' : (wx && wx.w ? wx.w : '');
      var tip = weather ? weatherTip(weather, wx ? wx.temp : null) : '';
      var weather2 = (state.settings.weatherOn === false || !wx || !wx.w2) ? '' : wx.w2;
      var tip2 = weather2 ? weatherTipTomorrow(wx.w2, wx.t2min, wx.t2max) : '';
      try {
        var nowD = new Date();
        // 周一=1 … 周日=7（course.day 存的就是这个序号）
        var wd = nowD.getDay() === 0 ? 7 : nowD.getDay();
        var WDN = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
        var dayList = function (day, wk) {
          return state.courses.filter(function (c) {
            return c.day === day && inWeek(c, wk);
          }).sort(function (a, b) { return a.start - b.start; });
        };
        // 今天：推全天课（含已下课 → 原生划掉保留/补位），不再按当前时间过滤
        var list = [];
        dayList(wd, state.week).forEach(function (c) {
          if (list.length >= 8) return;
          var p = PERIODS[c.start - 1];
          if (!p) return;
          list.push({
            name: c.name, start: p.start, end: p.end, room: c.room || '',
            startMin: p.startMin != null ? p.startMin : -1, endMin: p.endMin != null ? p.endMin : -1
          });
        });
        // 明天：跨周自动进位周数；startMin/endMin 置 -1 → 原生渲染恒为"未上课"态
        var wd2 = wd + 1 > 7 ? 1 : wd + 1;
        var week2 = (wd + 1 > 7) ? Math.min(MAX_WEEK, state.week + 1) : state.week;
        var list2 = [];
        dayList(wd2, week2).forEach(function (c) {
          if (list2.length >= 6) return;
          var p = PERIODS[c.start - 1];
          if (!p) return;
          list2.push({ name: c.name, start: p.start, end: p.end, room: c.room || '', startMin: -1, endMin: -1 });
        });
        var head2 = '明天(' + WDN[wd2 - 1] + ')' + (list2.length ? ' · ' + list2.length + ' 门课' : ' · 没课');
        // v2 数据：今天全天课 + tomorrow 包
        window.KBBridge.saveWidget(JSON.stringify({
          v: 2,
          mat: state.settings.material === 'glass' ? 'glass' : 'plain',
          style: state.settings.widgetStyle || 'classic',
          weather: weather,
          weatherTip: tip,
          progColor: state.settings.progressColor || 'white',
          progressDir: state.settings.progressDir || 'fwd',
          remind: state.settings.remindOn ? (state.settings.remindMin || 10) : 0,
          week: '第 ' + state.week + ' 周',
          items: list,
          tomorrow: {
            headTitle: head2,
            week: '第 ' + week2 + ' 周',
            weather: weather2,
            weatherTip: tip2,
            items: list2
          }
        }), state.settings.appIcon || '');
      } catch (e) { /* 小组件失败不影响主功能 */ }
    };
    if (state.settings.weatherOn === false) { push(null); return; }
    fetchWeather(push);
  }

  /* ============================================================
   * 4. 周次计算
   * ============================================================ */

  /** 今天处于第几周（未设置学期起始日时按第 1 周） */
  function currentWeek() {
    var start = parseISODate(state.settings.semesterStart);
    if (!start) return 1;
    var diff = Math.round((mondayOf(new Date()) - mondayOf(start)) / (7 * 86400000)) + 1;
    return Math.min(MAX_WEEK, Math.max(1, diff));
  }

  /** 某周的 7 个日期。
   *  未设置学期起始日时按"真实日历"相对推算：第 1 周 = 今天所在周，
   *  往前/后翻按 7 天平移——保证导入后立刻就能在星期下方看到日期；
   *  设置锚点后变为精确学期日期。 */
  function weekDates(week) {
    var start = parseISODate(state.settings.semesterStart);
    var mon;
    if (start) {
      mon = mondayOf(start);
      mon.setDate(mon.getDate() + (week - 1) * 7);
    } else {
      mon = mondayOf(new Date());            // 今天所在周的周一
      mon.setDate(mon.getDate() + (week - 1) * 7);
    }
    var out = [];
    for (var i = 0; i < 7; i++) {
      var d = new Date(mon);
      d.setDate(mon.getDate() + i);
      out.push(d);
    }
    return out;
  }

  /** 课程是否在指定周上课（支持"排除周"：多段周次里不含的周） */
  function inWeek(c, week) {
    if (week < c.weekStart || week > c.weekEnd) return false;
    if (c.weekType === 'odd') return week % 2 === 1;
    if (c.weekType === 'even') return week % 2 === 0;
    if (c.weeksOff && c.weeksOff.length && c.weeksOff.indexOf(week) >= 0) return false;
    return true;
  }

  /* ============================================================
   * 5. 课表渲染
   * ============================================================ */
  function renderAll() {
    renderWeekbar();
    renderGrid();
  }

  /** 顶部周次条：第 N 周 · 今天日期（周几） */
  function renderWeekbar() {
    var now = new Date();
    var wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()];
    $('#weekTitle').textContent = '第 ' + state.week + ' 周 · ' +
      (now.getMonth() + 1) + '月' + now.getDate() + '日 ' + wd;
    var dates = weekDates(state.week);
    $('#weekRange').textContent = dates
      ? fmtMD(dates[0]) + ' - ' + fmtMD(dates[6])
      : '';
    $('#btnThisWeek').classList.toggle('hidden', state.week === currentWeek());
  }

  /** 整张网格：表头 + 节次列 + 背景格 + 课程块 */
  function renderGrid() {
    var dates = weekDates(state.week);
    var today = new Date();
    var todayKey = today.getFullYear() + '-' + today.getMonth() + '-' + today.getDate();
    var vp = visiblePeriods();                       // 可见节次（晚自习按需出现）
    var html = '';

    // ---- 左上角 + 星期表头 ----
    html += '<div class="tt-corner">周/节次</div>';
    for (var d = 1; d <= 7; d++) {
      var isToday = dates && dates[d - 1].getFullYear() + '-' + dates[d - 1].getMonth() + '-' + dates[d - 1].getDate() === todayKey;
      html += '<div class="tt-day' + (isToday ? ' today' : '') + '">' +
              '<span class="d-name">' + DAY_NAMES[d - 1] + '</span>' +
              (dates ? '<span class="d-date">' + fmtMD(dates[d - 1]) + '</span>' : '') +
              '</div>';
    }

    // ---- 节次列 ----
    html += '<div class="tt-times">';
    vp.forEach(function (p) {
      html += '<div class="tt-time"><span class="t-no">' + (p.name || p.no) + '</span>' +
              '<span class="t-tm">' + p.start + '-' + p.end + '</span></div>';
    });
    html += '</div>';

    // ---- 背景格子（点按可快速新增）----
    html += '<div class="tt-days-area"><div class="tt-cells">';
    for (d = 1; d <= 7; d++) {
      for (var slot = 1; slot <= vp.length; slot++) {
        var cellToday = dates && dates[d - 1].getFullYear() + '-' + dates[d - 1].getMonth() + '-' + dates[d - 1].getDate() === todayKey;
        html += '<div class="tt-cell' + (cellToday ? ' is-today' : '') + '" data-day="' + d + '" data-slot="' + slot + '"></div>';
      }
    }
    html += '</div>';

    // ---- 课程块浮层 ----
    html += '<div class="tt-blocks">';
    for (d = 1; d <= 7; d++) {
      var dayCourses = state.courses.filter(function (c) {
        return c.day === d && inWeek(c, state.week) && c.start <= vp.length;  // 超出可见节数的课不渲染
      });
      layoutLanes(dayCourses).forEach(function (c) {
        html += blockHTML(c);
      });
    }
    html += '</div>';

    // ---- 空状态引导 ----
    if (!state.courses.length) {
      html += '<div class="tt-empty">' +
              '<div class="big">🗓️</div>' +
              '<div><b>还没有课程</b></div>' +
              '<div class="tip">导入学校导出的 ics / excel 课表，或手动添加</div>' +
              '<div class="acts">' +
              '<button class="btn btn-primary" data-action="import">📂 导入课表文件</button>' +
              '<button class="btn" data-action="paste">📥 导入</button>' +
              '<button class="btn" data-action="add">＋ 手动新增</button>' +
              '</div></div>';
    }

    // ---- 当前时间线（仅当"本周视图包含今天"时渲染，位置由 updateNowLine 定时刷新） ----
    var todayIdx = 0;
    if (dates) {
      for (var ti = 0; ti < 7; ti++) {
        var dkey = dates[ti].getFullYear() + '-' + dates[ti].getMonth() + '-' + dates[ti].getDate();
        if (dkey === todayKey) todayIdx = ti + 1;
      }
    }
    if (todayIdx) {
      html += '<div class="now-line" id="nowLine" data-day="' + todayIdx + '" style="display:none"></div>';
    }

    html += '</div>'; // tt-days-area
    $('#ttGrid').innerHTML = html;
    // 动态行数 + 行高自适应铺满页面
    $('#ttGrid').style.gridTemplateRows = 'auto repeat(' + vp.length + ', var(--row-h))';
    var cellsWrap = $('.tt-cells');
    if (cellsWrap) cellsWrap.style.gridTemplateRows = 'repeat(' + vp.length + ', var(--row-h))';
    fitGridRows(vp.length);
    updateNowLine();
    scrollToToday();
    scheduleGlassFX(true);                             // 卡片重建 → 重挂 SDF 玻璃
  }

  /* ---------- 当前时间线 ---------- */

  /**
   * 行高自适应：让课表纵向铺满一屏（顶栏以下），行高有上下限。
   * 手机等小屏由 clamp 保底 54px（CSS 媒体查询同值），仍可横向滑动。
   */
  function fitGridRows(rowCount) {
    var topbar = document.querySelector('.topbar');
    var sab = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sab')) || 0;
    var avail = window.innerHeight -
      (topbar ? topbar.offsetHeight : 0) -
      Math.max(sab, 16) -                        // 底部安全区（无 foot 了）
      12;                                        // main 下留白
    var headH = ($('.tt-corner') || {}).offsetHeight || 34;
    var rowH = Math.floor((avail - headH) / Math.max(1, rowCount));
    rowH = Math.max(54, Math.min(170, rowH));
    $('#ttGrid').style.setProperty('--row-h', rowH + 'px');
  }

  // 窗口缩放 → 重新渲染以适配行高（防抖）
  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderAll, 180);
  });


  /** 把"现在"映射到网格位置：返回 {slot(从0计), frac(节内进度)}；不在上课时段返回 null */
  function nowLinePos(mins, list) {
    var P = list || PERIODS;
    var first = P[0].startMin, last = P[P.length - 1].endMin;
    if (mins < first || mins > last) return null;
    for (var i = 0; i < P.length; i++) {
      var p = P[i];
      if (mins >= p.startMin && mins <= p.endMin) {
        return { slot: i, frac: (mins - p.startMin) / (p.endMin - p.startMin) };
      }
      if (i < P.length - 1 && mins > p.endMin && mins < P[i + 1].startMin) {
        return { slot: i, frac: 1 };                    // 课间：显示在上一节末尾
      }
    }
    return { slot: P.length - 1, frac: 1 };
  }

  /** 刷新时间线位置与"正在上课"节次高亮（渲染后与每 30 秒定时调用） */
  function updateNowLine() {
    var now = new Date();
    var mins = now.getHours() * 60 + now.getMinutes();
    var line = $('#nowLine');
    var vp = visiblePeriods();
    // 节次列高亮当前节
    $$('.tt-time').forEach(function (el, i) {
      var p = vp[i];
      el.classList.toggle('is-now', !!line && !!p && mins >= p.startMin && mins <= p.endMin);
    });
    if (!line) return;
    var pos = nowLinePos(mins, vp);
    if (!pos) { line.style.display = 'none'; return; }
    var pct = 100 / 7, dayIdx = +line.dataset.day;
    line.style.display = '';
    line.style.left = 'calc(' + ((dayIdx - 1) * pct) + '% + 2px)';
    line.style.width = 'calc(' + pct + '% - 4px)';
    line.style.top = 'calc(' + (pos.slot + pos.frac) + ' * var(--row-h))';
    line.innerHTML = '<span class="now-label">现在 ' + p2(now.getHours()) + ':' + p2(now.getMinutes()) + '</span>';
  }
  setInterval(updateNowLine, 30000);

  /** 单个课程块 HTML（位置用 CSS 变量 --row-h 计算，跟随响应式）。
   *  卡片内容与教务系统课表一致：课程名 / 教师 / 教室 / 小节+周次 */
  function blockHTML(c) {
    var pct = 100 / 7;
    var lanePct = pct / c._lanes;
    var leftPct = (c.day - 1) * pct + c._lane * lanePct;
    var span = c.end - c.start + 1;
    var wt = weekText(c);
    /* color === -1 表示用户选了"无"：中性玻璃；null=自动；0~9=指定色 */
    var cls = c.color === -1 ? 'cn' : 'c' + (c.color != null ? c.color : autoColor(c.name));
    /* 文字自适应：跨节数越多字号越大、可换行行数越多（span1/2/3 三档） */
    var sizeCls = span >= 3 ? 'span3' : (span === 2 ? 'span2' : 'span1');
    /* 用户自定义文字颜色（空 = 自动适配卡片色） */
    var colorStyle = c.textColor ? 'color:' + esc(c.textColor) + ';' : '';
    /* 长课名 → 加 longname 类，CSS 自动缩小字号放宽行数 */
    var longname = (c.name && c.name.length >= 9) ? ' longname' : '';
    /* 小节号：第 n 大节 = 2n-1 ~ 2n 小节 */
    var xq1 = (c.start - 1) * 2 + 1, xq2 = c.end * 2;
    var xq = (xq1 === xq2 ? p2(xq1) + '小节' : p2(xq1) + '-' + p2(xq2) + '小节') + (wt ? ' ' + wt : '');
    /* 原生 title 兜底：文字被截断时悬停可看完整信息 */
    var tip = c.name + ' · ' + (PERIODS[c.start - 1] ? PERIODS[c.start - 1].name : '') +
              ' ' + periodTime(c.start, c.end) +
              (c.teacher ? ' · 教师:' + c.teacher : '') +
              (c.room ? ' @' + c.room : '') +
              ' · ' + xq;
    return '<div class="course-block ' + cls + ' ' + sizeCls + longname + '"' +
           ' data-id="' + c.id + '"' +
           ' title="' + esc(tip) + '"' +
           (colorStyle ? ' style="' + colorStyle + 'top:calc((' + (c.start - 1) + ') * var(--row-h) + 2px);'
                       : ' style="top:calc((' + (c.start - 1) + ') * var(--row-h) + 2px);') +
           ' height:calc(' + span + ' * var(--row-h) - 4px);' +
           ' left:calc(' + leftPct + '% + 2px);' +
           ' width:calc(' + lanePct + '% - 4px);">' +
           '<div class="cb-name">' + esc(c.name) + '</div>' +
           (c.teacher ? '<div class="cb-meta">教师：' + esc(c.teacher) + '</div>' : '') +
           (c.room ? '<div class="cb-meta">@' + esc(c.room) + '</div>' : '') +
           '<div class="cb-week">' + esc(xq) + '</div>' +
           '</div>';
  }

  /**
   * 同一天课程重叠时的"泳道"布局：
   * 互相重叠的课程分组，组内各占一列，保证都不被遮挡。
   */
  function layoutLanes(dayCourses) {
    dayCourses.sort(function (a, b) { return a.start - b.start || a.end - b.end; });
    var groups = [];                       // 互不重叠的课程分组
    dayCourses.forEach(function (c) {
      var g = groups.find(function (grp) {
        return grp.some(function (o) { return c.start <= o.end; });
      });
      if (!g) { g = []; groups.push(g); }
      g.push(c);
    });
    groups.forEach(function (g) {
      var lanes = [];                      // 每条泳道记录已占用的最大结束节次
      g.forEach(function (c) {
        var li = lanes.findIndex(function (end) { return c.start > end; });
        if (li < 0) { lanes.push(c.end); li = lanes.length - 1; }
        else lanes[li] = c.end;
        c._lane = li;
      });
      g.forEach(function (c) { c._lanes = lanes.length; });
    });
    return dayCourses;
  }

  /** 查看当前周时，把网格横向滚动到"今天"那一列 */
  function scrollToToday() {
    if (state.week !== currentWeek()) return;
    requestAnimationFrame(function () {
      var el = $('.tt-day.today');
      var wrap = $('#ttWrap');
      if (el && wrap.scrollWidth > wrap.clientWidth) {
        wrap.scrollLeft = Math.max(0, el.offsetLeft - 60);
      }
    });
  }

  /* ============================================================
   * 6. 悬浮详情气泡（桌面端 hover，手机端点按直接进编辑）
   * ============================================================ */
  function showTooltip(blockEl, e) {
    var c = state.courses.find(function (x) { return x.id === blockEl.dataset.id; });
    if (!c) return;
    var tip = $('#tooltip');
    tip.innerHTML =
      '<h4>' + esc(c.name) + '</h4>' +
      '<div class="row">时间：<b>' + DAY_NAMES[c.day - 1] + ' 第' + c.start + '-' + c.end + '节</b></div>' +
      '<div class="row">节次时段：<b>' + periodTime(c.start, c.end) + '</b></div>' +
      (c.teacher ? '<div class="row">教师：<b>' + esc(c.teacher) + '</b></div>' : '') +
      (c.room ? '<div class="row">教室：<b>' + esc(c.room) + '</b></div>' : '') +
      '<div class="row">周次：<b>' + (weekText(c) || '第' + c.weekStart + '-' + c.weekEnd + '周，每周') +
      (c.weeksOff && c.weeksOff.length ? '（不含第 ' + c.weeksOff.join('、') + ' 周）' : '') + '</b></div>';
    tip.classList.remove('hidden');
    moveTooltip(e);
  }

  function moveTooltip(e) {
    var tip = $('#tooltip');
    var pad = 14;
    var x = e.clientX + pad, y = e.clientY + pad;
    var rect = tip.getBoundingClientRect();
    if (x + rect.width > window.innerWidth - 8) x = e.clientX - rect.width - pad;
    if (y + rect.height > window.innerHeight - 8) y = e.clientY - rect.height - pad;
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  }

  function hideTooltip() {
    $('#tooltip').classList.add('hidden');
  }

  /* ============================================================
   * 7. 课程 新增/编辑/删除 弹窗
   * ============================================================ */

  /* ---------- 课程卡快速样式弹层（点卡片改颜色 / 文字颜色） ---------- */
  function openColorPopover(blockEl, c) {
    closeColorPopover();
    var pop = document.createElement('div');
    pop.className = 'color-pop';
    pop.innerHTML =
      '<div class="cp-name">' + esc(c.name) + '</div>' +
      '<div class="cp-row"><span class="cp-lab">卡片颜色</span>' +
        '<div class="cp-dots">' +
          '<button type="button" class="color-dot color-dot-none' + (c.color === -1 ? ' active' : '') + '" data-color="-1" title="无颜色"></button>' +
          PALETTE_BG.map(function (bg, i) {
            return '<button type="button" class="color-dot' + (c.color === i ? ' active' : '') +
                   '" data-color="' + i + '" style="background:' + bg + '"></button>';
          }).join('') +
        '</div></div>' +
      '<div class="cp-row"><span class="cp-lab">文字颜色</span>' +
        '<button type="button" class="btn btn-sm' + (c.textColor ? '' : ' btn-primary') +
          '" data-cp="tauto">自动</button>' +
        '<input type="color" data-cp="tpick" value="' + esc(c.textColor || '#333333') + '" title="自定义文字颜色">' +
      '</div>' +
      '<div class="cp-acts">' +
        '<button type="button" class="btn btn-sm" data-cp="edit">编辑详情</button>' +
        '<button type="button" class="btn btn-sm" data-cp="del" style="color:#e5484d">删除课程</button>' +
        '<button type="button" class="btn btn-sm" data-cp="close">关闭</button>' +
      '</div>';
    document.body.appendChild(pop);
    var r = blockEl.getBoundingClientRect();
    pop.style.visibility = 'hidden';
    requestAnimationFrame(function () {
      var pw = pop.offsetWidth, ph = pop.offsetHeight;
      var x = Math.min(Math.max(8, r.left + r.width / 2 - pw / 2), window.innerWidth - pw - 8);
      var y = r.bottom + 6;
      if (y + ph > window.innerHeight - 8) y = Math.max(8, r.top - ph - 6);
      pop.style.left = x + 'px';
      pop.style.top = y + 'px';
      pop.style.visibility = '';
    });
    pop.addEventListener('click', function (e) {
      var dot = e.target.closest('.color-dot');
      if (dot) {
        c.color = +dot.dataset.color;
        save(); renderAll();
        Array.prototype.slice.call(pop.querySelectorAll('.color-dot')).forEach(function (d) {
          d.classList.toggle('active', +d.dataset.color === c.color);
        });
        toast('颜色已更新');
        return;                                   // 保持弹层打开，方便继续调文字颜色
      }
      var act = e.target.closest('[data-cp]');
      if (!act) return;
      if (act.dataset.cp === 'tauto') {
        c.textColor = '';
        save(); renderAll();
        act.classList.add('btn-primary');
        toast('文字颜色：自动适配');
      } else if (act.dataset.cp === 'del') {
        // 删除课程：二次点击确认（2.6s 内），防误触
        if (act.dataset.armed !== '1') {
          act.dataset.armed = '1';
          act.textContent = '确认删除？';
          act.style.background = '#fdecec';
          setTimeout(function () {
            if (!act.isConnected) return;
            act.dataset.armed = '';
            act.textContent = '删除课程';
            act.style.background = '';
          }, 2600);
          return;
        }
        var delName = c.name;
        closeColorPopover();
        state.courses = state.courses.filter(function (x) { return x.id !== c.id; });
        save(); renderAll();
        toast('已删除「' + delName + '」');
      } else if (act.dataset.cp === 'edit') { closeColorPopover(); openCourseModal(c); }
      else closeColorPopover();
    });
    pop.addEventListener('input', function (e) {
      if (e.target.closest('[data-cp="tpick"]')) {
        c.textColor = e.target.value;
        save(); renderAll();
        var tauto = pop.querySelector('[data-cp="tauto"]');
        if (tauto) tauto.classList.remove('btn-primary');
      }
    });
    window._colorPop = pop;
    setTimeout(function () { document.addEventListener('click', colorPopOutside, true); }, 0);
  }

  function colorPopOutside(e) {
    if (window._colorPop && !window._colorPop.contains(e.target)) closeColorPopover();
  }

  function closeColorPopover() {
    if (window._colorPop) {
      window._colorPop.remove();
      window._colorPop = null;
      document.removeEventListener('click', colorPopOutside, true);
    }
  }

  /** 填充节次下拉框（只做一次） */
  function fillPeriodSelects() {
    var opts = PERIODS.map(function (p) {
      return '<option value="' + p.no + '">第' + p.no + '节 ' + p.start + '</option>';
    }).join('');
    $('#fStart').innerHTML = opts;
    $('#fEnd').innerHTML = opts;
  }

  /** 渲染色板圆点（第一颗为"无"= 不带课程色的中性玻璃） */
  function renderColorPicker(activeIdx) {
    var none = '<button type="button" class="color-dot color-dot-none' + (activeIdx === -1 ? ' active' : '') + '"' +
               ' data-color="-1" title="无颜色（中性玻璃）"></button>';
    $('#colorPicker').innerHTML = none + PALETTE_BG.map(function (bg, i) {
      return '<button type="button" class="color-dot' + (i === activeIdx ? ' active' : '') + '"' +
             ' data-color="' + i + '" style="background:' + bg + '" title="颜色 ' + (i + 1) + '"></button>';
    }).join('');
  }

  /** 当前应显示的颜色下标（手动优先，否则按课名自动） */
  function currentColorIdx() {
    if (manualColor != null) return manualColor;
    var name = $('#fName').value.trim();
    return name ? autoColor(name) : 0;
  }

  /** 打开弹窗：course 传课程为编辑，传 {day,start} 为预填新增 */
  function openCourseModal(course) {
    editingId = course && course.id ? course.id : null;
    manualColor = course && course.color != null ? course.color : null;
    $('#courseModalTitle').textContent = editingId ? '编辑课程' : '新增课程';
    $('#btnDeleteCourse').classList.toggle('hidden', !editingId);
    $('#fName').value = course ? course.name || '' : '';
    $('#fTeacher').value = course ? course.teacher || '' : '';
    $('#fRoom').value = course ? course.room || '' : '';
    $('#fDay').value = course ? course.day : 1;
    var st = course ? Math.min(12, course.start || 1) : 1;
    var en = course ? Math.min(12, course.end || st) : 2;
    $('#fStart').value = st;
    $('#fEnd').value = en;
    $('#fWeekStart').value = course ? course.weekStart || 1 : 1;
    $('#fWeekEnd').value = course ? course.weekEnd || 20 : 20;
    var wt = course ? course.weekType || 'all' : 'all';
    $('#fWeekType input[value="' + wt + '"]').checked = true;
    renderColorPicker(currentColorIdx());
    /* 文字颜色：自动 / 自定义 */
    textAuto = !(course && course.textColor);
    $('#fTextColor').value = (course && course.textColor) || '#333333';
    syncTextColorUI();
    $('#courseModal').classList.remove('hidden');
    wobbleModal($('#courseModal .modal'));
    setTimeout(function () { $('#fName').focus(); }, 60);
  }

  /** 同步文字颜色的"自动/自定义"按钮态 */
  function syncTextColorUI() {
    $('#btnTextAuto').classList.toggle('btn-primary', textAuto);
    $('#btnTextAuto').classList.toggle('btn-ghost', !textAuto);
  }

  function closeCourseModal() {
    $('#courseModal').classList.add('hidden');
    editingId = null;
    manualColor = null;
    textAuto = true;
  }

  /** 保存（新增或编辑） */
  function saveCourseForm(e) {
    e.preventDefault();
    var name = $('#fName').value.trim();
    if (!name) { toast('请填写课程名称', 'err'); return; }
    var start = +$('#fStart').value;
    var end = +$('#fEnd').value;
    if (end < start) { toast('结束节次不能早于开始节次', 'err'); return; }
    var ws = +$('#fWeekStart').value || 1;
    var we = +$('#fWeekEnd').value || 20;
    if (we < ws) { toast('结束周不能早于起始周', 'err'); return; }

    var course = {
      id: editingId || uid(),
      name: name,
      teacher: $('#fTeacher').value.trim(),
      room: $('#fRoom').value.trim(),
      day: +$('#fDay').value,
      start: start,
      end: end,
      weekStart: Math.min(MAX_WEEK, ws),
      weekEnd: Math.min(MAX_WEEK, we),
      weekType: ($('#fWeekType input:checked') || {}).value || 'all',
      color: manualColor != null ? manualColor : autoColor(name),
      textColor: textAuto ? '' : $('#fTextColor').value,
      weeksOff: (editingId && (function () {
        var oc = state.courses.find(function (x) { return x.id === editingId; });
        return oc ? (oc.weeksOff || null) : null;
      })()) || null
    };

    if (editingId) {
      var idx = state.courses.findIndex(function (c) { return c.id === editingId; });
      if (idx >= 0) state.courses[idx] = course;
    } else {
      state.courses.push(course);
    }
    var wasEdit = !!editingId;                         // closeCourseModal 会清空 editingId，先记下
    save();
    closeCourseModal();
    renderAll();

    // 与其它课程时间重叠时给个非阻断提醒
    var conflict = state.courses.find(function (c) {
      return c.id !== course.id && c.day === course.day &&
             c.start <= course.end && course.start <= c.end &&
             c.weekStart <= course.weekEnd && course.weekStart <= c.weekEnd;
    });
    toast((wasEdit ? '已保存课程' : '已添加课程') + (conflict ? '（注意：与《' + conflict.name + '》时间重叠）' : ''));
  }

  function deleteCourse() {
    if (!editingId) return;
    var c = state.courses.find(function (x) { return x.id === editingId; });
    if (!confirm('确定删除《' + (c ? c.name : '') + '》吗？')) return;
    state.courses = state.courses.filter(function (x) { return x.id !== editingId; });
    save();
    closeCourseModal();
    renderAll();
    toast('已删除课程');
  }

  /* ============================================================
   * 8. 文件导入（ics / xlsx / xls / csv）
   * ============================================================ */

  function handleFile(file) {
    if (!file) return;
    var ext = (file.name.split('.').pop() || '').toLowerCase();
    var reader = new FileReader();

    if (ext === 'ics' || ext === 'ical' || file.type === 'text/calendar') {
      reader.onload = function () { applyParsed(ScheduleParsers.parseICS(reader.result, state.settings.semesterStart), file.name); };
      reader.readAsText(file, 'utf-8');
    } else if (ext === 'json' || file.type === 'application/json') {
      reader.onload = function () { handleImportData(reader.result, file.name); };   // 备份文件 / 同步码
      reader.readAsText(file, 'utf-8');
    } else if (ext === 'xlsx' || ext === 'xls' || ext === 'csv') {
      if (typeof XLSX === 'undefined') {
        toast('Excel 解析库未加载成功，请检查 libs 目录', 'err');
        return;
      }
      reader.onload = function () {
        try {
          var wb = XLSX.read(new Uint8Array(reader.result), { type: 'array' });
          applyParsed(ScheduleParsers.parseExcel(wb, state.settings.semesterStart), file.name);
        } catch (err) {
          toast('文件解析失败：' + err.message, 'err');
        }
      };
      reader.readAsArrayBuffer(file);
    } else {
      toast('不支持的文件类型，请选择 ics / xlsx / xls / csv / json', 'err');
    }
  }

  /**
   * 备份文件 / 同步码导入（{app:'kbc', courses:[...], settings:{semesterStart}}）。
   * 统一走 parsePasted 的 JSON 通道（学期起始日会作为 inferredStart 自动带过），
   * 再进常规预览（可选合并 / 覆盖）。
   */
  function handleImportData(text, fileName) {
    var raw = String(text || '').trim();
    applyParsed(ScheduleParsers.parsePasted('', raw), fileName || '备份文件');
    // 备份里的完整设置（节数/作息/校名）：确认导入时一并恢复
    try {
      var data = JSON.parse(raw);
      if (data && data.app === 'kbc' && pendingImport) {
        pendingImport.backupSettings = data.settings || null;
      }
    } catch (e) {}
  }

  /** 解析完成 → 填充预览弹窗 */
  function applyParsed(result, fileName) {
    var courses = result.courses || [];
    var warnings = result.warnings || [];

    // ICS 带日期时自动设定学期起始日（仅当用户尚未设置）
    if (result.inferredStart && !state.settings.semesterStart) {
      state.settings.semesterStart = result.inferredStart;
      save();
      warnings.unshift('已根据文件自动设定：第 1 周从 ' + result.inferredStart + '（周一）开始，可在 ⚙ 设置中修改');
    }

    if (!courses.length) {
      toast('没有从文件中识别出课程，请检查文件', 'err');
    }

    pendingImport = { courses: courses, warnings: warnings, fileName: fileName };
    pendingImport.backupSettings = result.backupSettings || null;
    // 学期锚点输入框：预填当前设置；未设置时提示可一键推算
    var semInput = $('#importSemStart'), wkInput = $('#importWeekNo');
    if (semInput) semInput.value = state.settings.semesterStart || '';
    if (wkInput) wkInput.value = '';
    if (!state.settings.semesterStart) {
      warnings.push('还没设置学期起始日：周次/单双周可能不准。可在下方填"本周是第几周"一键推算。');
    }
    $('#importSummary').innerHTML =
      '📄 <b>' + esc(fileName) + '</b>　识别到 <b>' + courses.length + '</b> 门课';
    $('#importList').innerHTML = courses.map(function (c) {
      return '<div class="import-item">' +
             '<span class="dot" style="background:' + PALETTE_BG[autoColor(c.name)] + '"></span>' +
             '<span class="i-name">' + esc(c.name) + '</span>' +
             '<span class="i-info">' + DAY_NAMES[c.day - 1] + ' 第' + c.start + '-' + c.end + '节' +
             (c.room ? ' · ' + esc(c.room) : '') +
             (c.teacher ? ' · ' + esc(c.teacher) : '') +
             (weekText(c) ? ' · ' + esc(weekText(c)) : '') +
             '</span></div>';
    }).join('');
    $('#importWarnings').innerHTML = warnings.length
      ? '<ul>' + warnings.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul>'
      : '';
    // 预览弹出后关掉来源弹窗（账号获取 / 粘贴导入），避免两个弹窗重叠
    $('#pasteModal').classList.add('hidden');
    $('#importModal').classList.remove('hidden');
    wobbleModal($('#importModal .modal'));
  }

  /**
   * 学期锚点：从导入预览的输入框推算学期第 1 周周一。
   * 优先"本周是第 N 周"（倒推法，不知道开学日期时最好用），其次日期值。
   * 返回 'week' | 'date' | null（没填）。
   */
  function applyImportSemesterAnchor() {
    var wn = +(($('#importWeekNo') || {}).value || 0);
    var dv = ($('#importSemStart') || {}).value || '';
    if (wn >= 1 && wn <= 30) {
      var mon = mondayOf(new Date());
      mon.setDate(mon.getDate() - (wn - 1) * 7);
      state.settings.semesterStart = mon.getFullYear() + '-' + p2(mon.getMonth() + 1) + '-' + p2(mon.getDate());
      state.week = wn;
      return 'week';
    }
    if (dv) {
      var d = parseISODate(dv);
      if (d) {
        var m = mondayOf(d);
        if (m.getTime() !== d.getTime()) {
          dv = m.getFullYear() + '-' + p2(m.getMonth() + 1) + '-' + p2(m.getDate());
        }
        state.settings.semesterStart = dv;
        state.week = currentWeek();
        return 'date';
      }
    }
    return null;
  }

  /** 确认导入（合并 / 覆盖） */
  function confirmImport() {
    if (!pendingImport) { $('#importModal').classList.add('hidden'); return; }
    var mode = ($('input[name="importMode"]:checked') || {}).value || 'merge';
    var anchor = applyImportSemesterAnchor();          // 学期锚点（日期 / 周数）
    var incoming = pendingImport.courses;
    // 所有导入路径统一发放 id 与默认颜色（覆盖导入此前漏发，导致卡片点击失效）
    incoming.forEach(function (c) {
      if (!c.id) c.id = uid();
      if (c.color == null) c.color = autoColor(c.name);
    });
    // 同步码/备份文件携带的专属设置：节数 / 贵校作息 / 校名一并恢复
    var bs = pendingImport.backupSettings;
    if (bs) {
      rebuildPeriods();
      fillPeriodSelects();
      applyBrand();
    }
    if (mode === 'replace') {
      state.courses = dedupeCourses(incoming);
    } else {
      // 合并时跳过与现有完全重复的条目（同课名+同时间+同教室+同周次）
      var dup = 0;
      incoming.forEach(function (c) {
        var exists = state.courses.some(function (o) {
          return o.name === c.name && o.day === c.day && o.start === c.start &&
                 o.end === c.end && o.room === c.room && o.weekStart === c.weekStart &&
                 o.weekEnd === c.weekEnd && o.weekType === c.weekType;
        });
        if (exists) dup++;
        else {
          c.id = uid();
          c.color = c.color != null ? c.color : autoColor(c.name);
          state.courses.push(c);
        }
      });
      if (dup) toast('跳过 ' + dup + ' 条重复课程');
    }
    state.courses = dedupeCourses(state.courses);      // 合并后再整体去重一遍
    save();
    $('#importModal').classList.add('hidden');
    renderAll();
    var anchorMsg = anchor === 'week' ? '，第1周已按"本周是第' + state.week + '周"推算'
                  : anchor === 'date' ? '，学期起始日已更新' : '';
    toast('导入完成，共 ' + state.courses.length + ' 门课' + anchorMsg);
    pendingImport = null;
  }

  /* ---------- 粘贴导入（教务系统网页课表表格 / JSON） ---------- */

  function openPasteModal(skipAuto) {
    $('#pasteArea').value = '';
    $('#pasteArea')._kbcHtml = '';                     // 清掉上次粘贴残留的富文本
    setPasteHint('');
    $('#pasteModal').classList.remove('hidden');
    wobbleModal($('#pasteModal .modal'));
    setTimeout(function () { $('#pasteArea').focus(); }, 60);
    detectLocalServer();                               // 探测本地服务 → 显示"账号直接获取"
    if (skipAuto !== true) autoReadClipboard();        // 自动导入路径已带数据，跳过重复读取
  }

  /** 探测本地服务（kebiao-server.py）：可用才显示账号登录区块；
   *  安卓 APP（KBBridge）内置直连，无需探测直接显示 */
  function detectLocalServer() {
    var sec = $('#accSection');
    if (!sec) return;
    if (window.KBBridge && window.KBBridge.fetchKB) { sec.classList.remove('hidden'); return; }
    if (location.protocol === 'file:') { sec.classList.add('hidden'); return; }
    fetch('/api/ping', { method: 'GET' }).then(function (r) { return r.json(); }).then(function (res) {
      sec.classList.toggle('hidden', !(res && res.ok));
    }).catch(function () { sec.classList.add('hidden'); });
  }

  /** 账号直接获取：本地服务代理登录教务系统 → 抓回课表页 → 复用解析器。
   *  semester 可选：切换历史/其他学期时带上（凭据保留在内存里供重取，刷新页面即消失） */
  var accMem = { user: '', pass: '' };

  function fetchAccountKB(semester) {
    var user = $('#accUser').value.trim(), pwd = $('#accPass').value;
    if (!user || !pwd) { setPasteHint('请填写学号和密码', true); return; }
    accMem.user = user; accMem.pass = pwd;
    var btn = $('#btnAccFetch'), old = btn.textContent;
    btn.disabled = true; btn.textContent = '获取中…';
    setPasteHint(semester ? '正在读取所选学期课表…' : '正在登录教务系统并读取课表…');
    // 安卓 APP：通过原生桥在手机本地直连教务系统（不经电脑、不经第三方）
    if (window.KBBridge && window.KBBridge.fetchKB) {
      window.__kbCallback = function (json) {
        btn.disabled = false; btn.textContent = old;
        var res;
        try { res = JSON.parse(json); } catch (e) { setPasteHint('返回数据异常，请重试', true); return; }
        if (!res.ok) { setPasteHint(res.error || '获取失败，请重试', true); return; }
        var parsedB = ScheduleParsers.parsePasted(res.html, '');
        renderAccSemesters(res.semesters || [], res.current || '');
        if (!parsedB.courses.length) {
          setPasteHint('已登录但没解析出课程：请把此情况反馈给开发者', true);
          return;
        }
        $('#accPass').value = '';
        applyParsed(parsedB, '教务系统账号导入');
      };
      window.KBBridge.fetchKB(user, pwd, semester || '');
      return;
    }
    fetch('/api/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: user, password: pwd, semester: semester || '' })
    }).then(function (r) { return r.json(); }).then(function (res) {
      btn.disabled = false; btn.textContent = old;
      if (!res.ok) { setPasteHint(res.error || '获取失败，请重试', true); return; }
      var parsed = ScheduleParsers.parsePasted(res.html, '');
      renderAccSemesters(res.semesters || [], res.current || '');
      if (!parsed.courses.length) {
        setPasteHint('已登录但没解析出课程：请改用"框选表格复制 → 粘贴"，并把此情况反馈给开发者', true);
        return;
      }
      $('#accPass').value = '';
      applyParsed(parsed, '教务系统账号导入');
    }).catch(function () {
      btn.disabled = false; btn.textContent = old;
      setPasteHint('本地服务不可用：请先运行 tools/启动课表服务.bat，再刷新本页面', true);
    });
  }

  /** 账号区块里的学期下拉：登录成功后按教务系统返回填充 */
  function renderAccSemesters(list, current) {
    var sel = $('#accSem');
    if (!sel) return;
    if (!list || !list.length) { sel.classList.add('hidden'); return; }
    sel.classList.remove('hidden');
    sel.innerHTML = list.map(function (s) {
      return '<option value="' + esc(s.id) + '"' + (s.id === current ? ' selected' : '') + '>' +
             esc(s.text) + '</option>';
    }).join('');
  }

  /**
   * 打开弹窗时自动读取剪贴板（配合一键脚本：点书签复制 → 点本按钮 → 直接出预览，
   * 连 Ctrl+V 都省掉）。首次使用 Chrome 会弹一次剪贴板权限，允许即可；
   * 读取失败（旧浏览器 / 拒绝权限 / 剪贴板为空）→ 安静降级为手动 Ctrl+V。
   */
  function autoReadClipboard() {
    if (!navigator.clipboard) return;
    var done = false;
    function looksLikeKb(t) {
      t = (t || '').trim();
      return /^[[{]/.test(t) ||
             /星期[一二三四五六日天]|周[一二三四五六日天]|节次|第\s*\d+\s*节/.test(t);
    }
    function apply(html, text) {
      if (done) return;
      done = true;
      if (!html && !text) return;
      $('#pasteArea')._kbcHtml = html || '';
      $('#pasteArea').value = text || html || '';
      if (looksLikeKb(text || html)) {
        runPasteParse();                               // 像课表 → 直接解析出预览
      } else {
        setPasteHint('剪贴板有内容但不像课表；可直接 Ctrl+V 粘贴课表表格，或点「解析并预览」。');
      }
    }
    function tryText() {
      if (navigator.clipboard.readText) {
        navigator.clipboard.readText().then(function (t) { apply('', t || ''); }, function () {});
      }
    }
    // 富文本优先（text/html 表格最精确），失败退纯文本
    if (navigator.clipboard.read) {
      navigator.clipboard.read().then(function (items) {
        var html = '', text = '', ops = [];
        (items || []).slice(0, 1).forEach(function (item) {
          if (item.types.indexOf('text/html') >= 0) {
            ops.push(item.getType('text/html').then(function (b) { return b.text(); })
              .then(function (t) { html = t; }, function () {}));
          }
          if (item.types.indexOf('text/plain') >= 0) {
            ops.push(item.getType('text/plain').then(function (b) { return b.text(); })
              .then(function (t) { text = t; }, function () {}));
          }
        });
        Promise.all(ops).then(function () { apply(html, text); }, tryText);
      }, tryText);
    } else {
      tryText();
    }
  }

  /** 粘贴弹窗内的提示行（isErr 时标红） */
  function setPasteHint(msg, isErr) {
    var h = $('#pasteHint');
    h.textContent = msg;
    h.style.color = isErr ? '#d0564a' : '';
  }

  /** 解析粘贴内容 → 打开导入预览；失败时在弹窗里说明原因 */
  function runPasteParse() {
    var area = $('#pasteArea');
    if (!area.value.trim() && !(area._kbcHtml || '').trim()) {
      setPasteHint('先粘贴内容：在教务系统课表页框选表格复制，到这里 Ctrl+V。', true);
      return;
    }
    var res;
    try {
      res = ScheduleParsers.parsePasted(area._kbcHtml || '', area.value);
    } catch (err) {
      setPasteHint('解析出错：' + err.message, true);
      return;
    }
    if (!res.courses.length) {
      setPasteHint('没有识别出课程。请确认复制的是"课程表格"：' +
        '在教务系统课表页用鼠标框选整个课表表格再复制，或改用「导入课表」选择 ics / Excel 文件。' +
        (res.warnings.length ? '（' + res.warnings[res.warnings.length - 1] + '）' : ''), true);
      return;
    }
    $('#pasteModal').classList.add('hidden');
    applyParsed(res, '粘贴导入');                      // 复用文件导入的预览/合并流程
  }

  /* ---------- 更省一步：切到本页面时自动读取剪贴板里的课表 ----------
   * 配合一键脚本：点书签复制 → 直接切到课程表窗口 → 预览自动弹出。
   * 剪贴板内容不像课表 / 解析不出 / 已处理过 → 全程静默不打扰。
   * Chrome 需要用户授予过一次剪贴板读取权限（首次点"粘贴导入"时授）。 */
  var lastAutoClip = '', autoClipBusy = false;

  function maybeAutoImport() {
    if (autoClipBusy || !document.hasFocus()) return;
    if ($$('.modal-backdrop:not(.hidden)').length) return;   // 有弹窗打开时不打扰
    if (!$('#settingsPanel').classList.contains('hidden')) return;
    if (!(navigator.clipboard && navigator.clipboard.readText)) return;
    autoClipBusy = true;
    navigator.clipboard.readText().then(function (t) {
      autoClipBusy = false;
      t = (t || '').trim();
      if (!t || t === lastAutoClip) return;                  // 没有新内容
      if (!/星期[一二三四五六日天]|周[一二三四五六日天]|节次|第\s*\d+\s*节|^[[{]/.test(t)) return;
      var res;
      try { res = ScheduleParsers.parsePasted('', t); } catch (e) { return; }
      if (!res.courses.length) return;                       // 解析不出 → 静默
      lastAutoClip = t;
      openPasteModal(true);
      $('#pasteArea').value = t;
      runPasteParse();
    }, function () { autoClipBusy = false; });
  }

  window.addEventListener('focus', maybeAutoImport);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) maybeAutoImport();
  });

  /* ============================================================
   * 9. 导出图片 / 导出 PDF（html2canvas + jsPDF）
   * ============================================================ */

  /** 课表区域统一截图：隐藏悬浮层、临时展开滚动区，返回 Promise<canvas> */
  function captureTT(scale) {
    var wrap = $('#ttWrap');
    document.body.classList.add('exporting');
    var prevOverflow = wrap.style.overflow, prevWidth = wrap.style.width;
    wrap.style.overflow = 'visible';
    wrap.style.width = wrap.scrollWidth + 'px';
    function restore() {
      wrap.style.overflow = prevOverflow;
      wrap.style.width = prevWidth;
      document.body.classList.remove('exporting');
    }
    return html2canvas(wrap, {
      backgroundColor: getComputedStyle(document.body).backgroundColor || '#f5f7fa',
      scale: scale
    }).then(function (canvas) { restore(); return canvas; },
            function (err) { restore(); throw err; });
  }

  function exportImage() {
    if (!state.courses.length) { toast('课表是空的，先添加或导入课程吧', 'err'); return; }
    captureTT(2).then(function (canvas) {
      var a = document.createElement('a');
      a.download = '课程表_第' + state.week + '周.png';
      a.href = canvas.toDataURL('image/png');
      a.click();
      toast('图片已保存');
    }).catch(function (err) {
      toast('导出失败：' + err.message, 'err');
    });
  }

  /** 导出 A4 横版 PDF（课表截图嵌入 PDF，适配打印比例） */
  function exportPDF() {
    if (!state.courses.length) { toast('课表是空的，先添加或导入课程吧', 'err'); return; }
    if (typeof window.jspdf === 'undefined' || !window.jspdf.jsPDF) {
      toast('PDF 组件未加载成功，请检查 libs 目录', 'err');
      return;
    }
    toast('正在生成 PDF…');
    captureTT(2).then(function (canvas) {
      var JsPDF = window.jspdf.jsPDF;
      var imgW = canvas.width, imgH = canvas.height;
      var pdf = new JsPDF({ orientation: imgW >= imgH ? 'landscape' : 'portrait', unit: 'mm', format: 'a4' });
      var pw = pdf.internal.pageSize.getWidth();
      var ph = pdf.internal.pageSize.getHeight();
      var margin = 8;                                     // mm
      var k = Math.min((pw - margin * 2) / imgW, (ph - margin * 2) / imgH);
      var w = imgW * k, h = imgH * k;
      pdf.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', (pw - w) / 2, (ph - h) / 2, w, h);
      pdf.save('课程表_第' + state.week + '周.pdf');
      toast('PDF 已保存');
    }).catch(function (err) {
      toast('导出失败：' + err.message, 'err');
    });
  }

  /* ============================================================
   * 9.5 课程清单文本 / 批量删除 / 上课提醒
   * ============================================================ */

  /* ---------- 课程清单文本 ---------- */

  /** 生成按星期分组的纯文本清单（复制/下载用） */
  function buildListText() {
    var lines = ['📅 我的课程表 · 共 ' + state.courses.length + ' 门课程'];
    lines.push('================================');
    for (var d = 1; d <= 7; d++) {
      var list = state.courses.filter(function (c) { return c.day === d; })
                              .sort(function (a, b) { return a.start - b.start; });
      if (!list.length) continue;
      lines.push('');
      lines.push('【' + DAY_NAMES[d - 1] + '】');
      list.forEach(function (c, i) {
        var parts = [(i + 1) + '. ' + c.name, '第' + c.start + '-' + c.end + '节 ' + periodTime(c.start, c.end)];
        if (c.room) parts.push(c.room);
        if (c.teacher) parts.push(c.teacher);
        var wt = weekText(c);
        if (wt) parts.push(wt);
        lines.push(parts.join('　'));
      });
    }
    lines.push('');
    lines.push('—— 由本地课程表网页导出 ——');
    return lines.join('\n');
  }

  /** 复制清单文本（Clipboard API 优先，失败回退 execCommand） */
  function copyList() {
    var ta = $('#listText');
    ta.focus(); ta.select();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(ta.value).then(function () { toast('已复制到剪贴板'); }, fallbackCopy);
    } else {
      fallbackCopy();
    }
    function fallbackCopy() {
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) {}
      toast(ok ? '已复制到剪贴板' : '复制失败，请手动全选复制', ok ? undefined : 'err');
    }
  }

  /** 下载清单为 .txt（带 BOM，防止记事本/Excel 打开乱码） */
  function downloadList() {
    var blob = new Blob(['\ufeff' + $('#listText').value], { type: 'text/plain;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '课程清单.txt';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 3000);
    toast('清单已下载');
  }

  /* ---------- 批量删除 ---------- */

  function openManageModal() {
    renderManageList();
    $('#manageModal').classList.remove('hidden');
    wobbleModal($('#manageModal .modal'));
  }

  /** 渲染课程勾选列表（按星期+节次排序） */
  function renderManageList() {
    var sorted = state.courses.slice().sort(function (a, b) { return a.day - b.day || a.start - b.start; });
    $('#manageList').innerHTML = sorted.length ? sorted.map(function (c) {
      var ci = c.color === -1 ? null : (c.color != null ? c.color : autoColor(c.name));
      var dot = ci == null ? '#c9d2e0' : PALETTE_BG[ci];
      return '<label class="manage-item">' +
             '<input type="checkbox" class="m-check" value="' + esc(c.id) + '">' +
             '<span class="dot" style="background:' + dot + '"></span>' +
             '<span>' + esc(c.name) + '</span>' +
             '<span class="m-info">' + DAY_NAMES[c.day - 1] + ' 第' + c.start + '-' + c.end + '节</span>' +
             '</label>';
    }).join('') : '<p class="settings-tip">课表为空，没有可删除的课程。</p>';
    $('#manageAll').checked = false;
    updateManageCount();
  }

  function updateManageCount() {
    var n = $$('#manageList .m-check:checked').length;
    $('#manageCount').textContent = n ? '已选 ' + n + ' 门' : '';
  }

  function deleteSelectedCourses() {
    var ids = $$('#manageList .m-check:checked').map(function (cb) { return cb.value; });
    if (!ids.length) { toast('请先勾选要删除的课程', 'err'); return; }
    if (!confirm('确定删除所选的 ' + ids.length + ' 门课程吗？')) return;
    state.courses = state.courses.filter(function (c) { return ids.indexOf(c.id) < 0; });
    save();
    renderAll();
    if (state.courses.length) renderManageList();
    else $('#manageModal').classList.add('hidden');
    toast('已删除 ' + ids.length + ' 门课程');
  }

  /* ---------- 数据备份 / 跨设备同步（电脑 ⇄ 手机） ---------- */

  /** 导出 .json 备份文件（微信/QQ 发到手机 → 手机端"导入课表"选文件） */
  function exportData() {
    if (!state.courses.length) { toast('课表是空的，先导入或添加课程', 'err'); return; }
    var payload = {
      app: 'kbc', version: 1,
      exportedAt: new Date().toLocaleString(),
      settings: {
        semesterStart: state.settings.semesterStart,
        theme: state.settings.theme,
        remindOn: state.settings.remindOn,
        remindMin: state.settings.remindMin
      },
      courses: state.courses
    };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '课程表备份.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 3000);
    toast('备份已导出：微信/QQ 发到手机，在手机课表"导入课表"选它');
  }

  /** 复制同步码（一行 JSON 文本：微信发文字到手机 → 复制 → 粘贴导入自动识别） */
  function copySyncCode() {
    if (!state.courses.length) { toast('课表是空的，先导入或添加课程', 'err'); return; }
    var payload = {
      app: 'kbc', version: 1,
      settings: { semesterStart: state.settings.semesterStart },
      courses: state.courses.map(function (c) {
        return { name: c.name, teacher: c.teacher, room: c.room, day: c.day,
                 start: c.start, end: c.end, weekStart: c.weekStart,
                 weekEnd: c.weekEnd, weekType: c.weekType };
      })
    };
    var text = JSON.stringify(payload);
    var okMsg = '同步码已复制：微信/QQ 发给手机，手机上复制后打开课表自动导入';
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.focus(); ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) {}
      ta.remove();
      toast(ok ? okMsg : '复制失败，请改用「导出数据」文件方式', ok ? undefined : 'err');
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast(okMsg); }, fallback);
    } else fallback();
  }

  /* ---------- 上课前提醒 ---------- */

  var notifiedMap = {};   // 已提醒标记：'日期|课程id|开始节次'，防止重复提醒

  /** 每 20 秒检查：今天、本周、快到点的课 → 触发提醒 */
  function checkReminders() {
    if (!state.settings.remindOn || !state.settings.semesterStart || !state.courses.length) return;
    var now = new Date();
    var todayKey = now.getFullYear() + '-' + (now.getMonth() + 1) + '-' + now.getDate();
    var todayDay = ((now.getDay() + 6) % 7) + 1;                 // 周一=1..周日=7
    var wk = currentWeek();
    var mins = now.getHours() * 60 + now.getMinutes();
    state.courses.forEach(function (c) {
      if (c.day !== todayDay || !inWeek(c, wk)) return;          // 只提醒"今天且本周真上的课"
      if (c.start > PERIODS.length) return;                      // 超出显示节数的课不提醒
      var diff = PERIODS[c.start - 1].startMin - mins;           // 距上课还有多少分钟
      var key = todayKey + '|' + c.id + '|' + c.start;
      if (diff > 0 && diff <= state.settings.remindMin && !notifiedMap[key]) {
        notifiedMap[key] = true;
        fireReminder(c, diff);
      }
    });
  }

  /** 触发一次提醒：系统通知（已授权时）+ 页面内弹窗（始终显示） */
  function fireReminder(c, minsLeft) {
    var body = '第' + c.start + '-' + c.end + '节 ' + periodTime(c.start, c.end) +
               (c.room ? ' @' + c.room : '') + (c.teacher ? ' · ' + c.teacher : '') +
               '（还有 ' + minsLeft + ' 分钟）';
    if ('Notification' in window && Notification.permission === 'granted') {
      try { new Notification('⏰ ' + c.name + ' 快上课了', { body: body, tag: c.id + '-' + c.start }); } catch (e) {}
    }
    $('#reminderTitle').textContent = '⏰ ' + c.name + ' 快上课了';
    $('#reminderBody').textContent = body;
    $('#reminderPopup').classList.remove('hidden');
    scheduleGlassFX(true);
    clearTimeout(fireReminder._t);
    fireReminder._t = setTimeout(function () { $('#reminderPopup').classList.add('hidden'); }, 30000);
  }
  setInterval(checkReminders, 20000);   // 后台标签页会被浏览器节流至约 1 分钟一次

  /* ---------- 外观：模块材质 / 壁纸 ---------- */

  /** 应用外观设置：材质挂 body[data-mat]，壁纸写入 body 背景 */
  function applyAppearance() {
    var st = state.settings;
    var matOk = false;
    MATERIALS.forEach(function (m) { if (m.id === st.material) matOk = true; });
    document.body.dataset.mat = matOk ? st.material : 'solid';
    applyMaterialVars();
    var img = '';
    if (st.wall === 'custom' && st.wallCustom) {
      img = 'url("' + st.wallCustom + '")';
    } else if (st.wall && st.wall !== 'none' && st.wall !== 'custom') {
      WALLS.forEach(function (w) { if (w.id === st.wall) img = w.css; });
    }
    document.body.style.backgroundImage = img;
    document.body.style.backgroundRepeat = 'no-repeat';
    // iOS Safari 对 background-attachment:fixed 支持差会抖动，触屏设备退回 scroll
    var isTouch = window.matchMedia && window.matchMedia('(hover: none)').matches;
    document.body.style.backgroundAttachment = img ? (isTouch ? 'scroll' : 'fixed') : '';
    document.body.style.backgroundSize = img ? 'cover' : '';
    document.body.style.backgroundPosition = img ? 'center' : '';
    // WebGL 模式下壁纸交给着色器渲染（原图原色，等比 cover 适配）
    if (GLCTL) GLCTL.setWallpaper(st.wall === 'custom' ? st.wallCustom : null);
  }

  /* ============================================================
   * 渲染性能模式：满血 WebGL / 兼容 CSS（弱机自动降级）
   * ============================================================ */
  var GLCTL = null;            // LiquidBG 控制器
  var autoPerf = 'css';        // auto 档的探测结论
  var fpsWatched = false;      // 首帧探测只做一次

  /** 硬件能力粗判：WebGL 可用 + 内存/核数达标 + 未开省流；
   *  安卓 APP（KBBridge）内强制满血——既然装了 APP 就要完整 3D 效果 */
  function detectHardware() {
    if (!(window.LiquidBG && LiquidBG.supported())) return false;
    if (window.KBBridge) return true;
    var mem = navigator.deviceMemory || 4;
    var cores = navigator.hardwareConcurrency || 4;
    var saveData = navigator.connection && navigator.connection.saveData;
    return mem >= 4 && cores >= 4 && !saveData;
  }

  function effectivePerf() {
    if (state.settings.perfMode === 'webgl') return 'webgl';
    if (state.settings.perfMode === 'css') return 'css';
    return autoPerf;
  }

  /** 应用性能模式：启停 WebGL 引擎，同步 body 标记与 UI */
  function applyPerfMode() {
    var eff = effectivePerf();
    document.body.dataset.perf = eff;
    if (eff === 'webgl') {
      if (!GLCTL) {
        GLCTL = LiquidBG.start({ dark: state.settings.theme === 'dark', parallax: state.settings.bg3d !== false });
        if (GLCTL) {
          GLCTL.setWallpaper(state.settings.wall === 'custom' ? state.settings.wallCustom : null);
          watchGlFps();
        } else {
          autoPerf = 'css';
          document.body.dataset.perf = 'css';
          toast('WebGL 初始化失败，已切换兼容模式', 'err');
        }
      } else {
        GLCTL.setTheme(state.settings.theme === 'dark');
        GLCTL.setWallpaper(state.settings.wall === 'custom' ? state.settings.wallCustom : null);
        if (GLCTL.setParallax) GLCTL.setParallax(state.settings.bg3d !== false);
      }
    } else if (GLCTL) {
      GLCTL.stop();
      GLCTL = null;
    }
    updatePerfUI();
    scheduleGlassFX(true);                             // 模式/主题变化 → 重挂玻璃
  }

  /** 首帧帧率探测：自动档下帧率过低则降级兼容模式 */
  function watchGlFps() {
    if (fpsWatched || state.settings.perfMode !== 'auto') return;
    fpsWatched = true;
    setTimeout(function () {
      if (!GLCTL || state.settings.perfMode !== 'auto') return;
      var fps = GLCTL.fps();
      if (fps > 0 && fps < 38) {
        autoPerf = 'css';
        applyPerfMode();
        toast('检测到性能不足，已自动切换兼容 CSS 模式');
      }
      updatePerfUI();
    }, 2200);
  }

  /** 同步外观面板里的性能开关 UI */
  function updatePerfUI() {
    var eff = effectivePerf();
    $$('#perfSeg input').forEach(function (r) { r.checked = r.value === eff; });
    var b3 = $('#bg3dToggle');
    if (b3) b3.checked = state.settings.bg3d !== false;
    var tip = $('#perfTip');
    if (!tip) return;
    var modeName = eff === 'webgl' ? '满血 WebGL 液态玻璃' : '兼容 CSS 轻量模式';
    var fpsTxt = GLCTL && GLCTL.fps() ? ' · ' + Math.round(GLCTL.fps()) + ' FPS' : '';
    tip.textContent = (state.settings.perfMode === 'auto' ? '自动检测：当前 ' : '手动指定：') + modeName + fpsTxt;
  }

  /** 设置面板里的本机账号显示（登录态变化时调用） */
  function syncAccUI() {
    var who = $('#accWho'), btn = $('#btnAcc');
    var ph = currentAccount();
    if (!who || !btn) return;
    if (ph) {
      who.textContent = ph.slice(0, 3) + ' **** ' + ph.slice(7);
      btn.textContent = '切换账号';
    } else {
      who.textContent = '未登录（公共课表）';
      btn.textContent = '手机号登录';
    }
  }

  /* ============================================================
   * SDF 液态玻璃挂载（liquid-core.js / 移植自 liquid-glass）
   * 满血模式 + 半透明材质时，把 SDF 折射滤镜挂到面板与课程卡片；
   * 兼容 CSS 模式或 solid 材质时全部卸载，回退 CSS 材质规则。
   * ============================================================ */
  var gfDebounce = null;

  /** 立即(immediate)或防抖后刷新玻璃滤镜挂载 */
  function scheduleGlassFX(immediate) {
    clearTimeout(gfDebounce);
    if (immediate) { refreshGlassFX(); return; }
    gfDebounce = setTimeout(refreshGlassFX, 160);
  }

  function refreshGlassFX() {
    if (!(window.GlassFX && GlassFX.supported())) return;
    GlassFX.prune();                                   // 清理已重建的旧卡片节点
    var active = document.body.dataset.perf === 'webgl' &&
                 state.settings.material !== 'solid';
    if (!active) { GlassFX.detachAll(); return; }

    var p = getMatParams();
    /* 面板光学（毛玻璃感）：现有滑杆 → GlassOptics（原库参数表）映射 */
    var panelOptics = {
      strength: 0.03 + p.ripple * 0.05,                // 折射强度
      dispersion: p.dispersion != null ? p.dispersion : 0.5,
      depth: 0.65,
      curvature: 0.25 + p.ripple * 0.35,               // 液态中部放大
      bend: 0.2 + p.ripple * 0.35,                     // 液面 lip
      bendWidth: 0.16,
      frost: p.blur,                                   // 模糊滑杆 → SDF frost
      specular: 0.4 + p.shine * 1.2,
      sheen: 0.2 + p.shine * 0.5,
      glow: 0.08 + p.shine * 0.25,
      saturate: p.sat || 1.5
    };
    /* 课程卡片光学：清澈"水感" —— 极低 frost、更强折射与色散，
       网格线穿过卡片边缘会像水面一样弯曲 */
    var cardOptics = {
      strength: 0.05 + p.ripple * 0.04,
      dispersion: Math.max(0.55, p.dispersion != null ? p.dispersion : 0.55),
      depth: 0.5,
      curvature: 0.4,
      bend: 0.5,
      bendWidth: 0.14,
      frost: 2.2,                                      // 彩色卡：轻微磨砂
      specular: 0.9,
      sheen: 0.4,
      glow: 0.1,
      saturate: 1.15
    };
    /* 「无」颜色卡：清水 —— 几乎无 frost、接近自然饱和 */
    var clearOptics = JSON.parse(JSON.stringify(cardOptics));
    clearOptics.frost = 0.6;
    clearOptics.saturate = 1.05;

    /* 面板目标：顶栏导航 / 弹窗 / 设置 / 提醒 */
    var targets = [$('.topbar'), $('#settingsPanel'), $('#reminderPopup')];
    $$('.modal-backdrop:not(.hidden) > .modal').forEach(function (el) { targets.push(el); });
    targets.forEach(function (el) {
      if (el && !el.classList.contains('hidden')) GlassFX.attach(el, panelOptics);
    });
    /* 课程卡片：tt-wrap 在满血模式下已撤销 backdrop 根（见 style.css）。
       触屏手机跳过逐卡 SDF（每卡一个滤镜层太耗帧，导致卡顿）——
       卡片仍保留 CSS 玻璃质感（--cb-glass），流畅度优先；桌面不受影响 */
    if (!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches)) {
      $$('.course-block').forEach(function (el) {
        GlassFX.attach(el, el.classList.contains('cn') ? clearOptics : cardOptics);
      });
    }
  }

  /** 取当前材质的有效参数（默认值 + 用户滑杆覆盖） */
  function getMatParams() {
    var base = MAT_PARAMS[state.settings.material] || MAT_PARAMS.glass;
    var over = (state.settings.matParams || {})[state.settings.material] || {};
    var out = {};
    for (var k in base) out[k] = (over[k] != null ? over[k] : base[k]);
    return out;
  }

  /** 把当前材质参数写入 CSS 变量（材质规则与水波纹都从这里取值） */
  function applyMaterialVars() {
    var p = getMatParams();
    var dark = state.settings.theme === 'dark';
    var rs = document.documentElement.style;
    rs.setProperty('--mat-blur', p.blur + 'px');
    rs.setProperty('--mat-alpha', String(p.alpha));
    rs.setProperty('--mat-shine', String(p.shine));
    rs.setProperty('--mat-sat', String(p.sat));
    rs.setProperty('--mat-ripple', String(p.ripple));
    rs.setProperty('--mat-tint', dark ? '26 31 43' : '255 255 255');   // 面板底色随主题
  }

  /* ---------- 液态玻璃交互：动态高光 + 水波折射 ---------- */

  // 指针在半透明面板上游动时，把光斑位置写入面板的 --mx/--my（高光跟手）；
  // 同时喂给 WebGL 背景（3D 模式下 = 视差姿态源）
  document.addEventListener('pointermove', function (e) {
    if (GLCTL) GLCTL.setMouse(e.clientX / window.innerWidth, 1 - e.clientY / window.innerHeight);
    tiltTarget.x = e.clientX / window.innerWidth;      // 桌面：指针也驱动玻璃 logo 光影
    tiltTarget.y = 1 - e.clientY / window.innerHeight;
    if (state.settings.material === 'solid') return;
    var el = e.target.closest('.tt-wrap, .topbar, .modal, .settings-panel, .reminder-popup, .tooltip');
    if (!el) return;
    var r = el.getBoundingClientRect();
    el.style.setProperty('--mx', (e.clientX - r.left) + 'px');
    el.style.setProperty('--my', (e.clientY - r.top) + 'px');
  }, { passive: true });

  /* ---------- 背景 3D：姿态源 ----------
   * 手机：陀螺仪倾斜（beta/gamma → 0..1，iOS 需要一次用户授权）；
   * 电脑：指针位置。都只是喂给背景着色器做视差，不采集不上传。 */
  var tilt = { x: 0.5, y: 0.5 };            // 当前姿态（缓动后）
  var tiltTarget = { x: 0.5, y: 0.5 };
  function feedTilt() {
    tilt.x += (tiltTarget.x - tilt.x) * 0.10;
    tilt.y += (tiltTarget.y - tilt.y) * 0.10;
    if (GLCTL) GLCTL.setMouse(tilt.x, 1 - tilt.y);
    // 同步给 DOM：应用内玻璃 logo 的高光/倾角随手机姿态流动
    document.documentElement.style.setProperty('--tx', ((tilt.x - 0.5) * 2).toFixed(3));
    document.documentElement.style.setProperty('--ty', ((tilt.y - 0.5) * 2).toFixed(3));
    requestAnimationFrame(feedTilt);
  }
  requestAnimationFrame(feedTilt);
  window.addEventListener('deviceorientation', function (e) {
    if (e.gamma == null || e.beta == null) return;
    // 手机竖屏：gamma 左右倾 ±45°，beta 前后倾 45°~135°
    tiltTarget.x = Math.max(0, Math.min(1, 0.5 + (e.gamma / 45) * 0.5));
    tiltTarget.y = Math.max(0, Math.min(1, 0.5 + ((e.beta - 90) / 45) * 0.5));
  }, { passive: true });
  /** iOS 13+ 需要用户手势里请求一次陀螺仪权限（安卓免）；首次开"背景 3D"时调用 */
  function requestTiltPermission() {
    try {
      if (typeof DeviceOrientationEvent !== 'undefined' &&
          typeof DeviceOrientationEvent.requestPermission === 'function') {
        DeviceOrientationEvent.requestPermission().catch(function () {});
      }
    } catch (e) { /* 不支持就算了：用触摸位置当姿态源 */ }
  }
  // 触摸拖动也作为姿态源（无陀螺仪/未授权时一样有 3D 视差）
  document.addEventListener('touchmove', function (e) {
    var t = e.touches && e.touches[0];
    if (!t) return;
    tiltTarget.x = Math.max(0, Math.min(1, t.clientX / window.innerWidth));
    tiltTarget.y = Math.max(0, Math.min(1, 1 - t.clientY / window.innerHeight));
  }, { passive: true });

  /** 弹窗打开时重挂玻璃滤镜（水纹效果已移除，弹窗不再抖动） */
  function wobbleModal(modalEl) {
    scheduleGlassFX(true);
  }

  /** 小组件卡样式表（与原生 cardStyle 映射一致） */
  var WG_STYLES = [
    { id: 'classic', name: '经典蓝', card: '#F2F6FF', line: '#D9E4F8' },
    { id: 'glass', name: '冰晶玻璃', card: 'rgba(255,255,255,.6)', line: 'rgba(255,255,255,.85)' },
    { id: 'dark', name: '深夜', card: '#1E2430', line: '#323B4E' },
    { id: 'warm', name: '暖阳', card: '#FFF6E8', line: '#F0DFC4' },
    { id: 'sakura', name: '樱花', card: '#FDF0F5', line: '#F2CFDF' },
    { id: 'mint', name: '青薄荷', card: '#EAF9F5', line: '#C6E9E1' },
    { id: 'violet', name: '暗紫', card: '#262038', line: '#3D3358' },
    { id: 'gray', name: '商务灰', card: '#2E3238', line: '#454A52' },
    { id: 'sea', name: '海盐蓝', card: '#142A47', line: '#27436B' },
    { id: 'peach', name: '蜜桃', card: '#FFF1EA', line: '#F7D9CB' }
  ];

  /** 进度方向表 */
  var PROG_DIRS = [
    { id: 'fwd', name: '正放' },
    { id: 'rev', name: '倒放' }
  ];

  /** 进度条颜色表（与原生 progRes 映射一致） */
  var PROG_COLORS = [
    { id: 'white', name: '经典白', c: '#FFFFFF' },
    { id: 'blue', name: '天蓝', c: '#5B8DEF' },
    { id: 'pink', name: '樱粉', c: '#F06CA8' },
    { id: 'gold', name: '暖金', c: '#F5B301' },
    { id: 'green', name: '薄荷', c: '#2FBF9B' },
    { id: 'purple', name: '暗紫', c: '#8B5CF6' }
  ];

  /** 天气码（open-meteo）→ 状态 */
  function wxFromOM(code) {
    code = +code;
    if (code === 0) return 'sun';
    if (code === 1 || code === 2 || code === 3 || code === 45 || code === 48) return 'cloud';
    if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82) || code === 95 || code === 96 || code === 99) return 'rain';
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
    return 'cloud';
  }

  /** IP 免权限定位（ipwho.is → geojs 兜底）→ {lat,lon} 或 null */
  function ipLocate(cb) {
    var done = false;
    var fin = function (r) { if (!done) { done = true; cb(r); } };
    setTimeout(function () { fin(null); }, 4000);
    fetch('https://ipwho.is/').then(function (r) { return r.json(); }).then(function (d) {
      if (d && d.success !== false && d.latitude != null) fin({ lat: d.latitude, lon: d.longitude });
      else fin(null);
    }).catch(function () {
      fetch('https://get.geojs.io/v1/ip/geo.json').then(function (r) { return r.json(); }).then(function (d) {
        if (d && d.latitude) fin({ lat: +d.latitude, lon: +d.longitude }); else fin(null);
      }).catch(function () { fin(null); });
    });
  }

  /** open-meteo 天气（当前 + 明日预报）：回调 (w, temp, w2, t2min, t2max) */
  function omForecast(lat, lon, cb) {
    fetch('https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lon +
          '&current=weather_code,temperature_2m' +
          '&daily=weather_code,temperature_2m_max,temperature_2m_min&forecast_days=2&timezone=auto')
      .then(function (r) { return r.json(); }).then(function (d) {
        var cur = (d || {}).current || {};
        var temp = cur.temperature_2m != null ? Math.round(+cur.temperature_2m) : null;
        var w = wxFromOM(cur.weather_code);
        var dl = (d || {}).daily || {};
        var w2 = (dl.weather_code || [])[1] != null ? wxFromOM(dl.weather_code[1]) : '';
        var t2min = (dl.temperature_2m_min || [])[1] != null ? Math.round(+dl.temperature_2m_min[1]) : null;
        var t2max = (dl.temperature_2m_max || [])[1] != null ? Math.round(+dl.temperature_2m_max[1]) : null;
        try { localStorage.setItem('kbc.weather', JSON.stringify(
          { t: Date.now(), w: w, temp: temp, w2: w2, t2min: t2min, t2max: t2max })); } catch (e2) { }
        cb(w, temp, w2, t2min, t2max);
      }).catch(function () { cb('', null, '', null, null); });
  }

  /** 天气获取：手选城市坐标 / IP自动定位，统一走 open-meteo；30 分钟缓存 */
  function fetchWeather(cb) {
    try {
      var c = JSON.parse(localStorage.getItem('kbc.weather') || 'null');
      if (c && Date.now() - c.t < 30 * 60 * 1000) {
        cb({ w: c.w, temp: c.temp, w2: c.w2 || '', t2min: c.t2min, t2max: c.t2max }); return;
      }
    } catch (e) { }
    var done = false;
    var fin = function (w, temp, w2, t2min, t2max) {
      if (!done) { done = true; cb({ w: w, temp: temp, w2: w2 || '', t2min: t2min, t2max: t2max }); }
    };
    setTimeout(function () { fin('', null, '', null, null); }, 9000);
    var city = state.settings.city;
    if (city && city.lat != null) { omForecast(city.lat, city.lon, fin); return; }
    ipLocate(function (loc) {
      if (loc) omForecast(loc.lat, loc.lon, fin);
      else fin('', null, '', null, null);
    });
  }

/** 天气提示语：按天气状态 + 气温生成 */
  function weatherTip(w, temp) {
    if (!w) return '';
    var t = temp == null || isNaN(temp) ? null : +temp;
    if (w === 'rain') return '出门记得带伞 ☔';
    if (w === 'snow') return '天冷路滑，注意保暖 ❄';
    if (t != null && t <= 5) return '天气寒冷，多添衣服 🧣';
    if (t != null && t >= 32) return '天气炎热，注意防晒 🧴';
    if (w === 'sun') return '阳光正好，元气满满 ☀';
    return '天色阴沉，记得添件外套 ☁';
  }

  /** 明日提示语：按明日天气状态 + 明日最低/最高温生成 */
  function weatherTipTomorrow(w, tmin, tmax) {
    if (!w) return '';
    var lo = tmin == null || isNaN(tmin) ? null : Math.round(+tmin);
    var hi = tmax == null || isNaN(tmax) ? null : Math.round(+tmax);
    if (w === 'rain') return '明天有雨，记得带伞 ☔';
    if (w === 'snow') return '明天有雪，注意保暖防滑 ❄';
    if (lo != null && lo <= 5) return '明天最低 ' + lo + '°C，多添衣服 🧣';
    if (hi != null && hi >= 32) return '明天最高 ' + hi + '°C，注意防晒 🧴';
    if (w === 'sun') return '明天天晴，好状态 ☀';
    return '明天多云，出门看天 ☁';
  }

  /** 渲染外观面板的材质与壁纸选项 */
  function renderAppearanceChips() {
    var st = state.settings;
    updatePerfUI();
    $('#matGrid').innerHTML = MATERIALS.map(function (m) {
      return '<div class="mat-chip' + (st.material === m.id ? ' active' : '') + '" data-mat="' + m.id + '">' +
             '<div class="chip-box"></div>' + m.name + '</div>';
    }).join('');
    $('#colorGrid').innerHTML = PROG_COLORS.map(function (s) {
      return '<div class="mat-chip' + ((st.progressColor || 'white') === s.id ? ' active' : '') + '" data-pc="' + s.id + '">' +
             '<div class="chip-box" style="background:' + s.c + ';border:1px solid rgba(0,0,0,.15)"></div>' + s.name + '</div>';
    }).join('');
    $('#dirGrid').innerHTML = PROG_DIRS.map(function (s) {
      return '<div class="mat-chip' + ((st.progressDir || 'fwd') === s.id ? ' active' : '') + '" data-dir="' + s.id + '">' +
             '<div class="chip-box"></div>' + s.name + '</div>';
    }).join('');
    var html = '<div class="wall-chip' + (st.wall === 'none' ? ' active' : '') + '" data-wall="none">不使用</div>';
    WALLS.forEach(function (w) {
      html += '<div class="wall-chip' + (st.wall === w.id ? ' active' : '') + '" data-wall="' + w.id + '" style="background-image:' + w.css + '" title="' + w.name + '"></div>';
    });
    html += '<div class="wall-chip' + (st.wall === 'custom' ? ' active' : '') + '" data-wall="custom"' +
            (st.wallCustom ? ' style="background-image:url(' + st.wallCustom + ')"' : '') + '>🖼 上传</div>';
    $('#hdrGrid').innerHTML = HEADER_STYLES.map(function (h) {
      return '<div class="hdr-chip' + ((state.settings.headerStyle || 'blue') === h.id ? ' active' : '') +
             '" data-hs="' + h.id + '">' +
             '<span class="hdr-swatch" style="background:linear-gradient(135deg,' + h.a + ',' + h.b + ')"></span>' +
             h.name + '</div>';
    }).join('');
    $('#wgStyleGrid').innerHTML = WG_STYLES.map(function (s) {
      return '<div class="mat-chip' + ((st.widgetStyle || 'classic') === s.id ? ' active' : '') + '" data-ws="' + s.id + '">' +
             '<div class="chip-box" style="background:' + s.card + ';border:1px solid ' + s.line + '"></div>' + s.name + '</div>';
    }).join('');
    $('#wallGrid').innerHTML = html;
    refreshTuners();
  }

  /** 同步"材质微调"滑杆为当前材质参数（solid 材质无需调节，隐藏） */
  function refreshTuners() {
    var p = getMatParams();
    var isSolid = state.settings.material === 'solid';
    $('#matTuneWrap').classList.toggle('hidden', isSolid);
    if (isSolid) return;
    $('#tuneBlur').value = p.blur;
    $('#tuneBlurV').textContent = Math.round(p.blur) + 'px';
    $('#tuneAlpha').value = Math.round(p.alpha * 100);
    $('#tuneAlphaV').textContent = Math.round(p.alpha * 100) + '%';
    $('#tuneShine').value = Math.round(p.shine * 100);
    $('#tuneShineV').textContent = Math.round(p.shine * 100) + '%';
    $('#tuneDisp').value = Math.round((p.dispersion != null ? p.dispersion : .5) * 100);
    $('#tuneDispV').textContent = Math.round((p.dispersion != null ? p.dispersion : .5) * 100) + '%';
  }

  /**
   * 上传自定义壁纸：canvas 压缩（最长边 1920px、JPEG 82%），
   * 保持原图原色清晰 —— 不做调色；显示时按 cover 等比适配不变形。
   */
  function handleWallFile(file) {
    if (!file || String(file.type).indexOf('image/') !== 0) { toast('请选择图片文件', 'err'); return; }
    var reader = new FileReader();
    reader.onload = function () {
      var img = new Image();
      img.onload = function () {
        var max = 1920;
        var k = Math.min(max / img.width, max / img.height, 1);
        var w = Math.max(1, Math.round(img.width * k));
        var h = Math.max(1, Math.round(img.height * k));
        var cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(img, 0, 0, w, h);
        state.settings.wall = 'custom';
        state.settings.wallCustom = cv.toDataURL('image/jpeg', 0.82);
        save();
        applyAppearance();
        renderAppearanceChips();
        toast('壁纸已设置');
      };
      img.onerror = function () { toast('图片读取失败', 'err'); };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  /** 上传自定义应用图标（顶栏 logo）：压成正方形 96px PNG */
  function handleAppIconFile(file) {
    if (!file || String(file.type).indexOf('image/') !== 0) { toast('请选择图片文件', 'err'); return; }
    var reader = new FileReader();
    reader.onload = function () {
      var img = new Image();
      img.onload = function () {
        var s = 96;
        var k = Math.min(s / img.width, s / img.height, 1);
        var w = Math.max(1, Math.round(img.width * k));
        var h = Math.max(1, Math.round(img.height * k));
        var cv = document.createElement('canvas');
        cv.width = s; cv.height = s;
        var ctx = cv.getContext('2d');
        ctx.drawImage(img, (s - w) / 2, (s - h) / 2, w, h);   // 居中 cover
        state.settings.appIcon = cv.toDataURL('image/png');
        save();
        applyBrand();
        toast('应用图标已更换');
      };
      img.onerror = function () { toast('图片读取失败', 'err'); };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  /* ============================================================
   * 10. 设置面板（学期起始日 / 上课提醒 / 批量删除 / 清空）
   * ============================================================ */
  function toggleSettings(show) {
    var panel = $('#settingsPanel');
    var willShow = show != null ? show : panel.classList.contains('hidden');
    panel.classList.toggle('hidden', !willShow);
    if (willShow) {
      $('#semesterStartInput').value = state.settings.semesterStart || '';
      $('#remindToggle').checked = state.settings.remindOn;
      $('#remindMin').value = String(state.settings.remindMin);
      var wwT = $('#wgWeatherToggle');
      if (wwT) wwT.checked = state.settings.weatherOn !== false;
      var cn = $('#cityNow');
      if (cn) { var ct = state.settings.city;
        cn.textContent = ct && ct.name ? '已选城市：' + ct.name : '当前：自动定位（按网络位置）'; }
      var sn = $('#schoolNameInput');
      if (sn) sn.value = state.settings.schoolName || '';
      if (typeof syncAccUI === 'function') syncAccUI();
      scheduleGlassFX(true);
    }
  }

  function saveSettings() {
    // 快捷方式：只填"本周是第几周" → 自动倒推第 1 周周一填进日期框
    var wn = +($('#weekNoInput') || {}).value || 0;
    if (wn >= 1 && wn <= 30) {
      var mon = mondayOf(new Date());
      mon.setDate(mon.getDate() - (wn - 1) * 7);
      $('#semesterStartInput').value = mon.getFullYear() + '-' + p2(mon.getMonth() + 1) + '-' + p2(mon.getDate());
    }
    if ($('#weekNoInput')) $('#weekNoInput').value = '';
    var v = $('#semesterStartInput').value;
    if (v) {                                            // 日期可留空：只保存提醒设置
      var d = parseISODate(v);
      var mon = mondayOf(d);
      if (mon.getTime() !== d.getTime()) {
        toast('所选日期不是周一，已自动对齐到 ' + (mon.getMonth() + 1) + '.' + mon.getDate());
        v = mon.getFullYear() + '-' + p2(mon.getMonth() + 1) + '-' + p2(mon.getDate());
      }
      state.settings.semesterStart = v;
      state.week = currentWeek();
    }
    // 提醒设置
    state.settings.remindOn = $('#remindToggle').checked;
    state.settings.remindMin = +$('#remindMin').value || 10;
    if (state.settings.remindOn && window.KBBridge && window.KBBridge.ensureNotifPerm) {
      try { window.KBBridge.ensureNotifPerm(); } catch (e) { }   // 开启提醒 → 请求系统通知权限
    }
    // 学校名称自定义（留空 = 默认河北东方学院）
    var snIn = $('#schoolNameInput');
    if (snIn) {
      state.settings.schoolName = snIn.value.trim();
      applyBrand();
    }
    // 开启提醒时请求系统通知权限（被拒绝则自动走页面内弹窗）
    if (state.settings.remindOn && 'Notification' in window && Notification.permission === 'default') {
      try { Notification.requestPermission(); } catch (e) {}
    }
    save();
    toggleSettings(false);
    renderAll();
    var remindWarn = state.settings.remindOn && !state.settings.semesterStart
      ? '（提醒需先设置学期起始日，否则不会触发）' : '';
    toast('设置已保存' + (v ? '，当前为第 ' + state.week + ' 周' : '') + remindWarn,
          remindWarn ? 'err' : undefined);
  }

  function clearAll() {
    if (!state.courses.length) { toast('课表已经是空的'); return; }
    if (!confirm('确定清空全部 ' + state.courses.length + ' 门课程吗？此操作不可恢复。')) return;
    state.courses = [];
    save();
    toggleSettings(false);
    renderAll();
    toast('已清空课表');
  }

  /* ============================================================
   * 11. 事件绑定与初始化
   * ============================================================ */
  function bindEvents() {
    // 顶栏按钮（PDF / 导出图片 / 打印 / 导出数据 / 同步码已按需求移除）
    $('#btnAdd').addEventListener('click', function () { openCourseModal(null); });
    $('#btnSettings').addEventListener('click', function (e) {
      e.stopPropagation();
      if (styleLocked()) { needKey(); return; }   // 设置（样式/清空等）需密钥
      toggleSettings();
    });
    $('#btnSaveSettings').addEventListener('click', saveSettings);
    $('#btnClearAll').addEventListener('click', clearAll);
    $('#btnMe').addEventListener('click', openMeModal);
    $('#meModalClose').addEventListener('click', closeMeModal);
    $('#btnMeClose').addEventListener('click', closeMeModal);
    $('#btnMeKey').addEventListener('click', function () { closeMeModal(); openLockModal(); });
    $('#btnMeUpd').addEventListener('click', meCheckUpdate);
    // 一键把桌面小组件请求到桌面（Android 8+；不支持的桌面会无反应，改用桌面长按→小组件）
    $('#btnIcs').addEventListener('click', exportIcs);
    // iPhone：隐藏小组件按钮、显示主屏/日历引导（iPadOS 触屏版 Safari 一并识别）
    var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
                (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (isIOS) {
      var iosTip = document.getElementById('iosTips');
      if (iosTip) iosTip.style.display = '';
      var iosW = document.getElementById('btnMeWidget');
      if (iosW) iosW.parentElement.style.display = 'none';
    }
    $('#btnMeWidget').addEventListener('click', function () {
      if (window.KBBridge && window.KBBridge.pinWidget) {
        window.KBBridge.pinWidget();
        toast('已在桌面请求添加小组件，请回到桌面查看');
      } else {
        toast('网页版不支持；请在桌面长按 → 小部件 → 课程表');
      }
    });


    // 周次切换
    $('#weekPrev').addEventListener('click', function () { goWeek(-1, true); });
    $('#weekNext').addEventListener('click', function () { goWeek(1, true); });
    $('#btnThisWeek').addEventListener('click', function () { state.week = currentWeek(); renderAll(); });
    initSwipeNav();

    // 文件选择
    $('#fileInput').addEventListener('change', function () {
      handleFile(this.files[0]);
      this.value = '';
    });

    // 粘贴导入（教务系统网页课表表格）
    $('#btnPaste').addEventListener('click', openPasteModal);
    $('#pasteModalClose').addEventListener('click', function () { $('#pasteModal').classList.add('hidden'); });
    $('#btnPasteCancel').addEventListener('click', function () { $('#pasteModal').classList.add('hidden'); });
    $('#btnPasteParse').addEventListener('click', runPasteParse);
    $('#pasteArea').addEventListener('paste', function (e) {
      var cd = e.clipboardData;
      if (!cd) return;                          // 极老浏览器：走默认粘贴 + 手点"解析并预览"
      e.preventDefault();
      this._kbcHtml = cd.getData('text/html') || '';   // 富文本表格留给解析器（比纯文本精确）
      this.value = cd.getData('text/plain') || '';     // 输入框里展示纯文本，方便确认粘了什么
      setPasteHint('');
      runPasteParse();                          // 粘贴即解析，直接进预览
    });
    $('#pasteArea').addEventListener('input', function () {
      this._kbcHtml = '';                       // 手动编辑过 → 只按纯文本重新解析
    });
    $('#btnAccFetch').addEventListener('click', function () { fetchAccountKB(); });
    $('#accSem').addEventListener('change', function () { fetchAccountKB(this.value); });
    $('#accPass').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); fetchAccountKB(); }
    });
    // 密码可见切换：mousedown preventDefault 防键盘收起再弹（页面闪一下的元凶）
    var passEye = $('#accPassEye'), passInput = $('#accPass');
    if (passEye && passInput) {
      passEye.addEventListener('mousedown', function (e) { e.preventDefault(); });
      passEye.addEventListener('click', function () {
        var show = passInput.type === 'password';
        passInput.type = show ? 'text' : 'password';
        passEye.textContent = show ? '\ud83d\ude48' : '\ud83d\udc41';
      });
    }

    // 课程弹窗
    $('#courseForm').addEventListener('submit', saveCourseForm);
    $('#btnCancelCourse').addEventListener('click', closeCourseModal);
    $('#courseModalClose').addEventListener('click', closeCourseModal);
    $('#btnDeleteCourse').addEventListener('click', deleteCourse);
    $('#fStart').addEventListener('change', fixEndPeriod);
    $('#fName').addEventListener('input', function () {
      if (manualColor == null) renderColorPicker(currentColorIdx());  // 课名变化→自动色跟随
    });
    $('#colorPicker').addEventListener('click', function (e) {
      var dot = e.target.closest('.color-dot');
      if (!dot) return;
      if (styleLocked()) { needKey(); return; }   // 课程调色板也需密钥
      manualColor = +dot.dataset.color;
      renderColorPicker(manualColor);
    });
    // 文字颜色：自动 / 自定义取色器
    $('#btnTextAuto').addEventListener('click', function () {
      textAuto = true;
      syncTextColorUI();
    });
    $('#fTextColor').addEventListener('input', function () {
      textAuto = false;
      syncTextColorUI();
    });

    // 导入预览弹窗
    $('#btnImportConfirm').addEventListener('click', confirmImport);
    $('#btnImportCancel').addEventListener('click', function () { $('#importModal').classList.add('hidden'); });
    $('#importModalClose').addEventListener('click', function () { $('#importModal').classList.add('hidden'); });

    // 弹窗遮罩点击关闭 + Esc 关闭（密钥锁屏除外：激活前不可绕过）
    $$('.modal-backdrop').forEach(function (bd) {
      bd.addEventListener('click', function (e) {
        if (e.target === bd && bd.id !== 'lockModal') bd.classList.add('hidden');
      });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        closeColorPopover();
        closeHeaderStylePopover();
        closeCourseModal();
        $$('.modal-backdrop').forEach(function (bd) { if (bd.id !== 'lockModal') bd.classList.add('hidden'); });
        toggleSettings(false);
        $('#reminderPopup').classList.add('hidden');
        hideTooltip();
      }
    });

    /** 样式类功能需要密钥：APP 内未激活时全部拦下（网页版不拦） */
    function styleLocked() {
      return !!(window.KBBridge && window.KBBridge.isUnlocked && !window.KBBridge.isUnlocked());
    }
    function needKey() {
      toast('更改样式前请先激活密钥');
      openLockModal();
    }

    // 主题切换（深色 / 浅色）—— 需密钥
    $('#btnTheme').addEventListener('click', function () {
      if (styleLocked()) { needKey(); return; }
      state.settings.theme = state.settings.theme === 'dark' ? 'light' : 'dark';
      applyTheme(state.settings.theme);
      applyMaterialVars();                       // 面板底色 tint 随主题切换
      try { applyPerfMode(); } catch (e) {}      // WebGL 调色同步（失败不阻断保存）
      save();
      toast(state.settings.theme === 'dark' ? '已切换到深色模式' : '已切换到浅色模式');
    });

    // 性能模式开关（满血 WebGL / 兼容 CSS）
    $('#perfSeg').addEventListener('change', function (e) {
      if (e.target.name !== 'perfMode') return;
      state.settings.perfMode = e.target.value;
      save();
      applyPerfMode();
      toast(e.target.value === 'webgl' ? '已启用满血 WebGL 液态玻璃' : '已切换兼容 CSS 轻量模式');
    });

    // 课程清单（文本导出）
    $('#btnList').addEventListener('click', function () {
      if (!state.courses.length) { toast('课表是空的，先添加或导入课程吧', 'err'); return; }
      $('#listText').value = buildListText();
      $('#listModal').classList.remove('hidden');
    });
    $('#btnListCopy').addEventListener('click', copyList);
    $('#btnListDownload').addEventListener('click', downloadList);
    $('#btnListClose').addEventListener('click', function () { $('#listModal').classList.add('hidden'); });
    $('#listModalClose').addEventListener('click', function () { $('#listModal').classList.add('hidden'); });

    // 批量删除
    $('#btnManage').addEventListener('click', openManageModal);
    $('#manageModalClose').addEventListener('click', function () { $('#manageModal').classList.add('hidden'); });
    $('#btnManageCancel').addEventListener('click', function () { $('#manageModal').classList.add('hidden'); });
    $('#manageAll').addEventListener('change', function () {
      var on = this.checked;
      $$('#manageList .m-check').forEach(function (cb) { cb.checked = on; });
      updateManageCount();
    });
    $('#manageList').addEventListener('change', updateManageCount);
    $('#btnManageDelete').addEventListener('click', deleteSelectedCourses);

    // 提醒弹窗关闭
    $('#reminderClose').addEventListener('click', function () { $('#reminderPopup').classList.add('hidden'); });

    // 流体按压：按钮 / 课程块点击时液体挤压回弹（CSS 关键帧实现阻尼曲线）
    document.addEventListener('click', function (e) {
      if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      var el = e.target.closest('.btn, .week-btn, .course-block');
      if (!el) return;
      el.classList.remove('liquid-squish');
      void el.offsetWidth;                        // 强制重排以重启动画
      el.classList.add('liquid-squish');
      el.addEventListener('animationend', function h() {
        el.classList.remove('liquid-squish');
        el.removeEventListener('animationend', h);
      });
    });

    // 外观（材质 / 壁纸）—— 需密钥
    $('#btnAppear').addEventListener('click', function () {
      if (styleLocked()) { needKey(); return; }
      renderAppearanceChips();
      $('#appearModal').classList.remove('hidden');
      wobbleModal($('#appearModal .modal'));
    });
    $('#appearModalClose').addEventListener('click', function () { $('#appearModal').classList.add('hidden'); });
    $('#matGrid').addEventListener('click', function (e) {
      var chip = e.target.closest('.mat-chip');
      if (!chip) return;
      state.settings.material = chip.dataset.mat;
      save();
      applyAppearance();
      renderAppearanceChips();
      scheduleGlassFX(true);
      toast('已应用「' + chip.textContent.trim() + '」材质');
    });
    $('#hdrGrid').addEventListener('click', function (e) {
      var chip = e.target.closest('.hdr-chip');
      if (!chip) return;
      applyHeaderStyleId(chip.dataset.hs);
      renderAppearanceChips();
      toast('表头样式：' + chip.textContent.trim());
    });
    $('#wallGrid').addEventListener('click', function (e) {
      var chip = e.target.closest('.wall-chip');
      if (!chip) return;
      if (chip.dataset.wall === 'custom') { $('#wallInput').click(); return; }   // 上传自定义壁纸
      state.settings.wall = chip.dataset.wall;
      if (chip.dataset.wall === 'none') state.settings.wallCustom = '';
      save();
      applyAppearance();
      renderAppearanceChips();
      toast('壁纸已更新');
    });
    // 小组件卡样式：换样式即重推小组件（save 内含 pushWidgetToday）
    $('#wgStyleGrid').addEventListener('click', function (e) {
      var chip = e.target.closest('.mat-chip');
      if (!chip) return;
      state.settings.widgetStyle = chip.dataset.ws;
      save();
      renderAppearanceChips();
      toast('小组件样式：' + chip.textContent.trim());
    });
    // 进度条颜色
    $('#colorGrid').addEventListener('click', function (e) {
      var chip = e.target.closest('.mat-chip');
      if (!chip) return;
      state.settings.progressColor = chip.dataset.pc;
      save();
      renderAppearanceChips();
      toast('进度条颜色：' + chip.textContent.trim());
    });
    // 进度方向（正放/倒放）
    $('#dirGrid').addEventListener('click', function (e) {
      var chip = e.target.closest('.mat-chip');
      if (!chip) return;
      state.settings.progressDir = chip.dataset.dir;
      save();
      renderAppearanceChips();
      toast('进度方向：' + (chip.dataset.dir === 'rev' ? '倒放' : '正放'));
    });
    // 天气模式开关
    $('#wgWeatherToggle').addEventListener('change', function () {
      state.settings.weatherOn = this.checked;
      save();
      if (this.checked) toast('天气模式已开启');
      else toast('天气模式已关闭');
    });
    // 天气模式开关
    $('#wgWeatherToggle').addEventListener('change', function () {
      state.settings.weatherOn = this.checked;
      save();
      if (this.checked) toast('天气模式已开启（自动定位当前天气）');
      else toast('天气模式已关闭');
    });
    // 天气城市：手动搜索覆盖自动定位（持久保存，重启不丢）
    var cityInput = $('#cityInput'), cityRes = $('#cityResults'), cityNow = $('#cityNow');
    function syncCityNow() {
      if (!cityNow) return;
      var ct = state.settings.city;
      cityNow.textContent = ct && ct.name ? '已选城市：' + ct.name : '当前：自动定位（按网络位置）';
    }
    function doCitySearch() {
      var q = cityInput.value.trim();
      if (!q) { toast('请输入城市名'); return; }
      cityRes.style.display = 'block';
      cityRes.innerHTML = '<div class="text-muted text-small" style="padding:6px 10px">搜索中…</div>';
      var om = fetch('https://geocoding-api.open-meteo.com/v1/search?name=' + encodeURIComponent(q) +
                     '&count=8&language=zh&format=json')
                 .then(function (r) { return r.json(); })
                 .then(function (d) { return ((d || {}).results || []).map(function (it) {
                   return { name: it.name, sub: [it.admin1, it.country].filter(Boolean).join(' · '),
                            lat: it.latitude, lon: it.longitude }; }); })
                 .catch(function () { return []; });
      var nom = fetch('https://nominatim.openstreetmap.org/search?format=json&limit=8&accept-language=zh' +
                      '&featureType=city&q=' + encodeURIComponent(q))
                  .then(function (r) { return r.json(); })
                  .then(function (d) { return (d || []).map(function (it) {
                    var nm = (it.display_name || '').split(',')[0];
                    return { name: nm, sub: (it.display_name || '').split(',').slice(1, 3).join(' · ').trim(),
                             lat: +it.lat, lon: +it.lon }; }); })
                  .catch(function () { return []; });
      Promise.all([om, nom]).then(function (rs) {
        var seen = {}, list = [];
        rs[0].concat(rs[1]).forEach(function (it) {
          var key = it.name + '|' + Math.round(it.lat * 10) + '|' + Math.round(it.lon * 10);
          if (seen[key] || !it.name) return;
          seen[key] = 1; list.push(it);
        });
        if (!list.length) {
          cityRes.innerHTML = '<div class="text-muted text-small" style="padding:6px 10px">没找到，换个名字或加“市”试试</div>';
          return;
        }
        cityRes.innerHTML = list.map(function (it, i) {
          return '<div class="city-item" data-ci="' + i + '">' + it.name +
                 (it.sub ? ' <span class="text-muted text-small">' + it.sub + '</span>' : '') + '</div>';
        }).join('');
        cityRes._list = list.slice(0, 10);
      });
    }
    cityRes.addEventListener('click', function (e) {
      var it = e.target.closest('.city-item');
      if (!it || !cityRes._list) return;
      var pick = cityRes._list[+it.dataset.ci];
      state.settings.city = { name: pick.name, lat: pick.latitude, lon: pick.longitude };
      try { localStorage.removeItem('kbc.weather'); } catch (e2) { }   // 清缓存立即生效
      save(); syncCityNow();
      cityRes.style.display = 'none'; cityInput.value = '';
      toast('天气城市：' + pick.name);
    });
    $('#btnCitySearch').addEventListener('click', doCitySearch);
    cityInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); doCitySearch(); }
    });
    $('#btnCityAuto').addEventListener('click', function () {
      state.settings.city = null;
      try { localStorage.removeItem('kbc.weather'); } catch (e2) { }
      save(); syncCityNow();
      toast('已切回自动定位');
    });
    $('#wallInput').addEventListener('change', function () {
      handleWallFile(this.files[0]);
      this.value = '';
    });
    // 自定义应用图标
    $('#btnIconUpload').addEventListener('click', function () { $('#appIconInput').click(); });
    $('#appIconInput').addEventListener('change', function () {
      handleAppIconFile(this.files[0]);
      this.value = '';
    });
    $('#btnIconReset').addEventListener('click', function () {
      state.settings.appIcon = '';
      save();
      applyBrand();
      toast('已恢复默认玻璃日历图标');
    });
    // 背景 3D 开关：满血模式即时生效；iOS 首次开启请求陀螺仪权限
    $('#bg3dToggle').addEventListener('change', function () {
      state.settings.bg3d = this.checked;
      save();
      if (this.checked) requestTiltPermission();
      if (GLCTL && GLCTL.setParallax) GLCTL.setParallax(this.checked);
      toast(this.checked ? '背景 3D 已开启' : '背景 3D 已关闭（更省电）');
    });

    /* 密钥激活门：函数本体提升到 IIFE 顶层（顶层 meCheckUpdate / 入口 lockGate 都要调用） */
    $('#btnLockGo').addEventListener('click', function () {
      var key = $('#lockKey').value.trim();
      var e = $('#lockErr');
      if (!key) { e.textContent = '请输入密钥'; e.classList.remove('hidden'); return; }
      if (window.KBBridge && window.KBBridge.activate && window.KBBridge.activate(key)) {
        $('#lockModal').classList.add('hidden');
        syncMe();
        var tip = '永久有效';
        try {
          var info = JSON.parse(window.KBBridge.keyInfo ? window.KBBridge.keyInfo() : '{}');
          if (!info.forever && info.leftDays > 0) tip = '限时 ' + info.leftDays + ' 天（至 ' + info.expire + '）';
        } catch (e) { }
        toast('激活成功 · ' + tip + '，欢迎使用');
      } else {
        e.textContent = '密钥不正确，请联系管理员';
        e.classList.remove('hidden');
      }
    });
    $('#lockKey').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); $('#btnLockGo').click(); }
    });
    // 锁屏「取消」：可以先逛课表，但改样式会再弹激活
    $('#btnLockSkip').addEventListener('click', function () {
      $('#lockModal').classList.add('hidden');
      toast('未激活只能查看，更改样式需先激活密钥');
    });
    // 材质微调滑杆：拖动实时生效（input），松手记忆（change）
    [
      ['#tuneBlur', 'blur', 1, 'px'],
      ['#tuneAlpha', 'alpha', 100, '%'],
      ['#tuneShine', 'shine', 100, '%'],
      ['#tuneDisp', 'dispersion', 100, '%']
    ].forEach(function (cfg) {
      var sel = cfg[0], key = cfg[1], div = cfg[2], unit = cfg[3];
      var input = $(sel), valEl = $(sel + 'V');
      input.addEventListener('input', function () {
        var st = state.settings;
        if (!st.matParams[st.material]) st.matParams[st.material] = {};
        st.matParams[st.material][key] = +input.value / div;
        valEl.textContent = input.value + unit;
        applyMaterialVars();
        scheduleGlassFX();                             // 防抖重建 SDF 玻璃
      });
      input.addEventListener('change', function () { save(); });
    });

    // 网格事件委托：点空白格=新增，点课程块=快速样式弹层，点表头=表头样式弹层
    $('#ttGrid').addEventListener('click', function (e) {
      var hdr = e.target.closest('.tt-corner, .tt-day');
      if (hdr) {
        hideTooltip();
        if (styleLocked()) { needKey(); return; }   // 表头样式需密钥
        openHeaderStylePopover(hdr);
        return;
      }
      var block = e.target.closest('.course-block');
      if (block) {
        var c = state.courses.find(function (x) { return x.id === block.dataset.id; });
        if (c) {
          hideTooltip();
          if (styleLocked()) { needKey(); return; } // 课程块样式需密钥
          openColorPopover(block, c);
        }
        return;
      }
      var cell = e.target.closest('.tt-cell');
      if (cell) { tryCellActivate(cell); return; }   // 空白格：连点两次才新增（防误触）
    });

    /** 空白格"点两次"新增：400ms 内再点同一格才弹出，第一次给轻提示 */
    var lastCellTap = { key: '', t: 0 };
    function tryCellActivate(cell) {
      var key = cell.dataset.day + '-' + cell.dataset.slot;
      var now = Date.now();
      if (lastCellTap.key === key && now - lastCellTap.t < 420) {
        lastCellTap = { key: '', t: 0 };
        openCourseModal({ day: +cell.dataset.day, start: +cell.dataset.slot });
      } else {
        lastCellTap = { key: key, t: now };
        toast('再点一次该格子即可新增课程');
      }
    }
    $('#ttGrid').addEventListener('mouseover', function (e) {
      var block = e.target.closest('.course-block');
      if (block) showTooltip(block, e);
    });
    $('#ttGrid').addEventListener('mousemove', function (e) {
      if (!$('#tooltip').classList.contains('hidden')) moveTooltip(e);
    });
    $('#ttGrid').addEventListener('mouseout', function (e) {
      var block = e.target.closest('.course-block');
      if (block && !block.contains(e.relatedTarget)) hideTooltip();
    });
    $('#ttWrap').addEventListener('scroll', hideTooltip);

    // 空状态里的按钮（渲染时重新生成，用委托）
    $('#ttGrid').addEventListener('click', function (e) {
      var act = e.target.closest('[data-action]');
      if (!act) return;
      if (act.dataset.action === 'import') $('#fileInput').click();
      if (act.dataset.action === 'paste') openPasteModal();
      if (act.dataset.action === 'add') openCourseModal(null);
    });

    // 设置面板：点击别处关闭
    document.addEventListener('click', function (e) {
      var panel = $('#settingsPanel');
      if (!panel.classList.contains('hidden') &&
          !panel.contains(e.target) && e.target.id !== 'btnSettings') {
        toggleSettings(false);
      }
    });
  }

  /** 上一周/下一周（限制在 1~MAX_WEEK） */
  function goWeek(delta, animate) {
    var w = state.week + delta;
    if (w < 1 || w > MAX_WEEK) return;
    var wrap = $('#ttWrap');
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!animate || !wrap || reduce) { state.week = w; renderAll(); return; }
    // 翻页效果：旧页朝滑动方向滑出淡出，新页从反方向滑入
    var dir = delta > 0 ? 1 : -1;
    wrap.style.transition = 'transform .16s ease-in, opacity .16s ease-in';
    wrap.style.transform = 'translateX(' + (-dir * 56) + 'px)';
    wrap.style.opacity = '0.2';
    setTimeout(function () {
      state.week = w;
      renderAll();
      wrap.style.transition = 'none';
      wrap.style.transform = 'translateX(' + (dir * 56) + 'px)';
      wrap.style.opacity = '0.2';
      void wrap.offsetWidth;                    // 强制回流，保证下一帧动画生效
      wrap.style.transition = 'transform .2s ease-out, opacity .2s ease-out';
      wrap.style.transform = 'translateX(0)';
      wrap.style.opacity = '1';
    }, 165);
  }

  /** 手机端左右滑动切换周次（左滑=下周，右滑=上周；鼠标按住拖动同样可用）。
   *  轻扫距离 >64px 且横向明显大于纵向才触发；触发后拦截紧跟的点击，防止误触课程/格子。
   *  全部用 window 捕获阶段监听：从课程卡上起滑也不会被卡片自身的处理器挡住。 */
  function initSwipeNav() {
    var sx = 0, sy = 0, on = false, pid = null, swiped = false;
    window.addEventListener('pointerdown', function (e) {
      var g = e.target && e.target.closest ? e.target.closest('#ttWrap') : null;
      if (!g) return;                                       // 只在课表区域内启动
      if (document.querySelector('.modal-backdrop:not(.hidden)')) return;   // 弹窗打开时不启用
      if (e.target.closest('button, input, select, textarea, a')) return;   // 从控件上开始的滑动不算
      sx = e.clientX; sy = e.clientY; on = true; pid = e.pointerId; swiped = false;
    }, true);
    window.addEventListener('pointermove', function (e) {
      if (!on || e.pointerId !== pid || swiped) return;
      var dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.abs(dx) > 64 && Math.abs(dx) > Math.abs(dy) * 1.8) {
        swiped = true;
        if (navigator.vibrate) navigator.vibrate(12);       // 轻微震动反馈
        goWeek(dx < 0 ? 1 : -1, true);                      // 带翻页动画
      }
    }, true);
    window.addEventListener('pointerup', function () {
      if (on && swiped) setTimeout(function () { swiped = false; }, 350);  // 兜底复位
      on = false; pid = null;
    }, true);
    window.addEventListener('pointercancel', function () { on = false; pid = null; }, true);
    var wrap = $('#ttWrap');
    if (wrap) wrap.addEventListener('click', function (e) {
      if (!swiped) return;
      e.stopPropagation(); e.preventDefault();              // 吃掉滑动结束后的那次 click
      swiped = false;
    }, true);
  }

  /* ---------- 密钥激活门（顶层：bindEvents 绑定、meCheckUpdate、入口共同使用） ---------- */
  function syncMe() {
    var ph = $('#mePhone'), st = $('#meState'), av = $('#meAvatar');
    if (!ph) return;
    var info = null;
    try { info = (window.KBBridge && window.KBBridge.keyInfo) ? JSON.parse(window.KBBridge.keyInfo()) : null; } catch (e) { }
    if (!info && window.KBBridge && window.KBBridge.keyTail && window.KBBridge.keyTail()) {
      info = { unlocked: true, forever: true, tail: window.KBBridge.keyTail(), leftDays: -1, expire: '' };  // 旧版桥兜底
    }
    if (info && info.unlocked && (info.forever || info.leftDays > 0)) {
      ph.textContent = '已激活 · ' + (info.forever ? '永久有效' : '剩 ' + info.leftDays + ' 天（至 ' + info.expire + '）');
      st.textContent = info.forever ? '密钥有效，全部功能可用' : '限时密钥，全部功能可用';
      av.textContent = '✓';
    } else {
      ph.textContent = (info && info.tail && !info.unlocked) ? '已过期 · ****' + info.tail : '未激活';
      st.textContent = (info && info.tail && !info.unlocked) ? '密钥已过期，请联系管理员续期' : '请输入管理员提供的密钥';
      av.textContent = (info && info.tail && !info.unlocked) ? '⏳' : '🔒';
    }
    var ver = $('#meVer');
    if (ver) ver.textContent = 'RainFall课程表 · v20261220a';
  }
  function openMeModal() { syncMe(); $('#meModal').classList.remove('hidden'); }
  function closeMeModal() { $('#meModal').classList.add('hidden'); }
  function openLockModal() {
    $('#lockKey').value = '';
    var e = $('#lockErr'); e.textContent = ''; e.classList.add('hidden');
    $('#lockModal').classList.remove('hidden');
  }
  /** 首次进入：未激活则锁定 */
  function lockGate() {
    if (!(window.KBBridge && window.KBBridge.isUnlocked)) return;   // 网页版不锁
    if (window.KBBridge.isUnlocked()) { syncMe(); return; }
    openLockModal();
  }

  /** 云更新：检查 version.json → 下载 APK → 调起安装（检查与下载都是多源自动接力） */
  var GH_RAW = 'https://raw.githubusercontent.com/liuguanze222-jpg/schedule-of-classes/main/';
  var GH_JS = 'https://cdn.jsdelivr.net/gh/liuguanze222-jpg/schedule-of-classes@main/';
  var GH_FAST = 'https://ghfast.top/https://raw.githubusercontent.com/liuguanze222-jpg/schedule-of-classes/main/';
  var GH_PROXY = 'https://gh-proxy.com/https://raw.githubusercontent.com/liuguanze222-jpg/schedule-of-classes/main/';
  // 检查源按国内可达性排序：jsDelivr → raw → gh-proxy → ghfast（发布时都会清 jsDelivr 缓存）
  var UPD_CHECK_SOURCES = [GH_JS + 'version.json', GH_RAW + 'version.json', GH_PROXY + 'version.json', GH_FAST + 'version.json'];
  var UPD_PART_MIRRORS = [GH_JS, GH_RAW, GH_PROXY, GH_FAST];
  function meCheckUpdate() {
    closeMeModal();
    if (!(window.KBBridge && window.KBBridge.cloudCheck)) {
      toast(/iPad|iPhone|iPod/.test(navigator.userAgent) ? 'iPhone 版打开即是最新，网页自动更新 ✅' : '网页版不支持应用内更新', 'err');
      return;
    }
    toast('正在检查更新…');
    var si = 0;
    window.__updCheck = function (raw) {
      try {
        var d = JSON.parse(raw);
        if (d.ok === false || !d.version) {
          si++;
          if (si < UPD_CHECK_SOURCES.length) { window.KBBridge.cloudCheck(UPD_CHECK_SOURCES[si]); return; }
          toast('检查失败：' + (d.error || '网络不通') + '。4 个源全挂，请切换 WiFi/流量再试', 'err');
          return;
        }
        if (+d.version <= 20261220) { toast('已是最新版本 v20261220a'); return; }
        toast('发现新版 v' + d.version + '，开始下载…');
        if (d.apkUrl === 'parts' && d.parts > 0 && window.KBBridge.downloadParts) {
          // 三级下载镜像自动接力（顺序同检查源：jsDelivr → raw → gh-proxy）
          var mirrors = UPD_PART_MIRRORS;
          var mi = 0;
          window.__dlResult = function (ok, err) {
            if (ok) { toast('下载完成，正在调起安装'); window.KBBridge.installUpdate(); return; }
            mi++;
            if (mi < mirrors.length) {
              toast('下载源不通，切换镜像 ' + (mi + 1) + '/' + mirrors.length + ' 重试…');
              var urls2 = [];
              for (var i = 0; i < d.parts; i++) urls2.push(mirrors[mi] + 'update.apk.' + i);
              window.KBBridge.downloadParts(JSON.stringify(urls2));
              return;
            }
            toast('下载失败：' + err + '（三个源都不通，请换个网络再试）', 'err');
          };
          var urls = [];
          for (var i = 0; i < d.parts; i++) urls.push(mirrors[0] + 'update.apk.' + i);
          window.KBBridge.downloadParts(JSON.stringify(urls));
          return;
        }
        if (!d.apkUrl) { toast('新版本存在但没有 APK 地址', 'err'); return; }
        window.__dlResult = function (ok, err) {
          if (ok) { toast('下载完成，正在调起安装'); window.KBBridge.installUpdate(); }
          else toast('下载失败：' + err, 'err');
        };
        window.KBBridge.downloadUpdate(d.apkUrl);
      } catch (e) { toast('更新信息异常', 'err'); }
    };
    window.KBBridge.cloudCheck(UPD_CHECK_SOURCES[0]);
  }

  /** 结束节次自动不早于开始节次 */
  function fixEndPeriod() {
    if (+$('#fEnd').value < +$('#fStart').value) $('#fEnd').value = $('#fStart').value;
  }

  /* ---------- 入口 ---------- */
  load();
  rebuildPeriods();                          // 生效节次表（含贵校作息覆盖）
  applyTheme(state.settings.theme);          // 恢复上次选择的主题
  applyBrand();                              // 学校名称 → 标题
  applyHeaderStyle();                        // 表头样式主题
  applyAppearance();                         // 恢复材质与壁纸
  autoPerf = detectHardware() ? 'webgl' : 'css';   // 弱机自动降级
  applyPerfMode();                           // 启动满血/兼容渲染
  state.week = currentWeek();
  fillPeriodSelects();
  bindEvents();
  renderAll();
  checkReminders();
  pushWidgetToday();   // 打开 APP 即同步小组件（消散动画/样式/提醒排程的数据源）
  if (state.settings.remindOn && window.KBBridge && window.KBBridge.ensureNotifPerm) {
    try { window.KBBridge.ensureNotifPerm(); } catch (e) { }   // 开着提醒 → 确保系统通知权限（未授权才弹）
  }
  lockGate();          // 密钥激活门（APP）                          // 打开页面先检查一次提醒

  // 调试 / 自动化测试钩子（不影响正常使用）
  window.__kbc = { state: state, checkReminders: checkReminders, updateNowLine: updateNowLine };
})();
