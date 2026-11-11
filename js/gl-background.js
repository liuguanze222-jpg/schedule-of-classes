/* ============================================================
 * WebGL 玻璃背景引擎（gl-background.js）· 静态渲染版
 * ------------------------------------------------------------
 * 满血模式下的全屏底层背景（canvas #glCanvas，fixed，z-index:-2）：
 *   · 柔和低饱和渐变 + 固定的流体色斑光晕（单帧渲染，不动画）
 *   · 左上软主光；壁纸纹理按原样静态绘制（无流动扭曲）
 *   · 胶片颗粒 + 暗角；浅色/深色两套调色
 *
 * 背景是"固定的"：只在初始化 / 切换主题 / 更换壁纸 / 窗口缩放时
 * 重新渲染一帧，不做任何逐帧动画 —— 上传的图片保持静止。
 * 玻璃元件的水感来自各面板的 SDF 折射滤镜（liquid-core.js），
 * 与背景是否动画无关。
 *
 * 对外接口（window.LiquidBG）：
 *   LiquidBG.supported()            —— 是否支持 WebGL
 *   LiquidBG.start(opts)            —— 启动，返回控制器
 *   ctl.setTheme(dark)              —— 切换浅色/深色调色（重渲染一帧）
 *   ctl.setWallpaper(dataURL|null)  —— 载入/清除壁纸（重渲染一帧）
 *   ctl.setMouse(nx, ny)            —— 保留接口（静态模式下无动画）
 *   ctl.fps()                       —— 兼容旧探针接口（静态渲染恒 60）
 *   ctl.stop()                      —— 停止（移除监听；不销毁上下文）
 * ============================================================ */
(function (root) {
  'use strict';

  /* ---------- 着色器源码 ---------- */
  var VERT =
    'attribute vec2 a_pos;' +
    'varying vec2 v_uv;' +
    'void main(){' +
    '  v_uv = a_pos * 0.5 + 0.5;' +
    '  gl_Position = vec4(a_pos, 0.0, 1.0);' +
    '}';

  var FRAG =
    'precision mediump float;' +
    'uniform vec2 u_res;' +
    'uniform vec2 u_mouse;' +
    'uniform float u_dark;' +
    'uniform vec3 u_c1;' +
    'uniform vec3 u_c2;' +
    'uniform vec3 u_c3;' +
    'uniform sampler2D u_tex;' +
    'uniform float u_hasTex;' +
    'uniform float u_texAspect;' +
    'uniform float u_time;' +
    'uniform float u_par;' +
    'varying vec2 v_uv;' +
    'float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }' +
    'float blob(vec2 p, vec2 c, float r){ float d = length(p - c); return 1.0 - smoothstep(0.0, r, d); }' +
    'void main(){' +
    '  vec2 p = gl_FragCoord.xy / u_res;' +
    '  vec2 asp = vec2(u_res.x / max(u_res.y, 1.0), 1.0);' +
    /* 3D 深度：u_par ∈ [0,1]（0=关）。三层视差 = 同一姿态量按不同深度缩放，
       光晕还各自绕极慢轨道漂移（u_time 驱动，周期 20~34s，几乎不可察觉但背景是活的） */
    '  vec2 tilt = (u_mouse - 0.5) * 2.0;' +                      /* -1..1 姿态/指针 */
    '  vec3 drift = vec3(0.0);' +
    '  vec2 m1 = vec2(0.26, 0.78) * asp;' +
    '  vec2 m2 = vec2(0.82, 0.24) * asp;' +
    '  vec2 m3 = vec2(0.50, 0.52) * asp;' +
    '  if (u_par > 0.001) {' +
    '    float t = u_time;' +
    '    m1 += vec2(sin(t*0.19), cos(t*0.23)) * 0.055 * asp - tilt * 0.030 * asp;' +  /* 近层：位移大 */
    '    m2 += vec2(cos(t*0.16), sin(t*0.21)) * 0.045 * asp - tilt * 0.018 * asp;' +
    '    m3 += vec2(sin(t*0.12+1.7), cos(t*0.15+0.6)) * 0.035 * asp - tilt * 0.008 * asp;' + /* 远层：位移小 */
    '  }' +
    '  vec2 pp = p * asp;' +
    '  float b1 = blob(pp, m1, 0.62);' +
    '  float b2 = blob(pp, m2, 0.55);' +
    '  float b3 = blob(pp, m3, 0.66);' +
    '  vec3 col = mix(u_c1, u_c2, p.y);' +
    '  col = mix(col, u_c3, b1 * 0.6);' +
    '  col = mix(col, u_c2, b2 * 0.5);' +
    '  col = mix(col, u_c1, b3 * 0.55);' +
    /* 左上软主光源（固定）+ 指针/姿态位置的环境光 */
    '  float key = 1.0 - smoothstep(0.0, 1.25, length(pp - vec2(0.05, 0.95) * asp));' +
    '  col += (0.05 + 0.06 * key) * mix(0.55, 1.0, key);' +
    '  vec2 mp = u_mouse * asp;' +
    '  float mg = 1.0 - smoothstep(0.0, 0.5, length(pp - mp));' +
    '  vec3 glow = mix(vec3(0.055, 0.06, 0.075), vec3(0.045, 0.055, 0.10), step(0.5, u_dark));' +
    '  col += mg * glow;' +
    /* 壁纸纹理：等比 cover 适配（居中裁剪，绝不拉伸变形） */
    '  if (u_hasTex > 0.5) {' +
    '    float ca = u_res.x / max(u_res.y, 1.0);' +
    '    float ta = max(u_texAspect, 0.0001);' +
    '    vec2 tuv = v_uv;' +
    '    if (ta > ca) {' +
    '      tuv.x = (v_uv.x - 0.5) * (ca / ta) + 0.5;' +
    '    } else {' +
    '      tuv.y = (v_uv.y - 0.5) * (ta / ca) + 0.5;' +
    '    }' +
    '    vec3 tex = texture2D(u_tex, vec2(tuv.x, 1.0 - tuv.y)).rgb;' +
    '    col = mix(col, tex * (0.92 + 0.08 * key), 0.9);' +
    '  }' +
    /* 静态胶片颗粒 + 暗角 */
    '  col += (hash(p * u_res) - 0.5) * 0.022;' +
    '  float vg = 1.0 - smoothstep(0.4, 1.3, length(p - vec2(0.5)));' +
    '  col *= mix(0.93, 1.0, vg);' +
    '  gl_FragColor = vec4(col, 1.0);' +
    '}';

  /* 浅色 / 深色两套低饱和调色 */
  var PALETTES = {
    light: {
      c1: [0.937, 0.949, 0.973],   /* #eff2f8 */
      c2: [0.867, 0.902, 0.980],   /* #dde6fa */
      c3: [1.000, 0.914, 0.941]    /* #ffe9f0 */
    },
    dark: {
      c1: [0.071, 0.086, 0.122],   /* #12161f */
      c2: [0.106, 0.137, 0.251],   /* #1b2340 */
      c3: [0.122, 0.169, 0.227]    /* #1f2b3a */
    }
  };

  /* ---------- 3D 立方体着色器（移植自 Cubes-Live-Wallpaper 的视觉） ----------
   * 立方体顶点：位置 + 法线；透视投影；玻璃质感 = 半透明 + 按法线的菲涅尔边缘光 */
  var CUBE_VERT =
    'attribute vec3 a_pos;' +
    'attribute vec3 a_nrm;' +
    'uniform mat4 u_mvp;' +
    'uniform mat3 u_nrmMat;' +
    'varying vec3 v_nrm;' +
    'varying float v_depth;' +
    'void main(){' +
    '  vec4 wp = u_mvp * vec4(a_pos, 1.0);' +
    '  gl_Position = wp;' +
    '  v_nrm = normalize(u_nrmMat * a_nrm);' +
    '  v_depth = clamp(wp.z / wp.w, 0.0, 1.0);' +
    '}';

  var CUBE_FRAG =
    'precision mediump float;' +
    'uniform float u_dark;' +
    'uniform vec3 u_tint;' +
    'uniform vec3 u_camDir;' +
    'varying vec3 v_nrm;' +
    'varying float v_depth;' +
    'void main(){' +
    /* 玻璃立方体：朝向相机的面更透明，侧棱面更实（菲涅尔 edge glow） */
    '  float facing = clamp(dot(normalize(v_nrm), normalize(u_camDir)), 0.0, 1.0);' +
    '  float edge = pow(1.0 - facing, 1.6);' +
    '  float alpha = mix(0.30, 0.62, edge);' +
    '  vec3 base = mix(u_tint, u_tint * 1.35, edge);' +
    '  vec3 col = mix(base, base * 0.55, v_depth * 0.5);' +   /* 远处更暗 → 深度感 */
    '  if (u_dark > 0.5) col = mix(vec3(0.10, 0.13, 0.20), col * 1.6 + vec3(0.06, 0.09, 0.16), edge);' +
    '  gl_FragColor = vec4(col, alpha);' +
    '}';

  /* 单位立方体几何：24 顶点（每面独立法线）+ 36 索引 */
  function cubeGeometry() {
    var P = [
      [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],      // 前 z+
      [-1, -1, -1], [-1, 1, -1], [1, 1, -1], [1, -1, -1],  // 后 z-
      [-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1],      // 上 y+
      [-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1],  // 下 y-
      [1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1],      // 右 x+
      [-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]   // 左 x-
    ];
    var N = [
      [0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1],
      [0, 0, -1], [0, 0, -1], [0, 0, -1], [0, 0, -1],
      [0, 1, 0], [0, 1, 0], [0, 1, 0], [0, 1, 0],
      [0, -1, 0], [0, -1, 0], [0, -1, 0], [0, -1, 0],
      [1, 0, 0], [1, 0, 0], [1, 0, 0], [1, 0, 0],
      [-1, 0, 0], [-1, 0, 0], [-1, 0, 0], [-1, 0, 0]
    ];
    var I = [];
    for (var f = 0; f < 6; f++) {
      var b = f * 4;
      I.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
    var pos = [], nrm = [];
    for (var i = 0; i < 24; i++) {
      var s = 0.5;                                     // 半径 0.5 → 边长 1
      pos.push(P[i][0] * s, P[i][1] * s, P[i][2] * s);
      nrm.push(N[i][0], N[i][1], N[i][2]);
    }
    return { pos: new Float32Array(pos), nrm: new Float32Array(nrm), idx: new Uint16Array(I) };
  }

  /** 4x4 矩阵工具（列主序，与 WebGL 一致） */
  function mat4() { return new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]); }
  function mat4Mul(a, b) {
    var o = new Float32Array(16);
    for (var c = 0; c < 4; c++) for (var r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
    return o;
  }
  function persp(fovy, asp, near, far) {
    var f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    var m = new Float32Array(16);
    m[0] = f / asp; m[5] = f; m[10] = (far + near) * nf; m[11] = -1;
    m[14] = 2 * far * near * nf;
    return m;
  }
  function rotAxis(x, y, z, ang) {
    var len = Math.sqrt(x * x + y * y + z * z) || 1;
    x /= len; y /= len; z /= len;
    var c = Math.cos(ang), s = Math.sin(ang), t = 1 - c;
    return new Float32Array([
      t*x*x + c,   t*x*y + s*z, t*x*z - s*y, 0,
      t*x*y - s*z, t*y*y + c,   t*y*z + s*x, 0,
      t*x*z + s*y, t*y*z - s*x, t*z*z + c,   0,
      0, 0, 0, 1
    ]);
  }
  function transpose3(m4) {
    return new Float32Array([
      m4[0], m4[4], m4[8],
      m4[1], m4[5], m4[9],
      m4[2], m4[6], m4[10]
    ]);
  }

  function supported() {
    try {
      var c = document.createElement('canvas');
      return !!(c.getContext('webgl') || c.getContext('experimental-webgl'));
    } catch (e) { return false; }
  }

  /** 编译着色器（失败时抛出带日志的错误，由 start 统一捕获降级） */
  function makeShader(gl, type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error('shader compile failed: ' + (gl.getShaderInfoLog(sh) || '(无日志)'));
    }
    return sh;
  }

  function start(opts) {
    try {
      return startInner(opts);
    } catch (e) {
      /* 任何初始化失败都不允许打断主页面，交由上层自动降级 */
      if (window.console && console.warn) console.warn('[LiquidBG]', e.message);
      return null;
    }
  }

  function startInner(opts) {
    opts = opts || {};
    var canvas = document.getElementById('glCanvas');
    if (canvas && canvas.dataset.lost === '1') {
      /* 上下文已丢失的画布无法复用 → 直接换新节点 */
      var fresh = document.createElement('canvas');
      fresh.id = 'glCanvas';
      if (canvas.parentNode) canvas.parentNode.replaceChild(fresh, canvas);
      canvas = fresh;
    }
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.id = 'glCanvas';
      document.body.insertBefore(canvas, document.body.firstChild);
    }
    var gl = canvas.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'high-performance' }) ||
             canvas.getContext('experimental-webgl', { antialias: false, alpha: false });
    if (!gl || gl.isContextLost()) return null;

    /* ---------- 程序与缓冲 ---------- */
    var prog = gl.createProgram();
    gl.attachShader(prog, makeShader(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, makeShader(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
    gl.useProgram(prog);

    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW); // 全屏大三角
    var aPos = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    var u = {};
    ['u_res', 'u_mouse', 'u_dark', 'u_c1', 'u_c2', 'u_c3', 'u_hasTex', 'u_texAspect', 'u_time', 'u_par'].forEach(function (n) {
      u[n] = gl.getUniformLocation(prog, n);
    });
    gl.uniform1i(gl.getUniformLocation(prog, 'u_tex'), 0);
    gl.uniform1f(u.u_texAspect, 1.6);

    /* ---------- 状态 ---------- */
    var dark = !!opts.dark;
    var mouse = { x: 0.3, y: 0.62 };          // 柔和光斑/姿态源（指针或陀螺仪写入）
    var stopped = false;
    var parallax = !!opts.parallax;           // 3D 深度视差开关（静态壁纸保持 0）
    var rafId = 0;
    var t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    /** 动画循环：仅 3D 模式启用。高刷屏跟随（rAF 本身按显示器刷新率回调），
     *  并对姿态做 0.12 系数缓动，看起来"飘"而不抖。 */
    function loop() {
      if (stopped) return;
      rafId = root.requestAnimationFrame(loop);
      render();
    }
    function startLoop() {
      if (parallax && !rafId && !stopped) {
        rafId = root.requestAnimationFrame(loop);
        if (root.GL_hiRefresh) root.GL_hiRefresh();   // 通知壳层申请 120Hz
      }
    }
    function stopLoop() {
      if (rafId) { root.cancelAnimationFrame(rafId); rafId = 0; }
    }

    function resize() {
      /* 手机等触屏设备降低渲染分辨率上限（画面差异极小，帧率提升明显） */
      var coarse = root.matchMedia && root.matchMedia('(pointer: coarse)').matches;
      var cap = coarse ? 1.25 : 1.75;
      var dpr = Math.min(root.devicePixelRatio || 1, cap);
      var w = Math.max(1, Math.round(innerWidth * dpr));
      var h = Math.max(1, Math.round(innerHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w; canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
    }

    function applyPalette() {
      var p = dark ? PALETTES.dark : PALETTES.light;
      gl.uniform3fv(u.u_c1, p.c1);
      gl.uniform3fv(u.u_c2, p.c2);
      gl.uniform3fv(u.u_c3, p.c3);
      gl.uniform1f(u.u_dark, dark ? 1 : 0);
    }

    /** 渲染一帧（静态模式：仅状态变化/缩放时调用；3D 模式：rAF 每帧调用） */
    function render() {
      if (stopped || gl.isContextLost()) {
        if (gl.isContextLost()) canvas.dataset.lost = '1';
        return;
      }
      resize();
      var t = ((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0) / 1000;
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.useProgram(prog);
      /* 关键：立方体 pass 会改写 attribute 0 的顶点指针，
         每帧画背景前必须重新把 a_pos 指回大三角缓冲（否则第二帧起背景花屏） */
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
      gl.uniform2f(u.u_res, canvas.width, canvas.height);
      gl.uniform2f(u.u_mouse, mouse.x, mouse.y);
      gl.uniform1f(u.u_time, parallax ? t : 0);
      gl.uniform1f(u.u_par, parallax ? 1 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      /* 立方体已按用户要求移除：背景仅保留光晕的缓慢流动与姿态视差 */
    }

    /* ---------- 3D 立方体群（Cubes-Live-Wallpaper 移植） ---------- */
    var cubes = null;
    function initCubes() {
      try {
        var cp = gl.createProgram();
        gl.attachShader(cp, makeShader(gl, gl.VERTEX_SHADER, CUBE_VERT));
        gl.attachShader(cp, makeShader(gl, gl.FRAGMENT_SHADER, CUBE_FRAG));
        gl.linkProgram(cp);
        if (!gl.getProgramParameter(cp, gl.LINK_STATUS)) throw new Error('cube link failed');
        var g = cubeGeometry();
        var pb = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, pb);
        gl.bufferData(gl.ARRAY_BUFFER, g.pos, gl.STATIC_DRAW);
        var nb = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, nb);
        gl.bufferData(gl.ARRAY_BUFFER, g.nrm, gl.STATIC_DRAW);
        var ib = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, g.idx, gl.STATIC_DRAW);
        cubes = {
          prog: cp, posBuf: pb, nrmBuf: nb, idxBuf: ib, count: g.idx.length,
          aPos: gl.getAttribLocation(cp, 'a_pos'),
          aNrm: gl.getAttribLocation(cp, 'a_nrm'),
          uMvp: gl.getUniformLocation(cp, 'u_mvp'),
          uNrmMat: gl.getUniformLocation(cp, 'u_nrmMat'),
          uDark: gl.getUniformLocation(cp, 'u_dark'),
          uTint: gl.getUniformLocation(cp, 'u_tint'),
          uCamDir: gl.getUniformLocation(cp, 'u_camDir')
        };
        /* 实例参数：8 个立方体，随机初始位置/自转轴/速度（源自该项目的随机漂浮思路） */
        cubes.items = [];
        var rnd = [0.31, 0.73, 0.55, 0.9, 0.12, 0.66, 0.42, 0.81];
        for (var i = 0; i < 8; i++) {
          cubes.items.push({
            x: (rnd[i] - 0.5) * 7.0,
            y: (rnd[(i * 3 + 1) % 8] - 0.5) * 4.2,
            z: -2.0 - rnd[(i * 5 + 2) % 8] * 5.0,          // -2 ~ -7 深度（更近更明显）
            size: 0.7 + rnd[(i * 7 + 3) % 8] * 1.4,        // 0.7 ~ 2.1
            ax: rnd[(i + 3) % 8] - 0.5, ay: rnd[(i + 5) % 8] - 0.5, az: rnd[(i + 7) % 8] - 0.5,
            spd: 0.25 + rnd[(i + 2) % 8] * 0.4,            // 自转速度 rad/s
            orbR: 0.4 + rnd[(i + 4) % 8] * 0.7,            // 漂浮半径
            orbS: 0.08 + rnd[(i + 6) % 8] * 0.12,          // 漂浮角速度
            ph: rnd[i] * 6.28                              // 初相位
          });
        }
      } catch (e) {
        if (window.console && console.warn) console.warn('[LiquidBG] cubes:', e.message);
        cubes = null;
      }
    }
    initCubes();

    function drawCubes(t) {
      if (!cubes) return;
      var w = canvas.width, h = canvas.height;
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.useProgram(cubes.prog);
      var asp = w / Math.max(1, h);
      var proj = persp(60 * Math.PI / 180, asp, 0.5, 40);
      /* 姿态：mouse(0..1) → 相机绕原点小角度旋转（整个立方体群随手机真实转动） */
      var yaw = (mouse.x - 0.5) * 0.9;                   // ±0.45 rad
      var pitch = (mouse.y - 0.5) * 0.6;
      var view = rotAxis(0, 1, 0, -yaw);
      view = mat4Mul(rotAxis(1, 0, 0, -pitch), view);
      view[12] = 0; view[13] = 0; view[14] = 0;
      var camDir = new Float32Array([Math.sin(yaw), Math.sin(pitch), -Math.cos(yaw)]);
      gl.uniform1f(cubes.uDark, dark ? 1 : 0);
      gl.uniform3f(cubes.uCamDir, camDir[0], camDir[1], camDir[2]);
      var darkTints = [[0.35, 0.45, 0.75], [0.45, 0.38, 0.62], [0.30, 0.52, 0.60], [0.60, 0.42, 0.38]];
      var lightTints = [[0.62, 0.74, 1.0], [0.80, 0.70, 0.95], [0.60, 0.85, 0.88], [0.98, 0.78, 0.72]];
      gl.bindBuffer(gl.ARRAY_BUFFER, cubes.posBuf);
      gl.enableVertexAttribArray(cubes.aPos);
      gl.vertexAttribPointer(cubes.aPos, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, cubes.nrmBuf);
      gl.enableVertexAttribArray(cubes.aNrm);
      gl.vertexAttribPointer(cubes.aNrm, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, cubes.idxBuf);
      for (var i = 0; i < cubes.items.length; i++) {
        var it = cubes.items[i];
        /* 慢速圆轨道漂浮 + 自转 */
        var ox = Math.sin(t * it.orbS * 2 + it.ph) * it.orbR;
        var oy = Math.cos(t * it.orbS * 1.6 + it.ph * 1.7) * it.orbR * 0.6;
        var model = rotAxis(it.ax, it.ay, it.az, t * it.spd + it.ph);
        model[12] = it.x + ox;
        model[13] = it.y + oy;
        model[14] = it.z;
        var sc = it.size;
        model[0] *= sc; model[1] *= sc; model[2] *= sc;
        model[4] *= sc; model[5] *= sc; model[6] *= sc;
        model[8] *= sc; model[9] *= sc; model[10] *= sc;
        var mvp = mat4Mul(proj, mat4Mul(view, model));
        gl.uniformMatrix4fv(cubes.uMvp, false, mvp);
        gl.uniformMatrix3fv(cubes.uNrmMat, false, transpose3(model));
        var tint = (dark ? darkTints : lightTints)[i % 4];
        gl.uniform3fv(cubes.uTint, new Float32Array(tint));
        gl.drawElements(gl.TRIANGLES, cubes.count, gl.UNSIGNED_SHORT, 0);
      }
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.useProgram(prog);
    }

    /* ---------- 壁纸纹理 ---------- */
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.uniform1f(u.u_hasTex, 0);
    var texPending = 0;   // 防止旧图加载完成覆盖新状态

    function setWallpaper(dataURL) {
      if (!dataURL) { gl.uniform1f(u.u_hasTex, 0); render(); return; }
      var seq = ++texPending;
      var img = new Image();
      img.onload = function () {
        if (seq !== texPending || stopped) return;
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        /* 记录贴图宽高比，着色器按 cover 等比采样，避免拉伸变形 */
        gl.uniform1f(u.u_texAspect, img.width / Math.max(1, img.height));
        gl.uniform1f(u.u_hasTex, 1);
        render();                                           // 壁纸就位 → 重绘一帧
      };
      img.src = dataURL;
    }

    resize();
    applyPalette();
    gl.uniform1f(u.u_par, parallax ? 1 : 0);
    render();
    window.addEventListener('resize', render);              // 缩放 → 重绘一帧
    startLoop();                                            // 3D 模式才真正起循环
    /* 屏幕熄灭/切后台 → 暂停动画循环，回到前台恢复（省电省帧） */
    root.document.addEventListener('visibilitychange', function () {
      if (root.document.hidden) stopLoop();
      else startLoop();
    });

    return {
      setTheme: function (d) { dark = !!d; applyPalette(); render(); },
      setWallpaper: setWallpaper,
      /** 姿态输入：指针 (nx,ny ∈ 0..1) 或陀螺仪归一值；带缓动，3D 模式下驱动视差 */
      setMouse: function (nx, ny) {
        var k = parallax ? 0.12 : 0;                        // 0=静态模式完全不动（省电）
        if (!k) return;
        var tx = mouse.x + (nx - mouse.x) * k;
        var ty = mouse.y + (ny - mouse.y) * k;
        mouse.x = tx; mouse.y = ty;
      },
      fps: function () { return parallax ? 120 : 60; },
      /** 运行中切换 3D/静态（外观面板"背景 3D"开关） */
      setParallax: function (on) {
        parallax = !!on;
        if (parallax) startLoop();
        else { stopLoop(); gl.uniform1f(u.u_par, 0); render(); }
      },
      stop: function () {
        stopped = true;
        stopLoop();
        window.removeEventListener('resize', render);
        /* 不销毁上下文：同一 canvas 的上下文一旦丢失便无法恢复 */
      }
    };
  }

  root.LiquidBG = { supported: supported, start: start };

})(typeof window !== 'undefined' ? window : globalThis);
