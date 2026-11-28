import { useEffect, useRef } from "react";

// The site's moving sky (sondine-site, components/sky.tsx; ADR 033): the
// theme's orange (color-4), pale sky (color-3) and teal (color-2), slowly
// warped by noise, with a little grain, drawn with WebGL about 15 times a
// second while it is shown. Before the first frame, without WebGL, or under
// reduced motion (one still frame), the CSS gradient under it stays. In
// dark mode (Téo, 2026-11-28) the pale sky gives way to the window's black,
// and slow holes open in the colors where the background shows through.

const VERTEX = `#version 300 es
in vec2 p;
void main(){gl_Position=vec4(p,0.,1.);}`;

const FRAGMENT = `#version 300 es
precision highp float;
uniform vec2 r;
uniform float t;
uniform vec3 a;
uniform vec3 b;
uniform vec3 c;
uniform float d;
out vec4 o;
vec2 h(vec2 p){p=vec2(dot(p,vec2(127.1,311.7)),dot(p,vec2(269.5,183.3)));return fract(sin(p)*43758.5453)*2.-1.;}
float n(vec2 p){vec2 i=floor(p),f=fract(p),u=f*f*(3.-2.*f);
return mix(mix(dot(h(i),f),dot(h(i+vec2(1,0)),f-vec2(1,0)),u.x),mix(dot(h(i+vec2(0,1)),f-vec2(0,1)),dot(h(i+vec2(1,1)),f-vec2(1,1)),u.x),u.y)*.5+.5;}
void main(){
  vec2 uv=gl_FragCoord.xy/r;
  vec2 q=uv*vec2(r.x/r.y,1.)*.9;
  float s=t*.18;
  q+=.22*vec2(sin(q.y*3.1+s*2.),cos(q.x*2.3-s*1.6));
  float k=uv.x*.95+(n(q*1.6+s)-.5)*.9+.12*sin(s+uv.y*2.);
  vec4 pale=vec4(a,1.-d);
  vec4 col=mix(vec4(c,1.),pale,smoothstep(.12,.55,k));
  col=mix(col,vec4(b,1.),smoothstep(.55,.95,k));
  float hole=smoothstep(.38,.62,n(q*1.1-s*.7+vec2(4.2,1.3)));
  col.a*=1.-d*hole;
  col.rgb+=(fract(sin(dot(gl_FragCoord.xy,vec2(12.9898,78.233)))*43758.5453)-.5)*.06;
  o=vec4(col.rgb*col.a,col.a);
}`;

const FRAME_MS = 66;

/** A theme color as RGB in 0–1, read from the element's computed style. */
function themeColor(element: Element, variable: string): number[] {
  const probe = document.createElement("span");
  probe.style.color = `var(${variable})`;
  element.append(probe);
  const value = getComputedStyle(probe).color;
  probe.remove();
  const channels = value
    .match(/[\d.]+/g)
    ?.slice(0, 3)
    .map(Number) ?? [0, 0, 0];
  return channels.map((channel) => channel / 255);
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (shader === null) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return shader;
}

/** Draws the sky in the canvas until stopped; null without WebGL. */
function startSky(canvas: HTMLCanvasElement, still: boolean): (() => void) | null {
  const gl = canvas.getContext("webgl2", { antialias: false });
  if (gl === null) return null;
  const program = gl.createProgram();
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
  if (vertex === null || fragment === null) return null;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) return null;
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const at = gl.getAttribLocation(program, "p");
  gl.enableVertexAttribArray(at);
  gl.vertexAttribPointer(at, 2, gl.FLOAT, false, 0, 0);
  gl.uniform3fv(gl.getUniformLocation(program, "a"), themeColor(canvas, "--color-3"));
  gl.uniform3fv(gl.getUniformLocation(program, "b"), themeColor(canvas, "--color-2"));
  gl.uniform3fv(gl.getUniformLocation(program, "c"), themeColor(canvas, "--color-4"));
  const resolution = gl.getUniformLocation(program, "r");
  const time = gl.getUniformLocation(program, "t");
  const dark = gl.getUniformLocation(program, "d");

  let frame = 0;
  let last = -Infinity;
  const start = performance.now() - 8000;
  const draw = (now: number) => {
    if (now - last > FRAME_MS) {
      last = now;
      const width = Math.max(1, canvas.clientWidth);
      const height = Math.max(1, canvas.clientHeight);
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      gl.viewport(0, 0, width, height);
      gl.uniform2f(resolution, width, height);
      gl.uniform1f(time, (now - start) / 1000);
      // Read at each frame, so a change of theme shows at once.
      const holes = getComputedStyle(canvas).getPropertyValue("--sondine-sky-holes").trim();
      gl.uniform1f(dark, holes === "1" ? 1 : 0);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      // The CSS gradient under it would show through the holes.
      canvas.parentElement?.setAttribute("data-drawn", "");
    }
    if (!still) frame = requestAnimationFrame(draw);
  };
  frame = requestAnimationFrame(draw);
  return () => cancelAnimationFrame(frame);
}

export function SkySurface({ className }: { className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const surface = canvas.current;
    if (surface === null) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    return startSky(surface, still) ?? undefined;
  }, []);
  return (
    <div aria-hidden className={className}>
      <canvas ref={canvas} className="block size-full" />
    </div>
  );
}
