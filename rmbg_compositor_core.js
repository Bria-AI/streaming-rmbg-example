/**
 * WebGL2 (or 2D fallback): blends foreground × mask. Solid or image background lives here;
 * moving video behind the subject is done with a `<video>` under the page canvas.
 */

let outputCanvas = null;
let gl = null;
let glProgram = null;
let glVao = null;
let texOrig = null;
let texMask = null;
let texBg = null;
let uBgColorLoc = null;
let uHasBgLoc = null;
let uHasOrigLoc = null;
let uHasBgTexLoc = null;

let outputCtx2d = null;
let decodeCanvas = null;
let decodeCtx = null;
let scratch = null;
let scratchCtx = null;

let bgImageBitmap = null;
let bgMode = "none";
let bgTexDirty = true;
let bgTexW = 0;
let bgTexH = 0;
let cachedContainFill = null;
let cachedContainW = 0;
let cachedContainH = 0;

const VS = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_orig;
uniform sampler2D u_mask;
uniform sampler2D u_bg;
uniform vec3 u_bgColor;
uniform int u_hasOrig;
uniform int u_hasBg;
uniform int u_hasBgTex;
out vec4 fragColor;
void main() {
  float alpha = texture(u_mask, v_uv).r;
  vec3 fg = (u_hasOrig == 1) ? texture(u_orig, v_uv).rgb : vec3(alpha);
  if (u_hasBgTex == 1) {
    vec3 bg = texture(u_bg, v_uv).rgb;
    fragColor = vec4(fg * alpha + bg * (1.0 - alpha), 1.0);
  } else if (u_hasBg == 1) {
    fragColor = vec4(fg * alpha + u_bgColor * (1.0 - alpha), 1.0);
  } else {
    fragColor = vec4(fg * alpha, alpha);
  }
}`;

/** Clears the uploaded still background and any cached “cover” pixels. */
function disposeBgImage() {
  if (bgImageBitmap) {
    bgImageBitmap.close();
    bgImageBitmap = null;
  }
  bgTexDirty = true;
  bgTexW = 0;
  bgTexH = 0;
  cachedContainFill = null;
  cachedContainW = 0;
  cachedContainH = 0;
}

/** 2D buffer at output size for the CPU compositing path. */
function ensureDecodeCanvas(w, h) {
  if (!decodeCanvas || decodeCanvas.width !== w || decodeCanvas.height !== h) {
    decodeCanvas = new OffscreenCanvas(w, h);
    decodeCtx = decodeCanvas.getContext("2d", { willReadFrequently: true });
  }
}

/** Scratch bitmap sized to the frame for image “cover” and 2D fills. */
function ensureScratch(w, h) {
  if (!scratch || scratch.width !== w || scratch.height !== h) {
    scratch = new OffscreenCanvas(w, h);
    scratchCtx = scratch.getContext("2d", { willReadFrequently: true });
  }
}

/** Sets up shaders and textures; returns a WebGL2 context or null to mean “use 2D”. */
function initWebGL(canvas) {
  const g = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true });
  if (!g) return null;

  const vs = g.createShader(g.VERTEX_SHADER);
  g.shaderSource(vs, VS);
  g.compileShader(vs);
  if (!g.getShaderParameter(vs, g.COMPILE_STATUS)) {
    g.deleteShader(vs);
    return null;
  }

  const fs = g.createShader(g.FRAGMENT_SHADER);
  g.shaderSource(fs, FS);
  g.compileShader(fs);
  if (!g.getShaderParameter(fs, g.COMPILE_STATUS)) {
    g.deleteShader(vs);
    g.deleteShader(fs);
    return null;
  }

  const prog = g.createProgram();
  g.attachShader(prog, vs);
  g.attachShader(prog, fs);
  g.linkProgram(prog);
  g.deleteShader(vs);
  g.deleteShader(fs);
  if (!g.getProgramParameter(prog, g.LINK_STATUS)) {
    g.deleteProgram(prog);
    return null;
  }

  glProgram = prog;
  g.useProgram(prog);

  const vao = g.createVertexArray();
  g.bindVertexArray(vao);
  const buf = g.createBuffer();
  g.bindBuffer(g.ARRAY_BUFFER, buf);
  g.bufferData(g.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), g.STATIC_DRAW);
  const loc = g.getAttribLocation(prog, "a_pos");
  g.enableVertexAttribArray(loc);
  g.vertexAttribPointer(loc, 2, g.FLOAT, false, 0, 0);
  glVao = vao;

  g.uniform1i(g.getUniformLocation(prog, "u_orig"), 0);
  g.uniform1i(g.getUniformLocation(prog, "u_mask"), 1);
  g.uniform1i(g.getUniformLocation(prog, "u_bg"), 2);
  uBgColorLoc = g.getUniformLocation(prog, "u_bgColor");
  uHasBgLoc = g.getUniformLocation(prog, "u_hasBg");
  uHasOrigLoc = g.getUniformLocation(prog, "u_hasOrig");
  uHasBgTexLoc = g.getUniformLocation(prog, "u_hasBgTex");

  const mkTex = () => {
    const t = g.createTexture();
    g.bindTexture(g.TEXTURE_2D, t);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
    return t;
  };
  texOrig = mkTex();
  texMask = mkTex();
  texBg = mkTex();

  g.disable(g.DEPTH_TEST);
  g.disable(g.BLEND);

  return g;
}

/** Uploads a CPU bitmap into a GPU texture slot. */
function uploadBitmap(g, tex, bitmap) {
  g.bindTexture(g.TEXTURE_2D, tex);
  g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, bitmap);
}

/** Draws the still background image as “cover” into the scratch buffer, then uploads it. */
function uploadCoverBg(g, w, h) {
  if (!bgImageBitmap) return;
  g.activeTexture(g.TEXTURE2);
  ensureScratch(w, h);
  if (!scratchCtx) return;
  const iw = bgImageBitmap.width;
  const ih = bgImageBitmap.height;
  const scale = Math.max(w / iw, h / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  const ox = (w - dw) / 2;
  const oy = (h - dh) / 2;
  scratchCtx.drawImage(bgImageBitmap, ox, oy, dw, dh);
  uploadBitmap(g, texBg, scratch);
  bgTexDirty = false;
  bgTexW = w;
  bgTexH = h;
}

/** One GPU frame: video + mask, optional image texture or flat colour behind the subject. */
async function compositeWebGL(g, frameId, videoBitmap, maskJpeg, width, height, backgroundRgb) {
  const maskBitmap = await createImageBitmap(new Blob([maskJpeg], { type: "image/jpeg" }));

  g.viewport(0, 0, width, height);
  g.useProgram(glProgram);
  g.bindVertexArray(glVao);

  g.activeTexture(g.TEXTURE0);
  uploadBitmap(g, texOrig, videoBitmap);
  g.uniform1i(uHasOrigLoc, 1);

  g.activeTexture(g.TEXTURE1);
  uploadBitmap(g, texMask, maskBitmap);

  g.activeTexture(g.TEXTURE2);
  let hasBgTex = 0;
  let hasBg = 0;

  if (bgMode === "imageContain" && bgImageBitmap) {
    if (bgTexDirty || bgTexW !== width || bgTexH !== height) {
      uploadCoverBg(g, width, height);
    }
    g.bindTexture(g.TEXTURE_2D, texBg);
    hasBgTex = 1;
  } else if (backgroundRgb) {
    g.uniform3f(uBgColorLoc, backgroundRgb.r / 255, backgroundRgb.g / 255, backgroundRgb.b / 255);
    hasBg = 1;
  }

  g.uniform1i(uHasBgTexLoc, hasBgTex);
  g.uniform1i(uHasBgLoc, hasBg);

  g.activeTexture(g.TEXTURE0);
  g.bindTexture(g.TEXTURE_2D, texOrig);
  g.activeTexture(g.TEXTURE1);
  g.bindTexture(g.TEXTURE_2D, texMask);
  g.activeTexture(g.TEXTURE2);
  g.bindTexture(g.TEXTURE_2D, texBg);

  g.drawArrays(g.TRIANGLES, 0, 6);

  maskBitmap.close();
  videoBitmap.close();

  self.postMessage({ type: "composite_done", frameId });
}

/** Refreshes the cached background ImageData when size or image changes (2D path). */
function rebuildCoverFill(w, h) {
  if (!bgImageBitmap) {
    cachedContainFill = null;
    return;
  }
  ensureScratch(w, h);
  if (!scratchCtx) {
    cachedContainFill = null;
    return;
  }
  const iw = bgImageBitmap.width;
  const ih = bgImageBitmap.height;
  const scale = Math.max(w / iw, h / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  const ox = (w - dw) / 2;
  const oy = (h - dh) / 2;
  scratchCtx.drawImage(bgImageBitmap, ox, oy, dw, dh);
  cachedContainFill = scratchCtx.getImageData(0, 0, w, h);
  cachedContainW = w;
  cachedContainH = h;
}

/** Same blend as WebGL, done with ImageData when WebGL2 isn’t available. */
async function composite2D(frameId, videoBitmap, maskJpeg, width, height, backgroundRgb) {
  const maskBitmap = await createImageBitmap(new Blob([maskJpeg], { type: "image/jpeg" }));

  ensureDecodeCanvas(width, height);
  const off = decodeCtx;

  off.drawImage(videoBitmap, 0, 0, width, height);
  const origPx = off.getImageData(0, 0, width, height);
  off.clearRect(0, 0, width, height);

  off.drawImage(maskBitmap, 0, 0, width, height);
  const maskPx = off.getImageData(0, 0, width, height);

  let bgFill = null;
  if (bgMode === "imageContain" && bgImageBitmap) {
    if (!cachedContainFill || cachedContainW !== width || cachedContainH !== height) {
      rebuildCoverFill(width, height);
    }
    bgFill = cachedContainFill;
  }

  const out = new ImageData(width, height);
  const o = out.data;
  const mk = maskPx.data;
  const or = origPx.data;

  for (let i = 0; i < o.length; i += 4) {
    const a = mk[i] / 255;
    let br = 0;
    let bg_ = 0;
    let bb = 0;
    let hasBg = false;
    if (bgFill) {
      br = bgFill.data[i];
      bg_ = bgFill.data[i + 1];
      bb = bgFill.data[i + 2];
      hasBg = true;
    } else if (backgroundRgb) {
      br = backgroundRgb.r;
      bg_ = backgroundRgb.g;
      bb = backgroundRgb.b;
      hasBg = true;
    }
    if (hasBg) {
      o[i] = Math.round(or[i] * a + br * (1 - a));
      o[i + 1] = Math.round(or[i + 1] * a + bg_ * (1 - a));
      o[i + 2] = Math.round(or[i + 2] * a + bb * (1 - a));
      o[i + 3] = 255;
    } else {
      o[i] = or[i];
      o[i + 1] = or[i + 1];
      o[i + 2] = or[i + 2];
      o[i + 3] = mk[i];
    }
  }

  outputCtx2d.putImageData(out, 0, 0);
  maskBitmap.close();
  videoBitmap.close();

  self.postMessage({ type: "composite_done", frameId });
}

/** Handles init, resize, background image, and per-frame composite messages. */
self.onmessage = async (ev) => {
  const d = ev.data;
  switch (d.type) {
    case "init": {
      outputCanvas = d.canvas;
      gl = initWebGL(outputCanvas);
      if (!gl) {
        outputCtx2d = outputCanvas.getContext("2d", { alpha: true });
      }
      break;
    }
    case "resize": {
      if (outputCanvas) {
        outputCanvas.width = d.width;
        outputCanvas.height = d.height;
        if (gl) {
          gl.viewport(0, 0, d.width, d.height);
        }
      }
      bgTexDirty = true;
      bgTexW = 0;
      bgTexH = 0;
      cachedContainFill = null;
      cachedContainW = 0;
      cachedContainH = 0;
      break;
    }
    case "set_background": {
      if (d.mode === "none") {
        disposeBgImage();
        bgMode = "none";
      } else if (d.mode === "imageContain" && d.bitmap) {
        disposeBgImage();
        bgImageBitmap = d.bitmap;
        bgMode = "imageContain";
        bgTexDirty = true;
      }
      break;
    }
    case "composite": {
      const { frameId, maskJpeg, videoBitmap, width, height, backgroundRgb } = d;
      if (gl) {
        await compositeWebGL(gl, frameId, videoBitmap, maskJpeg, width, height, backgroundRgb);
      } else if (outputCtx2d) {
        await composite2D(frameId, videoBitmap, maskJpeg, width, height, backgroundRgb);
      }
      break;
    }
    default:
      break;
  }
};
