/* ============================================================
 * liquid-core.js —— liquid-glass 光学引擎 · 原生 JS 适配层
 * ------------------------------------------------------------
 * 移植自 @samasante/liquid-glass (MIT © Sam Asante)
 *   https://github.com/samasante/liquid-glass
 * 移植内容（去除 React 依赖）：
 *   1. createLensMapGenerator(size)  ← src/displacement.ts
 *      圆角矩形 SDF → 位移贴图：R=X位移、G=Y位移（0.5 为中性）、
 *      B=高光掩码（128 无、255 全亮），象限镜像加速。
 *      含球冠 dome（"液态"中部放大）、边缘弯折带 bend（液面 lip）、
 *      定向 sheen + 全向 glow 高光编码。
 *   2. 滤镜链构建                     ← src/Glass.tsx LensFilter
 *      feImage 贴图 → frost 模糊 → 3×feDisplacementMap R/G/B 分离
 *      （对称分布：R 外扩 / G 基准 / B 内收，只出彩边不整体漂移）
 *      → feComposite 算术合成 → B 通道提亮为镜面高光。
 *   3. GlassFX 面板管理：把上述滤镜以 backdrop-filter: url(#id)
 *      挂到任意 DOM 上 —— 折射的是"面板背后的实时内容"（我们的
 *      WebGL 背景 + 网格），面板文字永远在清晰层（原库
 *      "children are the crisp layer" 原则）。
 *
 * 兼容性：backdrop-filter: url(#svg) 为 Chromium 特性；
 * Safari/Firefox 由 CSS 材质规则兜底（frost+tint+色边），与原库
 * bare-wrap 模式的降级行为一致。
 * ============================================================ */
(function (root) {
  'use strict';

  /* ------------------------------------------------------------
   * 0. 常量（与原库保持一致的色散/编码参数）
   * ---------------------------------------------------------- */
  var DISPERSION_SPREAD = 0.22;   // R/B 两通的位移差比例（原库同值）
  var ERF_K = Math.sqrt(Math.PI); // erf(x) ≈ tanh(√π·x) 边缘羽化近似

  function erf(x) { return Math.tanh(ERF_K * x); }

  /** 球冠梯度均值：∫₀ᴴ x/√(R²−x²) dx = R − √(R²−H²)，闭式解归一化到 0.5 */
  function domeGradientMean(radius, halfExtent) {
    return halfExtent > 0
      ? (radius - Math.sqrt(radius * radius - halfExtent * halfExtent)) / halfExtent
      : 0;
  }

  /** 球冠常数：由弦半宽 a 与冠高 h 求 R = (a²+h²)/2h */
  function computeDomeConstants(capDepth, halfW, halfH) {
    var cap = Math.max(0.01, Math.min(capDepth, Math.min(halfW, halfH) - 1));
    var Rx = (halfW * halfW + cap * cap) / (2 * cap);
    var Ry = (halfH * halfH + cap * cap) / (2 * cap);
    var meanX = domeGradientMean(Rx, halfW);
    var meanY = domeGradientMean(Ry, halfH);
    return {
      Rx: Rx, Ry: Ry,
      scaleX: meanX > 0 ? 0.5 / meanX : 1,
      scaleY: meanY > 0 ? 0.5 / meanY : 1
    };
  }

  /* 8-bit 编码：位移以 0.5(128) 为中性；高光 0→128、1→255 */
  function encodeAxis(signed) { return ((0.5 + signed) * 255 + 0.5) | 0; }
  function encodeSpec(spec) { return (127 * spec + 128 + 0.5) | 0; }

  /* ------------------------------------------------------------
   * 1. SDF 位移贴图生成器（象限镜像快速路径）
   *    shape: { w, h, radius, depth, curvature, bend, bendWidth,
   *             splay, softEdge, sheen, sheenWidth, sheenFalloff,
   *             sheenAngle, glow, glowSpread, glowFalloff }
   *    返回 PNG dataURL。
   * ---------------------------------------------------------- */
  function generateLensMap(size, shape) {
    var canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    var ctx = canvas.getContext('2d');
    var image = ctx.createImageData(size, size);
    var data = image.data;

    var halfW = shape.w / 2;
    var halfH = shape.h / 2;
    var borderRadius = shape.radius || 0;
    var depth = shape.depth != null ? shape.depth : 0.65;
    var curvature = shape.curvature || 0;
    var bend = shape.bend || 0;
    var bendWidth = shape.bendWidth != null ? shape.bendWidth : 0.16;
    var splay = shape.splay || 0;
    var softEdge = shape.softEdge !== false;
    var sheen = shape.sheen || 0;
    var sheenWidth = shape.sheenWidth != null ? shape.sheenWidth : 3;
    var sheenFalloff = shape.sheenFalloff || 1.5;
    var sheenAngle = shape.sheenAngle != null ? shape.sheenAngle : 45;
    var glow = shape.glow || 0;
    var glowSpread = shape.glowSpread != null ? shape.glowSpread : 1;
    var glowFalloff = shape.glowFalloff || 0.5;

    var half = size >> 1;
    var radius = Math.min(borderRadius, Math.min(halfW, halfH));
    var minHalf = Math.min(halfW, halfH);
    /* depth：折射从边缘向内延伸的比例（自动随尺寸缩放），并门控 dome */
    var depthPx = Math.min(depth * minHalf, minHalf - 1);
    var innerHalfW = Math.max(0, halfW - depthPx);
    var innerHalfH = Math.max(0, halfH - depthPx);
    var innerRadius = Math.max(0, Math.min(borderRadius, Math.min(innerHalfW, innerHalfH)));
    /* erf 羽化宽度约等于 depthPx */
    var falloff = depthPx > 0 ? Math.SQRT1_2 / depthPx : 1e6;
    var hasSpecular = glow > 0 || sheen > 0;
    var angle = (sheenAngle * Math.PI) / 180;
    var cosA = Math.cos(angle);
    var sinA = Math.sin(angle);
    var edgeInv = sheenWidth > 0 ? 1 / sheenWidth : 0;
    var glowReachInv = 1 / Math.max(2, glowSpread * minHalf);
    var stepX = (2 * halfW) / size;
    var stepY = (2 * halfH) / size;
    var invW = 1 / halfW;
    var invH = 1 / halfH;
    var hasDome = curvature > 0;
    var domeCap = curvature * minHalf;
    var hasSplay = splay > 0;
    var hasEdgeRefract = bend > 0;
    var erInv = 1 / Math.max(2, bendWidth * minHalf);
    var splayHalf = 0.5 * minHalf;
    var splayInv = splayHalf > 0 ? 1 / splayHalf : 0;
    var sheenNorm = Math.SQRT1_2;

    /* 圆角弧距离：外层 SDF 与软边羽化共用 */
    function cornerDistance(ox, oy) {
      return ox > 0 || oy > 0 ? Math.sqrt(ox * ox + oy * oy) : 0;
    }

    /* 球冠 dome 常数 + 每列 LUT（x/√(R²−x²)，均值归一化 0.5） */
    var dome = hasDome ? computeDomeConstants(domeCap, halfW, halfH) : null;
    var domeLut = null;
    if (hasDome) {
      domeLut = new Float32Array(half);
      var r2 = dome.Rx * dome.Rx;
      var rMax = dome.Rx * (1 - 1e-3);
      for (var c0 = 0; c0 < half; c0++) {
        var px0 = -((c0 + 0.5) * stepX - halfW);
        var clamped = px0 < rMax ? px0 : rMax;
        domeLut[c0] = (clamped / Math.sqrt(r2 - clamped * clamped)) * dome.scaleX;
      }
    }

    /* 只算左上象限，其余三个象限镜像写入（位移符号翻转） */
    for (var row = 0; row < half; row++) {
      var mirrorRow = size - 1 - row;
      var py = -((row + 0.5) * stepY - halfH);
      var edgeY = py - halfH + radius;
      var innerEdgeY = softEdge ? py - innerHalfH + innerRadius : 0;
      var dirYBase = hasDome
        ? (function (d) {
            var inside = Math.min(py, d.Ry * (1 - 1e-3));
            return (inside / Math.sqrt(d.Ry * d.Ry - inside * inside)) * d.scaleY;
          })(dome)
        : (py * invH > 1 ? 1 : py * invH);
      var normY = py * invH > 1 ? 1 : py * invH;
      var splayY = hasSplay ? Math.max(0, 1 - (halfH - py) * splayInv) : 0;
      var rowBase = row * size;
      var mirrorRowBase = mirrorRow * size;

      for (var col = 0; col < half; col++) {
        var mirrorCol = size - 1 - col;
        var px = -((col + 0.5) * stepX - halfW);
        var edgeX = px - halfW + radius;
        /* 圆角矩形 SDF（负值在形状内部） */
        var sdf =
          cornerDistance(edgeX > 0 ? edgeX : 0, edgeY > 0 ? edgeY : 0) +
          (edgeX > edgeY ? (edgeX > 0 ? 0 : edgeX) : edgeY > 0 ? 0 : edgeY) -
          radius;

        var i00 = (rowBase + col) * 4;            /* 左上（基准） */
        var i01 = (rowBase + mirrorCol) * 4;      /* 右上（X 镜像） */
        var i10 = (mirrorRowBase + col) * 4;      /* 左下（Y 镜像） */
        var i11 = (mirrorRowBase + mirrorCol) * 4;/* 右下（XY 镜像） */

        if (sdf >= 0) {                            /* 形状外：中性灰、无位移无高光 */
          data[i00] = data[i01] = data[i10] = data[i11] = 128;
          data[i00 + 1] = data[i01 + 1] = data[i10 + 1] = data[i11 + 1] = 128;
          data[i00 + 2] = data[i01 + 2] = data[i10 + 2] = data[i11 + 2] = 128;
          data[i00 + 3] = data[i01 + 3] = data[i10 + 3] = data[i11 + 3] = 255;
          continue;
        }

        /* 基础位移方向：dome 梯度（液态中部放大）或线性归一化 */
        var dirX = hasDome ? domeLut[col] : (px * invW > 1 ? 1 : px * invW);
        var dirY = dirYBase;
        if (hasSplay) {                            /* 角部外扬（保持长度） */
          var yAtt = splayY * splay;
          var xAtt = Math.max(0, 1 - (halfW - px) * splayInv) * splay;
          if (yAtt > 0.001 || xAtt > 0.001) {
            var prevX = dirX, prevY = dirY;
            dirX = prevX * (1 - yAtt);
            dirY = prevY * (1 - xAtt);
            var prevLen = Math.sqrt(prevX * prevX + prevY * prevY);
            var nextLen = Math.sqrt(dirX * dirX + dirY * dirY);
            if (nextLen > 0.001) {
              var restore = prevLen / nextLen;
              dirX *= restore; dirY *= restore;
            }
          }
        }

        /* 软边羽化：向内 depthPx 的 erf 过渡 */
        var edgeOpacity = 1;
        if (softEdge) {
          var ix = px - innerHalfW + innerRadius;
          var innerSdf =
            cornerDistance(ix > 0 ? ix : 0, innerEdgeY > 0 ? innerEdgeY : 0) +
            (ix > innerEdgeY ? (ix > 0 ? 0 : ix) : innerEdgeY > 0 ? 0 : innerEdgeY) -
            innerRadius;
          edgeOpacity = 0.5 * (1 + erf(innerSdf * falloff));
        }

        var dx = 0.5 * dirX * edgeOpacity;
        var dy = 0.5 * dirY * edgeOpacity;
        if (hasEdgeRefract) {
          /* 液面 lip：贴着外缘内侧的软弯折带，s²(1−s) 归一化后峰值在带内 1/3 处，
             两端归零——背景"包进"唇内而不是压在裁剪线上 */
          var s = sdf < 0 ? Math.max(0, 1 + sdf * erInv) : 0;
          if (s > 0) {
            var len = Math.sqrt(dirX * dirX + dirY * dirY);
            if (len > 1e-4) {
              var m = 6.75 * s * s * (1 - s);
              var a = (0.5 * bend * m * edgeOpacity) / len;
              dx += dirX * a;
              dy += dirY * a;
            }
          }
        }

        /* 高光：主对角线 specMain + 副对角线 specCross（镜像时轴翻转） */
        var specMain = 0, specCross = 0;
        if (hasSpecular) {
          var normX = px * invW > 1 ? 1 : px * invW;
          var axisMain = Math.min(1, Math.abs(normX * cosA + normY * sinA) * sheenNorm);
          var axisCross = Math.min(1, Math.abs(normX * cosA - normY * sinA) * sheenNorm);
          if (sheen > 0) {
            /* 亮边带：0.16 底值保证整圈都有微弱边缘光 */
            var band = sdf < 0 ? Math.max(0, 1 + sdf * edgeInv) : 0;
            var b = sheen * Math.pow(band, sheenFalloff);
            specMain += b * (0.16 + 0.84 * Math.pow(axisMain, 1.6));
            specCross += b * (0.16 + 0.84 * Math.pow(axisCross, 1.6));
          }
          if (glow > 0) {
            /* 全向内辉光：smoothstep 双端零斜率，深达 glowSpread */
            var reach = sdf < 0 ? Math.min(1, -sdf * glowReachInv) : 1;
            var t = 1 - reach;
            var g = glow * Math.pow(t * t * (3 - 2 * t), glowFalloff) * edgeOpacity;
            specMain += g * (0.6 + 0.4 * axisMain);
            specCross += g * (0.6 + 0.4 * axisCross);
          }
          if (specMain > 1) specMain = 1; else if (specMain < -1) specMain = -1;
          if (specCross > 1) specCross = 1; else if (specCross < -1) specCross = -1;
        }

        var rPos = encodeAxis(dx), rNeg = encodeAxis(-dx);
        var gPos = encodeAxis(dy), gNeg = encodeAxis(-dy);
        var bMain = encodeSpec(specMain), bCross = encodeSpec(specCross);

        data[i00] = rPos;      data[i00 + 1] = gPos;      data[i00 + 2] = bMain;      data[i00 + 3] = 255;
        data[i01] = rNeg;      data[i01 + 1] = gPos;      data[i01 + 2] = bCross;     data[i01 + 3] = 255;
        data[i10] = rPos;      data[i10 + 1] = gNeg;      data[i10 + 2] = bCross;     data[i10 + 3] = 255;
        data[i11] = rNeg;      data[i11 + 1] = gNeg;      data[i11 + 2] = bMain;      data[i11 + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
    return canvas.toDataURL();
  }

  /* ------------------------------------------------------------
   * 2. SVG 滤镜链（移植自 Glass.tsx LensFilter）
   *    贴图 → frost 模糊 → 三通道色散位移 → 高光提升
   * ---------------------------------------------------------- */
  var defsEl = null;     // 共享 <svg> 定义容器（懒创建，藏于页面角落）
  var seq = 0;           // 滤镜 id 序号

  function ensureDefs() {
    if (defsEl && document.documentElement.contains(defsEl)) return defsEl;
    defsEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    defsEl.setAttribute('width', '0');
    defsEl.setAttribute('height', '0');
    defsEl.style.position = 'absolute';
    defsEl.setAttribute('aria-hidden', 'true');
    document.body.appendChild(defsEl);
    return defsEl;
  }

  function el(name, attrs) {
    var n = document.createElementNS('http://www.w3.org/2000/svg', name);
    for (var k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }

  /**
   * 构建一块玻璃的 <filter>：
   *   o: { w, h, radius, frost, strength, dispersion, depth, curvature,
   *        bend, bendWidth, specular, sheen, glow, saturate }
   * 返回 filter 元素（已插入 defs）。
   */
  function buildFilter(o) {
    var id = 'lgfx-' + (++seq);
    /* 滤镜区域必须与元素框 1:1（原库同款 x=0/y=0/100%），
       否则 feImage 贴图会被拉伸错位、折射场对不上 */
    var f = el('filter', {
      id: id,
      x: '0%', y: '0%', width: '100%', height: '100%',
      'color-interpolation-filters': 'sRGB'
    });

    /* 位移贴图（SDF → dataURL）。贴图分辨率按镜片大小分档控开销 */
    var mapSize = Math.max(o.w, o.h) > 260 ? 512 : 256;
    var mapHref = generateLensMap(mapSize, {
      w: o.w, h: o.h, radius: o.radius,
      depth: o.depth, curvature: o.curvature,
      bend: o.bend, bendWidth: o.bendWidth,
      sheen: o.sheen, glow: o.glow, sheenAngle: 45
    });

    /* 贴图：中性灰底 + PNG 贴图（preserveAspectRatio 拉伸铺满） */
    f.appendChild(el('feFlood', { 'flood-color': 'rgb(128,128,128)', 'flood-opacity': '1', result: 'mapBg' }));
    f.appendChild(el('feImage', { href: mapHref, preserveAspectRatio: 'none', result: 'map' }));
    f.appendChild(el('feComposite', { in: 'map', in2: 'mapBg', operator: 'over', result: 'map' }));

    /* 位移总量：strength 按镜片对角均值折算成 feDisplacementMap 的 px 尺度 */
    var src = 'SourceGraphic';
    if (o.frost > 0) {
      f.appendChild(el('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: o.frost, result: 'blurred' }));
      src = 'blurred';
    }
    var dispScale = o.strength * Math.sqrt((o.w * o.w + o.h * o.h) / 2);

    if (o.dispersion > 0) {
      /* 色散：三通对称分布 —— R 外扩(+½spread)、G 基准、B 内收(−½spread)。
         平均位移等于基准，因此加 dispersion 只在边缘镶彩边、不整体缩放漂移 */
      var sR = dispScale * (1 + DISPERSION_SPREAD * 0.5 * o.dispersion);
      var sB = dispScale * (1 - DISPERSION_SPREAD * 0.5 * o.dispersion);
      var d1 = el('feDisplacementMap', { in: src, in2: 'map', scale: sR, xChannelSelector: 'R', yChannelSelector: 'G', result: 'dR' });
      var c1 = el('feColorMatrix', { in: 'dR', type: 'matrix', values: '1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0', result: 'refractR' });
      var d2 = el('feDisplacementMap', { in: src, in2: 'map', scale: dispScale, xChannelSelector: 'R', yChannelSelector: 'G', result: 'dG' });
      var c2 = el('feColorMatrix', { in: 'dG', type: 'matrix', values: '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0', result: 'refractG' });
      var d3 = el('feDisplacementMap', { in: src, in2: 'map', scale: sB, xChannelSelector: 'R', yChannelSelector: 'G', result: 'dB' });
      var c3 = el('feColorMatrix', { in: 'dB', type: 'matrix', values: '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0', result: 'refractB' });
      var m1 = el('feComposite', { in: 'refractR', in2: 'refractG', operator: 'arithmetic', k1: '0', k2: '1', k3: '1', k4: '0', result: 'refractRG' });
      var m2 = el('feComposite', { in: 'refractRG', in2: 'refractB', operator: 'arithmetic', k1: '0', k2: '1', k3: '1', k4: '0', result: 'lensOut' });
      [d1, c1, d2, c2, d3, c3, m1, m2].forEach(function (n) { f.appendChild(n); });
    } else {
      f.appendChild(el('feDisplacementMap', { in: src, in2: 'map', scale: dispScale, xChannelSelector: 'R', yChannelSelector: 'G', result: 'lensOut' }));
    }

    if (o.specular > 0) {
      /* 高光：把贴图 B 通道（128=中性）抬亮为白色掩码，再按 spec 增益叠上 */
      f.appendChild(el('feColorMatrix', {
        in: 'map', type: 'matrix',
        values: '0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 1 0 ' + (-128 / 255),
        result: 'sheenMask'
      }));
      f.appendChild(el('feComposite', { in: 'sheenMask', in2: 'lensOut', operator: 'arithmetic', k1: '0', k2: o.specular, k3: '1', k4: '0', result: 'lensOut2' }));
    }

    ensureDefs().appendChild(f);
    return f;
  }

  /* ------------------------------------------------------------
   * 3. 面板挂载管理：attach / detach / refresh
   * ---------------------------------------------------------- */
  var attached = new Map();      // el → state
  var ro = null;                 // 尺寸变化观察器（防抖重建滤镜）
  var resizeTimer = null;

  function ensureRO() {
    if (ro || !root.ResizeObserver) return;
    ro = new ResizeObserver(function (entries) {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        entries.forEach(function (en) {
          var st = attached.get(en.target);
          if (st) attach(en.target, st.optics);   // 尺寸变了 → 重建贴图与滤镜
        });
      }, 160);
    });
  }

  /** 元素实际尺寸与圆角 */
  function measure(el) {
    var r = el.getBoundingClientRect();
    var cs = getComputedStyle(el);
    var radius = parseFloat(cs.borderTopLeftRadius) || 0;
    return { w: Math.max(8, Math.round(r.width)), h: Math.max(8, Math.round(r.height)), radius: radius };
  }

  /** 清理已脱离文档的元素引用（renderAll 会重建卡片节点） */
  function prune() {
    Array.from(attached.keys()).forEach(function (el) {
      if (!document.documentElement.contains(el)) {
        if (ro) ro.unobserve(el);
        attached.delete(el);
      }
    });
  }

  /** 当前浏览器是否支持 backdrop-filter 引用 SVG 滤镜（Chromium 特性） */
  function supported() {
    try {
      return CSS.supports('backdrop-filter', 'url(#x) blur(2px)');
    } catch (e) { return false; }
  }

  /**
   * 给元素挂上 SDF 液态玻璃折射（backdrop 层，文字保持在清晰层之上）。
   * optics: { strength, dispersion, depth, curvature, bend, bendWidth,
   *           frost, specular, sheen, glow, saturate }
   */
  function attach(el, optics) {
    if (!supported() || !el) return false;
    var m = measure(el);
    if (m.w < 24 || m.h < 16) return false;

    var st = attached.get(el);
    /* 快路径：尺寸与光学参数都没变 → 不重建 */
    if (st && st.w === m.w && st.h === m.h &&
        JSON.stringify(st.optics) === JSON.stringify(optics)) return true;
    if (st && st.filterEl) st.filterEl.remove();      // 重建：先移除旧滤镜

    var filterEl = buildFilter({
      w: m.w, h: m.h, radius: m.radius,
      frost: optics.frost || 0,
      strength: optics.strength != null ? optics.strength : 0.06,
      dispersion: optics.dispersion != null ? optics.dispersion : 0.5,
      depth: optics.depth != null ? optics.depth : 0.65,
      curvature: optics.curvature != null ? optics.curvature : 0.5,
      bend: optics.bend != null ? optics.bend : 0.3,
      bendWidth: optics.bendWidth != null ? optics.bendWidth : 0.16,
      specular: optics.specular != null ? optics.specular : 0.8,
      sheen: optics.sheen != null ? optics.sheen : 0.35,
      glow: optics.glow != null ? optics.glow : 0.15
    });

    /* backdrop 链：SDF 位移滤镜（内含 frost 模糊）+ 饱和度。
       内联样式覆盖 CSS 材质规则；不支持时回退到 CSS 规则 */
    el.style.backdropFilter = 'url(#' + filterEl.id + ') saturate(' + (optics.saturate || 1.5) + ')';
    el.style.webkitBackdropFilter = el.style.backdropFilter;
    el.dataset.lgfx = '1';

    if (!st) {
      attached.set(el, { optics: optics, filterEl: filterEl, w: m.w, h: m.h });
      ensureRO();
      if (ro) ro.observe(el);
    } else {
      st.optics = optics;
      st.filterEl = filterEl;
      st.w = m.w; st.h = m.h;
    }
    return true;
  }

  /** 卸载元素上的玻璃滤镜（回到 CSS 材质规则） */
  function detach(el) {
    var st = attached.get(el);
    if (!st) return;
    if (st.filterEl) st.filterEl.remove();
    el.style.backdropFilter = '';
    el.style.webkitBackdropFilter = '';
    delete el.dataset.lgfx;
    if (ro) ro.unobserve(el);
    attached.delete(el);
  }

  /** 全部卸载（兼容 CSS 模式切换时调用） */
  function detachAll() {
    Array.from(attached.keys()).forEach(detach);
  }

  /** 当前挂载数 */
  function count() { return attached.size; }

  root.GlassFX = {
    attach: attach,
    detach: detach,
    detachAll: detachAll,
    prune: prune,
    supported: supported,
    count: count
  };

})(typeof window !== 'undefined' ? window : globalThis);
