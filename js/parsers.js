/* ============================================================
 * 课程表文件解析器（parsers.js）
 * ------------------------------------------------------------
 * 职责：把学校教务系统导出的 ics / excel 文本，解析成统一的课程对象：
 *   { name, teacher, room, day(1-7), start(节次), end(节次),
 *     weekStart, weekEnd, weekType('all'|'odd'|'even') }
 *
 * 对外接口（挂载在 window.ScheduleParsers）：
 *   ScheduleParsers.config            —— 作息时间表（app.js 也读取它）
 *   ScheduleParsers.parseICS(text, semesterStartISO) -> {courses, warnings, inferredStart}
 *   ScheduleParsers.parseExcel(workbook, semesterStartISO) -> {courses, warnings}
 *   ScheduleParsers.parsePasted(html, text)           -> {courses, warnings}  粘贴导入
 *
 * 解析均为"启发式"：各校导出格式差异大，识别不了的单元格会记入
 * warnings，在导入预览里展示给用户，由用户手动修正。
 * ============================================================ */
(function (root) {
  'use strict';

  /* ------------------------------------------------------------
   * 0. 学校专属配置（河北东方学院 · 专属版）
   *    作息为"大节模式"，五条行标与教务系统课表页完全一致；
   *    第五大节（晚）常驻显示，没课时为空行。
   * ---------------------------------------------------------- */
  var config = {
    SCHOOL_NAME: '河北东方学院',
    SCHOOL_ID: 'HBDX',
    PERIOD_TIMES: [
      { no: 1, name: '第一大节', start: '08:10', end: '09:50' },   // 01-02小节
      { no: 2, name: '第二大节', start: '10:10', end: '11:50' },   // 03-04小节
      { no: 3, name: '第三大节', start: '14:00', end: '15:40' },   // 05-06小节
      { no: 4, name: '第四大节', start: '16:00', end: '17:40' },   // 07-08小节
      { no: 5, name: '第五大节', start: '19:00', end: '20:40' }    // 09-10小节（晚）
    ]
  };
  // 预计算每节课的分钟数，便于时间匹配
  config.PERIOD_TIMES.forEach(function (p) {
    p.startMin = toMinutes(p.start);
    p.endMin = toMinutes(p.end);
  });

  // 已采用"贵校作息"时，app.js 会把实际节次表注入这里；
  // 之后导入解析按贵校时间匹配节次（未采用时用内置 12 节表）
  var ACTIVE = null;
  config.setActivePeriods = function (list) { ACTIVE = (list && list.length) ? list : null; };

  var CN_DAY = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 7, '天': 7,
                 '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7 };
  var CN_NUM = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8,
                 '九': 9, '十': 10, '十一': 11, '十二': 12, '十三': 13, '十四': 14 };

  /* ------------------------------------------------------------
   * 1. 通用小工具
   * ---------------------------------------------------------- */

  /** 任意值转去空格字符串 */
  function s(v) {
    if (v == null) return '';
    return String(v).trim();
  }

  /** "08:00" -> 480（分钟） */
  function toMinutes(hhmm) {
    var m = hhmm.split(':');
    return (+m[0]) * 60 + (+m[1]);
  }

  /** 把日期规整到所在周的周一 0 点 */
  function mondayOf(d) {
    var x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    x.setDate(x.getDate() - ((x.getDay() + 6) % 7));   // 周一为一周开始
    return x;
  }

  /** 'YYYY-MM-DD' -> 本地时区 Date */
  function parseISODate(iso) {
    var m = s(iso).match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
  }

  /** Date -> 'YYYY-MM-DD' */
  function toISODate(d) {
    function p2(n) { return n < 10 ? '0' + n : '' + n; }
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
  }

  /** 某日期处于学期第几周（startMonday 为第 1 周周一） */
  function weekOf(date, startMonday) {
    return Math.round((mondayOf(date) - startMonday) / (7 * 86400000)) + 1;
  }

  /** 识别星期：支持 周一 / 星期三 / 礼拜天 / Monday / 纯数字 1-7 */
  function dayFromText(t) {
    t = s(t);
    if (!t) return null;
    var en = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7 };
    var m = t.toLowerCase().match(/(mon|tue|wed|thu|fri|sat|sun)/);
    if (m) return en[m[1]];
    m = t.match(/[星期周礼拜]\s*([一二三四五六日天1-7])/);
    if (m) return CN_DAY[m[1]];
    if (/^[1-7]$/.test(t)) return +t;
    return null;
  }

  /**
   * 识别周次文本："1-16周" "第1-8周(单)" "6-13周双" "第3周"
   * 以及多段式："1-5,7-17周" "1-5,7-17(周)"（范围之外的周记入 holes，
   * 课程对象里保存为 weeksOff 排除周，保证显示不虚增）
   * 返回 { weekStart, weekEnd, weekType, holes } 或 null
   */
  function weeksFromText(t) {
    t = s(t);
    if (!t) return null;
    var m = t.match(/(\d{1,2}\s*(?:[-–~至]\s*\d{1,2})?(?:\s*[,，]\s*\d{1,2}\s*(?:[-–~至]\s*\d{1,2})?)*)\s*[（(]?\s*周/);
    if (!m) m = t.match(/第\s*(\d{1,2})\s*周/);
    if (!m) return null;
    var segs = [];
    m[1].split(/\s*[,，]\s*/).forEach(function (seg) {
      var mm = seg.match(/(\d{1,2})\s*(?:[-–~至]\s*(\d{1,2}))?/);
      if (!mm) return;
      segs.push([+mm[1], mm[2] ? +mm[2] : +mm[1]]);
    });
    if (!segs.length) return null;
    var ws = segs[0][0], we = segs[0][1];
    segs.forEach(function (p) { ws = Math.min(ws, p[0]); we = Math.max(we, p[1]); });
    var holes = null;
    if (segs.length > 1) {
      holes = [];
      for (var w = ws; w <= we; w++) {
        var inside = false;
        for (var k = 0; k < segs.length; k++) {
          if (w >= segs[k][0] && w <= segs[k][1]) { inside = true; break; }
        }
        if (!inside) holes.push(w);
      }
    }
    var type = 'all';
    if (/单|odd/i.test(t)) type = 'odd';
    else if (/双|even/i.test(t)) type = 'even';
    return { weekStart: ws, weekEnd: we, weekType: type, holes: holes };
  }

  /**
   * 时间 -> 节次。取开始时间与节次表相差 ≤25 分钟的节；
   * 找不到就取时间上最接近的一节（尽量不丢课）。
   */
  function slotFromStart(minutes) {
    var table = ACTIVE || config.PERIOD_TIMES;
    var best = 1, bestDiff = Infinity;
    for (var i = 0; i < table.length; i++) {
      var p = table[i];
      var diff = Math.abs(p.startMin - minutes);
      if (diff <= 25) return i + 1;
      if (diff < bestDiff) { bestDiff = diff; best = i + 1; }
    }
    return best;
  }

  /** 结束时间 -> 结束节次（同理，按节次表"结束时间"匹配） */
  function slotFromEnd(minutes, startSlot) {
    var table = ACTIVE || config.PERIOD_TIMES;
    for (var i = 0; i < table.length; i++) {
      if (Math.abs(table[i].endMin - minutes) <= 25) return i + 1;
    }
    // 匹配不上时按每节约 50 分钟估一格
    var est = startSlot + Math.max(0, Math.round((minutes - table[startSlot - 1].startMin) / 50)) - (minutes > table[startSlot - 1].startMin ? 1 : 0);
    return Math.min(Math.max(est, startSlot), table.length);
  }

  /**
   * 节次标签 -> { start, end }："第1-2节" "1,2节" "第三节" "08:00"
   * 优先级：显式"第N节/第X节"编号 > 纯时间 > 裸数字范围。
   * 教务系统标签几乎都带"第N节"字样，编号最可靠（各校时间不同，
   * 按内置时间表反推会错位）；标签里若同时带时间，一并记入
   * timeStart/timeEnd，供"贵校作息自动检测"使用。
   */
  function periodsFromLabel(t) {
    t = s(t);
    if (!t) return null;
    var tv = t.match(/(\d{1,2}:\d{2})\s*[-–~]?\s*(\d{1,2}:\d{2})?/);
    var tS = tv ? tv[1] : '', tE = (tv && tv[2]) ? tv[2] : '';
    function mk(a, b) {
      var r = { start: Math.min(a, b), end: Math.max(a, b) };
      if (tS) { r.timeStart = tS; r.timeEnd = tE; }
      return r;
    }
    // ① "第N节" / "第N-M节"（阿拉伯数字）
    var m = t.match(/第\s*(\d{1,2})\s*(?:[-–~,，]\s*(\d{1,2}))?\s*节/);
    if (m) return mk(+m[1], m[2] ? +m[2] : +m[1]);
    // ② "第一节" / "第一-二节"（中文数字）
    m = t.match(/第\s*([一二三四五六七八九十]+)\s*(?:[-–~,，至]\s*([一二三四五六七八九十]+))?\s*节/);
    if (m) {
      var a = CN_NUM[m[1]];
      var b = m[2] ? CN_NUM[m[2]] : a;
      if (a && b) return mk(Math.min(a, b), Math.max(a, b));
    }
    // ③ "1,2节" / "1-2节"（无"第"字，但有"节"字兜底，不会误吃时间）
    m = t.match(/(\d{1,2})\s*[-–~,，]\s*(\d{1,2})\s*节/);
    if (m) return mk(+m[1], +m[2]);
    // ④ 纯时间："08:00" 或 "08:00-09:40"（按节次表匹配到节次号）
    if (tS) {
      var st = slotFromStart(toMinutes(tS));
      var en = tE ? slotFromEnd(toMinutes(tE), st) : st;
      return mk(st, en);
    }
    // ⑤ 裸数字范围："1-2"（必须整串匹配，防止吃进 "08:00-09:40" 的片段）
    m = t.match(/^第?\s*(\d{1,2})\s*[-–~,，]\s*(\d{1,2})\s*节?$/);
    if (m) return mk(+m[1], +m[2]);
    return null;
  }

  /** 清洗课程名：去掉周次片段、编号前缀（如 "12."）、首尾符号 */
  function cleanName(name) {
    name = s(name)
      .replace(/第?\s*\d{1,2}\s*[-–~至]\s*\d{1,2}\s*周[^，,;；\n]*/g, '')
      .replace(/^\d{1,2}[.、]\s*/, '')
      .replace(/^[-—_|※•·\s]+|[-—_|※•·\s]+$/g, '');
    return name;
  }

  /** 从文本里猜教师（"教师：张三" / "张三老师" / 独立中文短行） */
  function teacherFromText(t) {
    if (!t) return '';
    var m = t.match(/(?:授课教师|任课教师|主讲教师|指导教师|教师|老师|讲师)\s*[:：]\s*([\u4e00-\u9fa5·]{2,5})/);
    if (m) return m[1];
    m = t.match(/([\u4e00-\u9fa5·]{2,4})(?:老师|教授)/);
    if (m) return m[1];
    return '';
  }

  /** 判断一行文本是否"像教室"（含楼室馆或楼-房号） */
  function roomLike(t) {
    if (!t) return false;
    if (/[楼室馆厅房区栋]|教室|机房|操场|体育馆|实验/.test(t)) return true;
    if (/周|节/.test(t)) return false;                                        // 含周/节的一律不当教室
    if (/\d{1,3}\s*[-–]\s*\d{3,4}/.test(t)) return true;                      // 如 教1-301 / 2-201
    if (/[A-Za-z]\s*[-–]\s*\d{2,4}/.test(t)) return true;                     // 如 文B-202
    if (/^[一-龥]{1,5}[A-Za-z]?\d{2,4}$/.test(t)) return true;                // 如 物理楼201 / A301
    return false;
  }

  /** 判断一行文本是否"像教师"（纯中文 2-4 字，且不像教室不像周次术语） */
  function teacherLike(t) {
    t = s(t);
    if (!/^[\u4e00-\u9fa5·]{2,4}$/.test(t)) return false;
    if (roomLike(t)) return false;
    if (/^(单周|双周|周次|本周|上周|下周)$/.test(t)) return false;   // 排除周次术语（不影响"周涛"这类姓名）
    return true;
  }

  /* ------------------------------------------------------------
   * 2. ICS 解析
   * ---------------------------------------------------------- */
  function parseICS(text, semesterStartISO) {
    var warnings = [];
    // 折行还原：RFC5545 规定长行以 CRLF+空格 续行
    var unfolded = s(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '');
    var blocks = unfolded.split(/BEGIN:VEVENT/i).slice(1);
    if (!blocks.length) {
      warnings.push('文件里没有找到任何 VEVENT 日程（确认这是课程表 ics 文件）');
      return { courses: [], warnings: warnings, inferredStart: null };
    }

    // 先收集全部事件，便于在未设置学期起始日时，用最早事件的周一作为第 1 周
    var events = [];
    for (var i = 0; i < blocks.length; i++) {
      var ev = parseOneEvent(blocks[i], warnings, i + 1);
      if (ev) events.push(ev);
    }
    if (!events.length) return { courses: [], warnings: warnings, inferredStart: null };

    // 确定学期第 1 周周一：优先用户设置，否则自动推断（最早事件的周一）
    var startMonday = parseISODate(semesterStartISO);
    var inferredStart = null;
    if (!startMonday) {
      var min = null;
      events.forEach(function (e) { if (e.date && (!min || e.date < min)) min = e.date; });
      if (min) {
        startMonday = mondayOf(min);
        inferredStart = toISODate(startMonday);
      }
    }

    // UNTIL 日期统一换算成周数（必须先确定第 1 周周一）
    events.forEach(function (e) {
      if (e._untilDate && startMonday) e.untilWeek = Math.max(1, weekOf(e._untilDate, startMonday));
    });

    // 展开为课程对象并合并重复（同一门课每周一条 → 合并周次范围）
    var merged = {};
    var courses = [];
    events.forEach(function (e) {
      if (!e.date) return;
      if (!startMonday) return;                       // 理论上不会发生
      var w = weekOf(e.date, startMonday);
      if (w < 1) w = 1;
      var weekType = 'all';
      var weekEnd = w;
      if (e.interval === 2) {                          // 隔周重复 → 按首week奇偶定单双周
        weekType = (w % 2 === 1) ? 'odd' : 'even';
        weekEnd = e.untilWeek ? e.untilWeek : Math.min(w + 15, 30);
      } else if (e.interval > 2) {
        weekEnd = e.untilWeek ? e.untilWeek : Math.min(w + (e.interval - 1) * 15, 30);
      } else if (e.untilWeek) {
        weekEnd = e.untilWeek;                         // 每周重复到 UNTIL
      } else if (e.count) {
        weekEnd = Math.min(w + e.count - 1, 30);       // 每周重复 COUNT 次
      }
      var key = [e.name, e.day, e.start, e.end, e.room, e.teacher, weekType].join('|');
      if (merged[key]) {                               // 同一门课：扩大周次范围
        merged[key].weekStart = Math.min(merged[key].weekStart, w);
        merged[key].weekEnd = Math.max(merged[key].weekEnd, weekEnd);
      } else {
        var c = { name: e.name, teacher: e.teacher, room: e.room, day: e.day,
                  start: e.start, end: e.end, weekStart: w, weekEnd: weekEnd, weekType: weekType };
        merged[key] = c;
        courses.push(c);
      }
    });

    return { courses: courses, warnings: warnings, inferredStart: inferredStart };
  }

  /** 解析单个 VEVENT 块 */
  function parseOneEvent(block, warnings, idx) {
    var prop = {};
    var lines = block.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].match(/^([A-Za-z0-9-]+)((?:;[^:]*)?):(.*)$/);
      if (!m) continue;
      var key = m[1].toUpperCase();
      if (!(key in prop)) prop[key] = m[3].trim();     // 同名属性只取第一个
    }
    if (!prop.DTSTART) {
      warnings.push('第 ' + idx + ' 条日程缺少开始时间，已跳过');
      return null;
    }
    var dt = parseICSDateTime(prop.DTSTART);
    if (!dt || !dt.date) {
      warnings.push('第 ' + idx + ' 条日程的开始时间无法识别，已跳过');
      return null;
    }
    // 全天事件不是课：除非描述里写了节次
    var start = null, end = null;
    if (dt.allDay) {
      var p = periodsFromLabel(prop.DESCRIPTION || '');
      if (!p) {
        warnings.push('“' + (prop.SUMMARY || '未命名') + '”是全天日程且无节次信息，已跳过');
        return null;
      }
      start = p.start; end = p.end;
    } else {
      start = slotFromStart(dt.minutes);
      var de = prop.DTEND ? parseICSDateTime(prop.DTEND) : null;
      end = de && !de.allDay ? slotFromEnd(de.minutes, start) : start;
      end = Math.max(start, Math.min(end, 12));
    }

    var name = prop.SUMMARY || '未命名课程';
    // 教师识别优先级：DESCRIPTION 明确标注 > SUMMARY 标注 > 课名尾部括号猜测
    var teacher = teacherFromText(prop.DESCRIPTION) || teacherFromText(prop.SUMMARY);
    if (!teacher) {
      // 课名尾部的括号若像教师名（如“高等数学(张三)”）则拆出来
      name = name.replace(/[（(]([^）)]{2,6})[）)]\s*$/, function (_, inner) {
        if (teacherLike(inner)) { teacher = inner; return ''; }
        return inner;                                  // 不像教师则保留
      });
    }

    // RRULE 重复规则：FREQ=WEEKLY;INTERVAL=2;UNTIL=.../COUNT=...
    var interval = 1, untilWeek = null, count = null;
    if (prop.RRULE) {
      var parts = {};
      prop.RRULE.split(';').forEach(function (kv) {
        var p = kv.split('=');
        if (p.length === 2) parts[p[0].toUpperCase()] = p[1];
      });
      if (/WEEKLY/i.test(parts.FREQ || '')) interval = Math.max(1, parseInt(parts.INTERVAL || '1', 10) || 1);
      if (parts.UNTIL) {
        var u = parseICSDateTime(parts.UNTIL);
        if (u && u.date) untilWeek = u.date;           // 先记原始日期，下面统一换算周数
      }
      if (parts.COUNT) count = parseInt(parts.COUNT, 10) || null;
    }

    return {
      name: cleanName(name) || '未命名课程',
      teacher: teacher,
      room: s(prop.LOCATION),
      day: ((dt.date.getDay() + 6) % 7) + 1,           // JS 周日=0 → 转成周一=1..周日=7
      start: start,
      end: end,
      date: dt.date,
      interval: interval,
      count: count,
      untilWeek: null,
      _untilDate: untilWeek
    };
  }

  /**
   * 解析 ICS 日期时间：
   *   20251103T080000（本地浮点）、20251103T000000Z（UTC，按北京时间+8 折算）、
   *   20251103（全天）
   */
  function parseICSDateTime(v) {
    v = s(v);
    var m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
    if (!m) return null;
    var y = +m[1], mo = +m[2], d = +m[3];
    if (!m[4]) return { date: new Date(y, mo - 1, d), minutes: 0, allDay: true };
    var h = +m[4], mi = +m[5];
    if (m[7]) {                                        // 带 Z：UTC 时间，按东八区 +8h
      var t = new Date(Date.UTC(y, mo - 1, d, h, mi));
      t.setHours(t.getHours() + 8);
      return { date: new Date(t.getFullYear(), t.getMonth(), t.getDate()),
               minutes: t.getHours() * 60 + t.getMinutes(), allDay: false };
    }
    return { date: new Date(y, mo - 1, d), minutes: h * 60 + mi, allDay: false };
  }

  /* ------------------------------------------------------------
   * 3. Excel 解析
   *    兼容两种布局：
   *    A. 网格式：行=节次、列=星期，单元格多行文本（最常见）
   *    B. 列表式：表头含 课程/教师/星期/节次/教室/周次 字段
   *    竖向合并单元格（一节课跨 1-2 节）通过 !merges 展开。
   * ---------------------------------------------------------- */
  function parseExcel(wb, semesterStartISO) {
    var warnings = [];
    var best = null;
    for (var i = 0; i < wb.SheetNames.length; i++) {
      var name = wb.SheetNames[i];
      var ws = wb.Sheets[name];
      var matrix = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })
        .map(function (row) { return row.map(function (c) { return s(c); }); });
      matrix = padMatrix(matrix);
      matrix = expandMerges(matrix, ws['!merges']);    // 合并单元格的值复制到每一格

      var res = tryParseSheet(matrix, warnings, name);
      if (res && (!best || res.courses.length > best.courses.length)) best = res;  // 取识别最多课的 sheet
    }
    if (!best) {
      warnings.push('所有工作表都未找到“周一~周日”表头，无法识别课表结构');
      best = { courses: [], warnings: [] };
    }
    return { courses: best.courses, warnings: warnings, detectedPeriods: best.detected || null };
  }

  /** 行长度补齐 + 去除全空行首尾 */
  function padMatrix(matrix) {
    var w = 0;
    matrix.forEach(function (r) { if (r.length > w) w = r.length; });
    return matrix.map(function (r) {
      while (r.length < w) r.push('');
      return r;
    });
  }

  /** 把合并单元格（!merges）的值扩散到区域内所有格子 */
  function expandMerges(matrix, merges) {
    if (!merges || !merges.length) return matrix;
    merges.forEach(function (mg) {
      var v = matrix[mg.s.r] ? matrix[mg.s.r][mg.s.c] : '';
      if (!v) return;
      for (var r = mg.s.r; r <= mg.e.r && r < matrix.length; r++) {
        for (var c = mg.s.c; c <= mg.e.c && c < matrix[r].length; c++) {
          matrix[r][c] = v;
        }
      }
    });
    return matrix;
  }

  /** 解析单个工作表：先定位表头，再分 网格/列表 两种模式 */
  function tryParseSheet(matrix, warnings, sheetName) {
    // ---- 1) 找"星期表头行"：某一行里有 ≥3 个不同的星期 ----
    var headerRow = -1, dayCols = null;
    for (var r = 0; r < Math.min(matrix.length, 12); r++) {
      var cols = {};
      for (var c = 0; c < matrix[r].length; c++) {
        var d = dayFromText(matrix[r][c].replace(/\d{1,2}[.\/]\d{1,2}/g, '')); // 去掉表头里附带的日期
        if (d && !(d in cols)) cols[d] = c;
      }
      if (Object.keys(cols).length >= 3) { headerRow = r; dayCols = cols; break; }
    }

    // ---- 2) 找不到行表头 → 尝试"转置"（行=星期、列=节次的表格）----
    if (headerRow < 0) {
      for (var c2 = 0; c2 < Math.min(matrix[0] ? matrix[0].length : 0, 12); c2++) {
        var cnt = 0;
        for (var r2 = 0; r2 < matrix.length; r2++) {
          if (dayFromText(matrix[r2][c2])) cnt++;
        }
        if (cnt >= 3) { matrix = transpose(matrix); return tryParseSheet(matrix, warnings, sheetName); }
      }
      return null;                                     // 这个 sheet 认不出结构
    }

    // ---- 3) 判断列表式表头：本行还含 课程/教师/教室/节次/周次 字段 ----
    var headText = matrix[headerRow].join('|');
    var fieldHits = (headText.match(/课程|名称|教师|老师|教室|地点|节次|时间|周次/g) || []).length;
    if (fieldHits >= 2) {
      return parseListLayout(matrix, headerRow, warnings, sheetName);
    }
    return parseGridLayout(matrix, headerRow, dayCols, warnings, sheetName);
  }

  /** 矩阵转置（处理行=星期、列=节次的表） */
  function transpose(m) {
    var out = [];
    for (var c = 0; c < m[0].length; c++) {
      var row = [];
      for (var r = 0; r < m.length; r++) row.push(m[r][c]);
      out.push(row);
    }
    return out;
  }

  /**
   * 网格模式：列=星期（dayCols），行=节次。
   * 节次标签在 dayCols 最左侧列之前的某一列（常见为第 0 列）。
   */
  function parseGridLayout(matrix, headerRow, dayCols, warnings, sheetName) {
    var courses = [];
    var skipped = 0;
    var detected = {};               // 贵校作息检测：节次号 -> {start:'08:20', end:'09:05'}
    // 节次标签列 = 表头行里、所有星期列左边第一个非空列所在位置
    var minCol = Infinity;
    for (var d in dayCols) minCol = Math.min(minCol, dayCols[d]);
    var labelCol = -1;
    for (var c = 0; c < minCol; c++) {
      for (var r = headerRow + 1; r < matrix.length; r++) {
        if (matrix[r][c]) { labelCol = c; r = matrix.length; break; }
      }
    }

    var lastPeriods = null;                            // 记住上一行的节次，用于无标签行递推
    var prevLabelText = null, prevRow = null;          // 用于识别竖向合并的标签
    for (var r2 = headerRow + 1; r2 < matrix.length; r2++) {
      var row = matrix[r2];
      var labelText = labelCol >= 0 ? row[labelCol] : '';
      var p = null;
      if (labelText && labelText === prevLabelText) {
        // 标签被竖向合并（同一格文字扩散到多行）：
        // 若本行各天内容与上一行完全一致 → 是同一合并课程块，跳过；
        // 否则按连续节次递推（如标签"第1-2节"跨两行但课程不同）
        var identical = true;
        for (var dk in dayCols) {
          if (row[dayCols[dk]] !== (prevRow ? prevRow[dayCols[dk]] : null)) { identical = false; break; }
        }
        if (identical) { prevLabelText = labelText; prevRow = row; continue; }
        if (lastPeriods) p = { start: lastPeriods.end + 1, end: lastPeriods.end + 1 };
      } else if (labelText) {
        p = periodsFromLabel(labelText);
      }
      if (!p && /[上午下午晚上午休]/.test(labelText)) {            // “上午/下午”等分组行，跳过
        prevLabelText = labelText; prevRow = row; continue;
      }
      if (!p && lastPeriods) p = { start: lastPeriods.end + 1, end: lastPeriods.end + 1 };
      if (!p || p.start < 1 || p.start > 12) { prevLabelText = labelText; prevRow = row; continue; }
      lastPeriods = p;
      // 记录带原始时间的节次标签（"第一节 08:20-09:05"）→ 贵校作息
      if (p.timeStart && p.start >= 1 && p.start <= 12 && !detected[p.start]) {
        detected[p.start] = { start: p.timeStart, end: p.timeEnd || '' };
      }

      // 该行每个星期列（每大节一张卡，不做跨行合并——与教务系统显示一致）
      for (var day in dayCols) {
        var cell = row[dayCols[day]];
        if (!cell) continue;
        var coList = parseCellText(cell, +day, p.start, p.end);   // 一格可能多门课（单双周分栏）
        if (!coList) { skipped++; continue; }
        coList.forEach(function (co) { courses.push(co); });
      }
      prevLabelText = labelText;
      prevRow = row;
    }
    if (skipped) warnings.push('工作表“' + sheetName + '”有 ' + skipped + ' 个单元格无法识别课程名');
    return { courses: courses, warnings: warnings, detected: detected };
  }

  /** （跨行合并已移除：大节模式下每大节一张课程卡，与教务系统一致） */

  /** 列表模式：按表头字段名取列 */
  function parseListLayout(matrix, headerRow, warnings, sheetName) {
    var colMap = { name: -1, teacher: -1, room: -1, day: -1, period: -1, week: -1 };
    for (var c = 0; c < matrix[headerRow].length; c++) {
      var h = matrix[headerRow][c];
      if (colMap.name < 0 && /课程|名称/.test(h)) colMap.name = c;
      else if (colMap.teacher < 0 && /教师|老师|主讲/.test(h)) colMap.teacher = c;
      else if (colMap.room < 0 && /教室|地点|上课地点/.test(h)) colMap.room = c;
      else if (colMap.day < 0 && /星期|礼拜|周(?![次])/.test(h)) colMap.day = c;
      else if (colMap.period < 0 && /节|时间/.test(h)) colMap.period = c;
      else if (colMap.week < 0 && /周次/.test(h)) colMap.week = c;
    }
    if (colMap.name < 0 || colMap.day < 0) {
      warnings.push('工作表“' + sheetName + '”表头缺少“课程”或“星期”字段');
      return { courses: [], warnings: warnings };
    }
    var courses = [];
    for (var r = headerRow + 1; r < matrix.length; r++) {
      var row = matrix[r];
      var name = cleanName(row[colMap.name]);
      if (!name) continue;
      var day = dayFromText(row[colMap.day]);
      if (!day) continue;
      var p = colMap.period >= 0 ? periodsFromLabel(row[colMap.period]) : null;
      if (!p) p = { start: 1, end: 1 };
      var wk = colMap.week >= 0 ? weeksFromText(row[colMap.week]) : null;
      courses.push({
        name: name,
        teacher: colMap.teacher >= 0 ? s(row[colMap.teacher]) : '',
        room: colMap.room >= 0 ? s(row[colMap.room]) : '',
        day: day, start: Math.max(1, Math.min(12, p.start)),
        end: Math.max(p.start, Math.min(12, p.end)),
        weekStart: wk ? wk.weekStart : 1,
        weekEnd: wk ? wk.weekEnd : 20,
        weekType: wk ? wk.weekType : 'all',
        weeksOff: (wk && wk.holes) ? wk.holes : null
      });
    }
    if (!courses.length) warnings.push('工作表“' + sheetName + '”未能识别出任何课程行');
    return { courses: courses, warnings: warnings };
  }

  /**
   * 解析一个课表格子文本（网格模式）。常见格式：
   *   高等数学\n张三\n教1-301\n1-16周(单)   —— 多行
   *   高等数学/张三/教1-301/1-16周          —— 单行带分隔符
   * 同一格子可能装着两门课（单周/双周轮流上课），中间用
   * ──── / ---- / ==== 等分隔线隔开 → 按块拆开逐个解析。
   * 返回课程数组（识别不出返回 null）。
   */
  function parseCellText(text, day, pStart, pEnd) {
    var lines = s(text).split(/\n+/).map(function (x) { return x.trim(); }).filter(Boolean);
    if (lines.length === 1 && /[/／|｜,，、;；]/.test(lines[0])) {
      lines = lines[0].split(/[/／|｜,，、;；]+/).map(function (x) { return x.trim(); }).filter(Boolean);
    }
    if (!lines.length) return null;

    // 按分隔线（纯符号行）切块
    var chunks = [[]];
    for (var i = 0; i < lines.length; i++) {
      if (/^[-—－―─━＝=*＊·•\s]{3,}$/.test(lines[i])) chunks.push([]);
      else chunks[chunks.length - 1].push(lines[i]);
    }
    var out = [];
    chunks.forEach(function (chk) {
      if (!chk.length) return;
      var co = parseCellChunk(chk, day, pStart, pEnd);
      if (co) out.push(co);
    });
    // 同格去重合并：强智会把同一门课渲染成"紧凑 + 详情"两块
    for (var a = 0; a < out.length; a++) {
      for (var b = out.length - 1; b > a; b--) {
        if (out[b].name === out[a].name && out[b].start === out[a].start && out[b].day === out[a].day) {
          if (!out[a].teacher && out[b].teacher) out[a].teacher = out[b].teacher;
          if (!out[a].room && out[b].room) out[a].room = out[b].room;
          out[a].weekStart = Math.min(out[a].weekStart, out[b].weekStart);
          out[a].weekEnd = Math.max(out[a].weekEnd, out[b].weekEnd);
          var hs = {}, w;
          (out[a].weeksOff || []).forEach(function (x) { hs[x] = 1; });
          (out[b].weeksOff || []).forEach(function (x) { hs[x] = 1; });
          w = Object.keys(hs).map(Number).sort(function (x, y) { return x - y; });
          out[a].weeksOff = w.length ? w : null;
          out.splice(b, 1);
        }
      }
    }
    return out.length ? out : null;
  }

  /** 解析格子里的单个课程信息块（lines ≥1 行） */
  function parseCellChunk(lines, day, pStart, pEnd) {
    var name = cleanName(lines[0]);
    if (!name) return null;
    if (/^[星期周礼拜][一二三四五六日天]$/.test(name)) return null;   // 表头格误入数据区，防御性跳过
    var teacher = '', room = '', weeks = null;
    for (var i = 1; i < lines.length; i++) {
      var ln = lines[i];
      if (!weeks && weeksFromText(ln)) { weeks = weeksFromText(ln); continue; }
      if (!teacher && teacherFromText(ln)) { teacher = teacherFromText(ln); continue; }
      if (!room && roomLike(ln)) { room = ln.replace(/^(上课地点|地点|教室|位置)\s*[:：]/, ''); continue; }
      if (!teacher && teacherLike(ln)) { teacher = ln; continue; }
      // 其余内容：若还像教室就当教室，否则忽略
      if (!room && roomLike(ln)) { room = ln.replace(/^(上课地点|地点|教室|位置)\s*[:：]/, ''); continue; }
    }
    return {
      name: name,
      teacher: teacher,
      room: room,
      day: day,
      start: pStart,
      end: pEnd,
      weekStart: weeks ? weeks.weekStart : 1,
      weekEnd: weeks ? weeks.weekEnd : 20,
      weekType: weeks ? weeks.weekType : 'all',
      weeksOff: (weeks && weeks.holes) ? weeks.holes : null
    };
  }

  /* ------------------------------------------------------------
   * 4. 粘贴导入解析（教务系统网页课表 → 课程）
   *    三种输入，按顺序尝试：
   *    ① JSON：本应用自有格式（供"控制台一键脚本"输出直连）
   *    ② 富文本表格 text/html：教务系统页面复制的 <table>（最精确，
   *       自动展开 rowspan/colspan 合并单元格，<br> 保留为多行）
   *    ③ 纯文本：TSV（制表符）或 2+ 空格分隔的行
   *    最终都交给与 Excel 相同的 tryParseSheet（网格式/列表式通吃）
   * ---------------------------------------------------------- */

  /** 单元格内部 HTML → 纯文本（<br>/块级标签转换行，保留多行结构） */
  function blockText(inner) {
    var div = document.createElement('div');
    div.innerHTML = String(inner || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(div|p|li|h[1-6])>/gi, '\n');
    return div.textContent.replace(/\u00a0/g, ' ')
      .split('\n').map(function (x) { return x.trim(); })
      .filter(Boolean).join('\n');
  }

  /**
   * 读取单元格文本。<br>/块级标签都转成换行；
   * 强智等系统把同格的多门课放在多个 div.kbcontent* 里 →
   * 块与块之间插入"━━━"分隔线，让多课分块解析能拆开。
   */
  function cellText(cell) {
    var blocks = cell.querySelectorAll ? cell.querySelectorAll('div[class*="kbcontent"]') : [];
    if (blocks && blocks.length >= 2) {
      var parts = [];
      Array.prototype.slice.call(blocks).forEach(function (b) {
        var t = blockText(b.innerHTML);
        if (t) parts.push(t);
      });
      if (parts.length >= 2) return parts.join('\n━━━\n');
    }
    return blockText(cell.innerHTML);
  }

  /**
   * 从富文本 HTML 里提取"最像课表"的 <table>，展开 rowspan/colspan，
   * 返回等宽二维字符串矩阵；找不到合适的表返回 null。
   */
  function matrixFromHTML(html) {
    var doc;
    try { doc = new DOMParser().parseFromString(html, 'text/html'); }
    catch (e) { return null; }
    var tables = Array.prototype.slice.call(doc.querySelectorAll('table'));
    if (!tables.length) return null;

    // 挑表：按"不同星期表头数"加权（避免"序号1~7"这类列表表被误选），
    // 同分时格子多者优先
    var best = null, bestScore = -1;
    tables.forEach(function (tb) {
      var score = 0;
      var cells = tb.querySelectorAll('td,th');
      var days = {};
      for (var i = 0; i < cells.length; i++) {
        var mm = s(cells[i].textContent).match(/星期\s*([一二三四五六日天])|周\s*([一二三四五六日天])/);
        if (mm) { days[mm[1] || mm[2]] = 1; score += 1; }
      }
      score += Object.keys(days).length * 10;
      score += cells.length / 100;
      if (score > bestScore) { bestScore = score; best = tb; }
    });
    if (!best) return null;

    // 展开 rowspan/colspan：map[r][c] = 文本
    var map = [];
    var rows = Array.prototype.slice.call(best.rows);
    for (var r = 0; r < rows.length; r++) {
      var cells = rows[r].cells;
      var c = 0;
      for (var i = 0; i < cells.length; i++) {
        while (map[r] && map[r][c] !== undefined) c++;      // 跳过被上方 rowspan 占走的位置
        var cell = cells[i];
        var txt = cellText(cell);
        var rs = cell.rowSpan || 1, cs = cell.colSpan || 1;
        for (var dr = 0; dr < rs; dr++) {
          if (!map[r + dr]) map[r + dr] = [];
          for (var dc = 0; dc < cs; dc++) map[r + dr][c + dc] = txt;
        }
        c += cs;
      }
    }
    // undefined 补空串，行宽补齐
    var w = 0;
    map.forEach(function (row) { if (row && row.length > w) w = row.length; });
    if (!w) return null;
    return map.map(function (row) {
      var out = [];
      for (var i = 0; i < w; i++) out.push(row && row[i] !== undefined ? row[i] : '');
      return out;
    });
  }

  /** 纯文本 → 矩阵：优先制表符，其次 2+ 连续空格；都没有则每行一列 */
  function matrixFromText(text) {
    var lines = s(text).replace(/\r\n?/g, '\n').split('\n')
      .filter(function (l) { return s(l); });
    if (!lines.length) return null;
    var useTab = lines.some(function (l) { return l.indexOf('\t') >= 0; });
    var useGap = lines.some(function (l) { return /[ \u3000]{2,}/.test(l); });
    var sep = useTab ? '\t' : (useGap ? /[ \u3000]{2,}|\t/ : null);
    if (!sep) return lines.map(function (l) { return [s(l)]; });
    return lines.map(function (l) {
      return l.split(sep).map(function (c) { return s(c); });
    });
  }

  /**
   * 解析粘贴内容（app.js 的粘贴导入入口）。
   * @param html  剪贴板 text/html（可能为空）
   * @param text  剪贴板 text/plain 或用户手敲的文本
   * @return {courses, warnings}，与 parseICS/parseExcel 同构
   */
  function parsePasted(html, text) {
    var warnings = [];
    var t = s(text);

    // ① JSON 直通道：{courses:[...]} 或 [...]
    if (/^[[{]/.test(t)) {
      try {
        var data = JSON.parse(t);
        var list = Array.isArray(data) ? data : (data && data.courses);
        if (Array.isArray(list) && list.length) {
          var courses = [];
          list.forEach(function (c) {
            if (!c || !s(c.name)) return;
            var day = typeof c.day === 'number' ? c.day : dayFromText(c.day);
            if (!day || day < 1 || day > 7) return;
            var st = Math.max(1, Math.min(12, +c.start || 1));
            courses.push({
              name: cleanName(c.name) || s(c.name),
              teacher: s(c.teacher),
              room: s(c.room),
              day: day,
              start: st,
              end: Math.max(st, Math.min(12, +c.end || st)),
              weekStart: Math.max(1, +c.weekStart || 1),
              weekEnd: Math.min(30, Math.max(1, +c.weekEnd || 20)),
              weekType: ['odd', 'even'].indexOf(c.weekType) >= 0 ? c.weekType : 'all',
              weeksOff: (Object.prototype.toString.call(c.weeksOff) === '[object Array]' && c.weeksOff.length)
                ? c.weeksOff.map(Number) : null
            });
          });
          if (courses.length) {
            // 本应用同步码/备份文件（{app:'kbc', settings:{...}}）
            // → 学期起始日作为 inferredStart 自动设定；
            //   完整设置（校名/节数/作息）作为 backupSettings 随导入确认一并恢复
            var semStart = (data && data.settings && data.settings.semesterStart) || null;
            return {
              courses: courses,
              warnings: warnings,
              inferredStart: (data && data.app === 'kbc' && semStart) ? semStart : null,
              backupSettings: (data && data.app === 'kbc') ? (data.settings || null) : null
            };
          }
          warnings.push('JSON 里没有可识别的课程字段（至少需要 name / day / start / end）');
        }
      } catch (e) { /* 不是合法 JSON → 继续按表格解析 */ }
    }

    // ② 富文本表格 ③ 纯文本
    var matrix = (html && /<table/i.test(html)) ? matrixFromHTML(html) : null;
    if (!matrix) matrix = matrixFromText(text);
    if (!matrix || !matrix.length) {
      warnings.push('没有可解析的表格内容');
      return { courses: [], warnings: warnings };
    }
    matrix = padMatrix(matrix);
    var res = tryParseSheet(matrix, warnings, '粘贴的课表');
    if (!res) {
      warnings.push('没认出"周一~周日"的表格结构：请在教务系统课表页框选整个课表表格后复制，或改用文件导入');
      return { courses: [], warnings: warnings };
    }
    return { courses: res.courses, warnings: warnings, detectedPeriods: res.detected || null };
  }

  /* ------------------------------------------------------------
   * 5. 导出接口
   * ---------------------------------------------------------- */
  root.ScheduleParsers = {
    config: config,
    parseICS: parseICS,
    parseExcel: parseExcel,
    parsePasted: parsePasted,
    matrixFromHTML: matrixFromHTML   // 调试/高级用途：富文本表格 → 矩阵
  };

})(typeof window !== 'undefined' ? window : globalThis);
