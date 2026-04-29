/** Compositor: WebGL2 when available, else 2D. JPEG encoding is in rmbg_encode_worker.js (separate thread). */

let outputCanvas = null;

let gl = null;
let glProgram = null;
let glVao = null;
let texOrig = null;
let texMask = null;
let uHasOrigLoc = null;

let outputCtx2d = null;

let decodeCanvas = null;
let decodeCtx = null;

const VS = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FS_TRANSPARENT_ORIG = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_orig;
uniform sampler2D u_mask;
uniform int u_hasOrig;
out vec4 fragColor;
void main() {
  float a = texture(u_mask, v_uv).r;
  if (u_hasOrig == 1) {
    vec3 fg = texture(u_orig, v_uv).rgb;
    fragColor = vec4(fg * a, a);
  } else {
    fragColor = vec4(a, a, a, a);
  }
}`;

function ensureDecodeCanvas(w, h) {
  if (!decodeCanvas || decodeCanvas.width !== w || decodeCanvas.height !== h) {
    decodeCanvas = new OffscreenCanvas(w, h);
    decodeCtx = decodeCanvas.getContext("2d", { willReadFrequently: true });
  }
}

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
  g.shaderSource(fs, FS_TRANSPARENT_ORIG);
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
  uHasOrigLoc = g.getUniformLocation(prog, "u_hasOrig");

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

  g.disable(g.DEPTH_TEST);
  g.disable(g.BLEND);

  return g;
}

function uploadBitmap(g, tex, bitmap) {
  g.bindTexture(g.TEXTURE_2D, tex);
  g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, bitmap);
}

async function compositeWebGL(g, frameId, videoBitmap, maskJpeg, width, height) {
  const maskBitmap = await createImageBitmap(new Blob([maskJpeg], { type: "image/jpeg" }));

  g.viewport(0, 0, width, height);
  g.useProgram(glProgram);
  g.bindVertexArray(glVao);

  g.activeTexture(g.TEXTURE0);
  uploadBitmap(g, texOrig, videoBitmap);
  g.uniform1i(uHasOrigLoc, 1);

  g.activeTexture(g.TEXTURE1);
  uploadBitmap(g, texMask, maskBitmap);

  g.drawArrays(g.TRIANGLES, 0, 6);

  maskBitmap.close();
  videoBitmap.close();

  self.postMessage({ type: "composite_done", frameId });
}

async function composite2D(frameId, videoBitmap, maskJpeg, width, height) {
  const maskBitmap = await createImageBitmap(new Blob([maskJpeg], { type: "image/jpeg" }));

  ensureDecodeCanvas(width, height);
  const off = decodeCtx;

  off.drawImage(videoBitmap, 0, 0, width, height);
  const rgb = off.getImageData(0, 0, width, height);
  off.clearRect(0, 0, width, height);

  off.drawImage(maskBitmap, 0, 0, width, height);
  const maskPx = off.getImageData(0, 0, width, height);

  videoBitmap.close();
  maskBitmap.close();

  const out = new ImageData(width, height);
  const o = out.data;
  const mk = maskPx.data;
  const r = rgb.data;
  for (let i = 0; i < o.length; i += 4) {
    o[i] = r[i];
    o[i + 1] = r[i + 1];
    o[i + 2] = r[i + 2];
    o[i + 3] = mk[i];
  }
  outputCtx2d.putImageData(out, 0, 0);

  self.postMessage({ type: "composite_done", frameId });
}

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
      break;
    }
    case "composite": {
      const { frameId, maskJpeg, videoBitmap, width, height } = d;
      if (gl) {
        await compositeWebGL(gl, frameId, videoBitmap, maskJpeg, width, height);
      } else if (outputCtx2d) {
        await composite2D(frameId, videoBitmap, maskJpeg, width, height);
      }
      break;
    }
    default:
      break;
  }
};
