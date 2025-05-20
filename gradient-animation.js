(() => {

//Converting colors to proper format
function normalizeColor(hexCode) {
  // Ensure hexCode is treated as a number for bitwise operations
  const numHexCode = Number(hexCode);
  return [(numHexCode >> 16 & 255) / 255, (numHexCode >> 8 & 255) / 255, (255 & numHexCode) / 255];
}
// This part was present in the original script. It creates an object e.g. { SCREEN: 0, LINEAR_LIGHT: 1 } but its result is not assigned or used.
["SCREEN", "LINEAR_LIGHT"].reduce((acc, t, n) => Object.assign(acc, {
  [t]: n
}), {});

//Sets initial properties helper
function eHelper(object, propertyName, val) {
  return propertyName in object ? Object.defineProperty(object, propertyName, {
    value: val, enumerable: true, configurable: true, writable: true
  }) : object[propertyName] = val, object;
}

class MiniGl {
  constructor(canvas, width, height, debug = false) {
    const _miniGl = this; // _miniGl refers to the MiniGl instance ('this')
    _miniGl.canvas = canvas;
    _miniGl.gl = _miniGl.canvas.getContext("webgl", {
        antialias: true
    });

    if (!_miniGl.gl) {
        console.error("WebGL not supported or context creation failed. Gradient will not run.");
        return; // Stop initialization if WebGL context failed
    }

    _miniGl.meshes = [];
    const context = _miniGl.gl; // Local alias for convenience for inner classes

    // 1. Define helper "classes" like Uniform, Material on the instance via Object.defineProperties
    //    These are used by commonUniforms and Material instances later.
    Object.defineProperties(_miniGl, {
        Material: {
            enumerable: false,
            value: class {
                constructor(vertexShaders, fragments, uniforms = {}) {
                    const material = this;
                    function getShaderByType(type, source) {
                        const shader = context.createShader(type);
                        context.shaderSource(shader, source);
                        context.compileShader(shader);
                        if (!context.getShaderParameter(shader, context.COMPILE_STATUS)) {
                            console.error("Shader compilation error:", context.getShaderInfoLog(shader), "Source:", source);
                        }
                        // _miniGl.debug is not defined yet if this constructor is called before _miniGl.debug is set.
                        // This is okay if Material is only instantiated after MiniGl constructor completes.
                        // However, commonUniforms instantiates Uniforms, which don't call debug.
                        // Gradient materials are created later, when _miniGl.debug IS defined.
                        if (_miniGl.debug) _miniGl.debug("Material.compileShaderSource", { source });
                        return shader;
                    }
                    function getUniformVariableDeclarations(uniformsObj, type) {
                        return Object.entries(uniformsObj).map(([uniformName, uniformValue]) => uniformValue.getDeclaration(uniformName, type)).join("\n");
                    }
                    material.uniforms = uniforms;
                    material.uniformInstances = [];
                    const prefix = "\nprecision highp float;\n";
                    material.vertexSource = `${prefix}
attribute vec4 position;
attribute vec2 uv;
attribute vec2 uvNorm;
${getUniformVariableDeclarations(_miniGl.commonUniforms,"vertex")}
${getUniformVariableDeclarations(uniforms,"vertex")}
${vertexShaders}`;
                    material.Source = `${prefix}
${getUniformVariableDeclarations(_miniGl.commonUniforms,"fragment")}
${getUniformVariableDeclarations(uniforms,"fragment")}
${fragments}`;
                    material.vertexShader = getShaderByType(context.VERTEX_SHADER, material.vertexSource);
                    material.fragmentShader = getShaderByType(context.FRAGMENT_SHADER, material.Source);
                    material.program = context.createProgram();
                    context.attachShader(material.program, material.vertexShader);
                    context.attachShader(material.program, material.fragmentShader);
                    context.linkProgram(material.program);
                    if (!context.getProgramParameter(material.program, context.LINK_STATUS)) {
                        console.error("Program linking error:", context.getProgramInfoLog(material.program));
                    }
                    context.useProgram(material.program);
                    material.attachUniforms(undefined, _miniGl.commonUniforms);
                    material.attachUniforms(undefined, material.uniforms);
                }
                attachUniforms(name, uniformValue) {
                    const material = this;
                    if (name === undefined) {
                        Object.entries(uniformValue).forEach(([n, uVal]) => material.attachUniforms(n, uVal));
                    } else if (uniformValue.type === "array") {
                        uniformValue.value.forEach((u, i) => material.attachUniforms(`${name}[${i}]`, u));
                    } else if (uniformValue.type === "struct") {
                        Object.entries(uniformValue.value).forEach(([structKey, structVal]) => material.attachUniforms(`${name}.${structKey}`, structVal));
                    } else {
                        if (_miniGl.debug) _miniGl.debug("Material.attachUniforms", { name, uniform: uniformValue });
                        const location = context.getUniformLocation(material.program, name);
                        material.uniformInstances.push({
                            uniform: uniformValue,
                            location: location
                        });
                    }
                }
            }
        },
        Uniform: {
            enumerable: false,
            value: class {
                constructor(config) {
                    this.type = "float";
                    Object.assign(this, config);
                    this.typeFn = ({
                        float: "1f", int: "1i", vec2: "2fv", vec3: "3fv", vec4: "4fv", mat4: "Matrix4fv"
                    })[this.type] || "1f";
                }
                update(location) {
                    if (this.value !== undefined && location !== null && location !== -1) {
                        const args = [location];
                        if (this.typeFn.startsWith("Matrix")) {
                            args.push(this.transpose || false);
                        }
                        args.push(this.value);
                        context[`uniform${this.typeFn}`](...args);
                    }
                }
                getDeclaration(name, shaderType, length) {
                    const uniform = this;
                    if (uniform.excludeFrom === shaderType) {
                        return "";
                    }
                    if (uniform.type === "array") {
                        if (!uniform.value || uniform.value.length === 0) return `// Uniform array ${name} is empty\n`;
                        return uniform.value[0].getDeclaration(name, shaderType, uniform.value.length) + `\nconst int ${name}_length = ${uniform.value.length};`;
                    }
                    if (uniform.type === "struct") {
                        let structName = name.replace("u_", "");
                        structName = structName.charAt(0).toUpperCase() + structName.slice(1);
                        const members = Object.entries(uniform.value)
                            .map(([memberName, memberUniform]) => `\t${memberUniform.getDeclaration(memberName, shaderType).replace(/^uniform\s+/, "")};`)
                            .join("\n");
                        return `uniform struct ${structName} {\n${members}\n} ${name}${length > 0 ? `[${length}]` : ""}`;
                    }
                    return `uniform ${uniform.type} ${name}${length > 0 ? `[${length}]` : ""}`;
                }
            }
        },
        PlaneGeometry: {
            enumerable: false,
            value: class {
                constructor(width, height, segX, segY, orientation) {
                    this.attributes = {
                        position: new _miniGl.Attribute({ target: context.ARRAY_BUFFER, size: 3 }),
                        uv: new _miniGl.Attribute({ target: context.ARRAY_BUFFER, size: 2 }),
                        uvNorm: new _miniGl.Attribute({ target: context.ARRAY_BUFFER, size: 2 }),
                        index: new _miniGl.Attribute({ target: context.ELEMENT_ARRAY_BUFFER, size: 3, type: context.UNSIGNED_SHORT })
                    };
                    this.setTopology(segX, segY);
                    this.setSize(width, height, orientation);
                }
                setTopology(segX = 1, segY = 1) {
                    const geom = this;
                    geom.xSegCount = segX; geom.ySegCount = segY;
                    geom.vertexCount = (geom.xSegCount + 1) * (geom.ySegCount + 1);
                    geom.quadCount = geom.xSegCount * geom.ySegCount;
                    geom.attributes.uv.values = new Float32Array(2 * geom.vertexCount);
                    geom.attributes.uvNorm.values = new Float32Array(2 * geom.vertexCount);
                    geom.attributes.index.values = new Uint16Array(3 * geom.quadCount * 2);
                    for (let y = 0; y <= geom.ySegCount; y++) {
                        for (let x = 0; x <= geom.xSegCount; x++) {
                            const idx = y * (geom.xSegCount + 1) + x;
                            geom.attributes.uv.values[2 * idx] = x / geom.xSegCount;
                            geom.attributes.uv.values[2 * idx + 1] = 1 - y / geom.ySegCount;
                            geom.attributes.uvNorm.values[2 * idx] = (x / geom.xSegCount) * 2 - 1;
                            geom.attributes.uvNorm.values[2 * idx + 1] = (1 - y / geom.ySegCount) * 2 - 1;
                            if (x < geom.xSegCount && y < geom.ySegCount) {
                                const quadIdx = (y * geom.xSegCount + x) * 6;
                                const v1 = idx, v2 = idx + 1, v3 = idx + geom.xSegCount + 1, v4 = idx + geom.xSegCount + 2;
                                geom.attributes.index.values[quadIdx] = v1; geom.attributes.index.values[quadIdx + 1] = v3; geom.attributes.index.values[quadIdx + 2] = v2;
                                geom.attributes.index.values[quadIdx + 3] = v2; geom.attributes.index.values[quadIdx + 4] = v3; geom.attributes.index.values[quadIdx + 5] = v4;
                            }
                        }
                    }
                    geom.attributes.uv.update(); geom.attributes.uvNorm.update(); geom.attributes.index.update();
                    if (_miniGl.debug) _miniGl.debug("Geometry.setTopology", { uv: geom.attributes.uv, uvNorm: geom.attributes.uvNorm, index: geom.attributes.index });
                }
                setSize(width = 1, height = 1, orientation = "xz") {
                    const geom = this; geom.width = width; geom.height = height; geom.orientation = orientation;
                    if (!geom.attributes.position.values || geom.attributes.position.values.length !== 3 * geom.vertexCount) {
                        geom.attributes.position.values = new Float32Array(3 * geom.vertexCount);
                    }
                    const halfWidth = width / 2, halfHeight = height / 2;
                    const segWidth = width / geom.xSegCount, segHeight = height / geom.ySegCount;
                    for (let yIdx = 0; yIdx <= geom.ySegCount; yIdx++) {
                        const yPos = -halfHeight + yIdx * segHeight;
                        for (let xIdx = 0; xIdx <= geom.xSegCount; xIdx++) {
                            const xPos = -halfWidth + xIdx * segWidth; const idx = yIdx * (geom.xSegCount + 1) + xIdx;
                            geom.attributes.position.values[3 * idx + 0] = 0; geom.attributes.position.values[3 * idx + 1] = 0; geom.attributes.position.values[3 * idx + 2] = 0;
                            geom.attributes.position.values[3 * idx + "xyz".indexOf(orientation[0])] = xPos;
                            geom.attributes.position.values[3 * idx + "xyz".indexOf(orientation[1])] = -yPos;
                        }
                    }
                    geom.attributes.position.update();
                    if (_miniGl.debug) _miniGl.debug("Geometry.setSize", { position: geom.attributes.position });
                }
            }
        },
        Mesh: {
            enumerable: false,
            value: class {
                constructor(geometry, material) {
                    const mesh = this; mesh.geometry = geometry; mesh.material = material; mesh.wireframe = false; mesh.attributeInstances = [];
                    Object.entries(mesh.geometry.attributes).forEach(([attrName, attribute]) => {
                        mesh.attributeInstances.push({ attribute, location: attribute.attach(attrName, mesh.material.program) });
                    });
                    _miniGl.meshes.push(mesh); if (_miniGl.debug) _miniGl.debug("Mesh.constructor", { mesh });
                }
                draw() {
                    if (!this.material || !this.material.program || !context) return;
                    context.useProgram(this.material.program);
                    this.material.uniformInstances.forEach(({ uniform, location }) => uniform.update(location));
                    this.attributeInstances.forEach(({ attribute, location }) => attribute.use(location));
                    if (this.geometry.attributes.index.values && this.geometry.attributes.index.values.length > 0) {
                        context.drawElements(this.wireframe ? context.LINES : context.TRIANGLES, this.geometry.attributes.index.values.length, context.UNSIGNED_SHORT, 0);
                    }
                }
                remove() { _miniGl.meshes = _miniGl.meshes.filter(m => m !== this); }
            }
        },
        Attribute: {
            enumerable: false,
            value: class {
                constructor(config) {
                    this.type = context.FLOAT; this.normalized = false; this.buffer = context.createBuffer();
                    Object.assign(this, config); this.update();
                }
                update() {
                    if (this.values !== undefined) {
                        context.bindBuffer(this.target, this.buffer);
                        context.bufferData(this.target, this.values, context.STATIC_DRAW);
                    }
                }
                attach(attrName, program) {
                    const location = context.getAttribLocation(program, attrName);
                    if (location === -1) return location;
                    context.bindBuffer(this.target, this.buffer);
                    if (this.target === context.ARRAY_BUFFER) {
                        context.enableVertexAttribArray(location);
                        context.vertexAttribPointer(location, this.size, this.type, this.normalized, 0, 0);
                    }
                    return location;
                }
                use(location) {
                    if (!context) return;
                    context.bindBuffer(this.target, this.buffer);
                    if (this.target === context.ARRAY_BUFFER && location !== -1) {
                        context.enableVertexAttribArray(location);
                        context.vertexAttribPointer(location, this.size, this.type, this.normalized, 0, 0);
                    }
                }
            }
        }
    }); // End of Object.defineProperties

    // 2. Initialize the debug function
    const debug_output = typeof document !== 'undefined' && document.location && document.location.search && -1 !== document.location.search.toLowerCase().indexOf("debug=webgl");
    _miniGl.lastDebugMsg = 0;
    _miniGl.debug = debug && debug_output ? function(msg) {
        const t = new Date();
        if (t - _miniGl.lastDebugMsg > 1000) console.log("---");
        console.log(t.toLocaleTimeString() + Array(Math.max(0, 32 - msg.length)).join(" ") + msg + ": ", ...Array.from(arguments).slice(1));
        _miniGl.lastDebugMsg = t;
    } : () => {}; // Empty function if not debugging

    // 3. Initialize commonUniforms (which uses _miniGl.Uniform, now defined)
    const identityMatrix = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
    _miniGl.commonUniforms = {
        projectionMatrix: new _miniGl.Uniform({ type: "mat4", value: [...identityMatrix] }),
        modelViewMatrix: new _miniGl.Uniform({ type: "mat4", value: [...identityMatrix] }),
        resolution: new _miniGl.Uniform({ type: "vec2", value: [1, 1] }),
        aspectRatio: new _miniGl.Uniform({ type: "float", value: 1 })
    };

    // 4. Call setSize if width and height are provided
    //    This now happens after _miniGl.debug and _miniGl.commonUniforms are initialized.
    if (width !== undefined && height !== undefined && width !== null && height !== null) {
      this.setSize(width, height);
    } else if (this.canvas && this.canvas.width && this.canvas.height) {
      this.setSize(this.canvas.width, this.canvas.height);
    } else {
      this.setSize(640, 480); // Default size if no other dimensions are available
      _miniGl.debug("MiniGL.constructor: No dimensions provided or canvas has no dimensions, using default size.");
    }
  } // End of MiniGl constructor

  setSize(width = 640, height = 480) {
    if (!this.gl) return;
    this.width = width; this.height = height;
    this.canvas.width = width; this.canvas.height = height;
    this.gl.viewport(0, 0, width, height);
    if (this.commonUniforms && this.commonUniforms.resolution) {
        this.commonUniforms.resolution.value = [width, height];
        this.commonUniforms.aspectRatio.value = width / height;
    }
    this.debug("MiniGL.setSize", { width, height }); // This should now work
  }

  setOrthographicCamera(left = -1, right = 1, bottom = -1, top = 1, near = -2000, far = 2000) {
    if (!this.commonUniforms || !this.commonUniforms.projectionMatrix) return;
    if (this.width && this.height) {
        this.commonUniforms.projectionMatrix.value = [
            2 / this.width, 0, 0, 0,
            0, -2 / this.height, 0, 0,
            0, 0, 2 / (near - far), 0,
            -1, 1, (near + far) / (near - far), 1
        ];
    } else {
        const lr = 1 / (left - right), bt = 1 / (bottom - top), nf = 1 / (near - far);
        this.commonUniforms.projectionMatrix.value = [
            -2 * lr, 0, 0, 0, 0, -2 * bt, 0, 0, 0, 0, 2 * nf, 0,
            (left + right) * lr, (top + bottom) * bt, (far + near) * nf, 1
        ];
    }
    this.debug("setOrthographicCamera", this.commonUniforms.projectionMatrix.value);
  }

  render() {
    if (!this.gl) return;
    this.gl.clearColor(0, 0, 0, 0);
    this.gl.clearDepth(1);
    this.meshes.forEach(mesh => mesh.draw());
  }
} // End of MiniGl Class


class Gradient {
  constructor() {
    eHelper(this, "el", void 0);
    eHelper(this, "cssVarRetries", 0);
    eHelper(this, "maxCssVarRetries", 200);
    eHelper(this, "angle", 0);
    eHelper(this, "isLoadedClass", false);
    eHelper(this, "isScrolling", false);
    eHelper(this, "scrollingTimeout", void 0);
    eHelper(this, "scrollingRefreshDelay", 200);
    eHelper(this, "isIntersecting", false);
    eHelper(this, "shaderFiles", void 0);
    eHelper(this, "vertexShader", void 0);
    eHelper(this, "sectionColors", void 0);
    eHelper(this, "computedCanvasStyle", void 0);
    eHelper(this, "conf", void 0);
    eHelper(this, "uniforms", void 0);
    eHelper(this, "t", 1253106);
    eHelper(this, "last", 0);
    eHelper(this, "width", typeof window !== 'undefined' ? window.innerWidth : 1024);
    eHelper(this, "minWidth", 1111);
    eHelper(this, "height", 600);
    eHelper(this, "xSegCount", void 0);
    eHelper(this, "ySegCount", void 0);
    eHelper(this, "mesh", void 0);
    eHelper(this, "material", void 0);
    eHelper(this, "geometry", void 0);
    eHelper(this, "minigl", void 0);
    eHelper(this, "scrollObserver", void 0);
    eHelper(this, "amp", 320);
    eHelper(this, "seed", 5);
    eHelper(this, "freqX", 14e-5);
    eHelper(this, "freqY", 29e-5);
    eHelper(this, "freqDelta", 1e-5);
    eHelper(this, "activeColors", [1, 1, 1, 1]);
    eHelper(this, "isMetaKey", false);
    eHelper(this, "isGradientLegendVisible", false);
    eHelper(this, "isMouseDown", false);
    eHelper(this, "boundResize", null);
    eHelper(this, "boundMouseDown", null);
    eHelper(this, "boundMouseUp", null);

    this.animate = this.animate.bind(this); // Bind animate once
    this.resize = this.resize.bind(this); // Bind resize once
    this.handleScroll = this.handleScroll.bind(this);
    this.handleScrollEnd = this.handleScrollEnd.bind(this);
    this.handleMouseDown = this.handleMouseDown.bind(this);
    this.handleMouseUp = this.handleMouseUp.bind(this);
    this.waitForCssVars = this.waitForCssVars.bind(this);


  } // End of Gradient constructor

  connect() {
    this.shaderFiles = {
        vertex: `varying vec3 v_color;
void main() {
  float time = u_time * u_global.noiseSpeed;
  vec2 noiseCoord = resolution * uvNorm * u_global.noiseFreq;
  float tilt = resolution.y / 2.0 * uvNorm.y;
  float incline = resolution.x * uvNorm.x / 2.0 * u_vertDeform.incline;
  float offset = resolution.x / 2.0 * u_vertDeform.incline * mix(u_vertDeform.offsetBottom, u_vertDeform.offsetTop, uv.y);
  float noise = snoise(vec3(
    noiseCoord.x * u_vertDeform.noiseFreq.x + time * u_vertDeform.noiseFlow,
    noiseCoord.y * u_vertDeform.noiseFreq.y,
    time * u_vertDeform.noiseSpeed + u_vertDeform.noiseSeed
  )) * u_vertDeform.noiseAmp;
  noise *= 1.0 - pow(abs(uvNorm.y), 2.0);
  noise = max(0.0, noise);
  vec3 pos = vec3(
    position.x,
    position.y + tilt + incline + noise - offset,
    position.z
  );
  if (u_active_colors[0] == 1.) {
    v_color = u_baseColor;
  }
  for (int i = 0; i < u_waveLayers_length; i++) {
    if (u_active_colors[i + 1] == 1.) {
      WaveLayers layer = u_waveLayers[i];
      float noiseVal = smoothstep(
        layer.noiseFloor, layer.noiseCeil,
        snoise(vec3(
          noiseCoord.x * layer.noiseFreq.x + time * layer.noiseFlow,
          noiseCoord.y * layer.noiseFreq.y,
          time * layer.noiseSpeed + layer.noiseSeed
        )) / 2.0 + 0.5
      );
      v_color = blendNormal(v_color, layer.color, pow(noiseVal, 4.0));
    }
  }
  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
}`,
        noise: "vec3 mod289(vec3 x){return x-floor(x*(1./289.))*289.;}vec4 mod289(vec4 x){return x-floor(x*(1./289.))*289.;}vec4 permute(vec4 x){return mod289(((x*34.)+1.)*x);}vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-.85373472095314*r;}float snoise(vec3 v){const vec2 C=vec2(1./6.,1./3.);const vec4 D=vec4(0.,.5,1.,2.);vec3 i=floor(v+dot(v,C.yyy));vec3 x0=v-i+dot(i,C.xxx);vec3 g=step(x0.yzx,x0.xyz);vec3 l=1.-g;vec3 i1=min(g.xyz,l.zxy);vec3 i2=max(g.xyz,l.zxy);vec3 x1=x0-i1+C.xxx;vec3 x2=x0-i2+C.yyy;vec3 x3=x0-D.yyy;i=mod289(i);vec4 p=permute(permute(permute(i.z+vec4(0.,i1.z,i2.z,1.))+i.y+vec4(0.,i1.y,i2.y,1.))+i.x+vec4(0.,i1.x,i2.x,1.));float n_=1./7.;vec3 ns=n_*D.wyz-D.xzx;vec4 j=p-49.*floor(p*ns.z*ns.z);vec4 x_=floor(j*ns.z);vec4 y_=floor(j-7.*x_);vec4 x=x_*ns.x+ns.yyyy;vec4 y=y_*ns.x+ns.yyyy;vec4 h=1.-abs(x)-abs(y);vec4 b0=vec4(x.xy,y.xy);vec4 b1=vec4(x.zw,y.zw);vec4 s0=floor(b0)*2.+1.;vec4 s1=floor(b1)*2.+1.;vec4 sh=-step(h,vec4(0.));vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;vec3 p0=vec3(a0.xy,h.x);vec3 p1=vec3(a0.zw,h.y);vec3 p2=vec3(a1.xy,h.z);vec3 p3=vec3(a1.zw,h.w);vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;vec4 m=max(.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.);m=m*m;return 42.*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));}",
        blend: "vec3 blendNormal(vec3 base,vec3 blend){return blend;}vec3 blendNormal(vec3 base,vec3 blend,float opacity){return(blendNormal(base,blend)*opacity+base*(1.-opacity));}float blendScreen(float base, float blend) {return 1.0-((1.0-base)*(1.0-blend));} vec3 blendScreen(vec3 base, vec3 blend) {return vec3(blendScreen(base.r,blend.r),blendScreen(base.g,blend.g),blendScreen(base.b,blend.b));} vec3 blendScreen(vec3 base, vec3 blend, float opacity) {return (blendScreen(base, blend) * opacity + base * (1.0 - opacity));} vec3 blendMultiply(vec3 base, vec3 blend) {return base*blend;} vec3 blendMultiply(vec3 base, vec3 blend, float opacity) {return (blendMultiply(base, blend) * opacity + base * (1.0 - opacity));} float blendOverlay(float base, float blend) {return base<0.5?(2.0*base*blend):(1.0-2.0*(1.0-base)*(1.0-blend));} vec3 blendOverlay(vec3 base, vec3 blend) {return vec3(blendOverlay(base.r,blend.r),blendOverlay(base.g,blend.g),blendOverlay(base.b,blend.b));} vec3 blendOverlay(vec3 base, vec3 blend, float opacity) {return (blendOverlay(base, blend) * opacity + base * (1.0 - opacity));} vec3 blendHardLight(vec3 base, vec3 blend) {return blendOverlay(blend,base);} vec3 blendHardLight(vec3 base, vec3 blend, float opacity) {return (blendHardLight(base, blend) * opacity + base * (1.0 - opacity));} float blendSoftLight(float base, float blend) {return (blend<0.5)?(2.0*base*blend+base*base*(1.0-2.0*blend)):(sqrt(base)*(2.0*blend-1.0)+2.0*base*(1.0-blend));} vec3 blendSoftLight(vec3 base, vec3 blend) {return vec3(blendSoftLight(base.r,blend.r),blendSoftLight(base.g,blend.g),blendSoftLight(base.b,blend.b));} vec3 blendSoftLight(vec3 base, vec3 blend, float opacity) {return (blendSoftLight(base, blend) * opacity + base * (1.0 - opacity));} float blendColorDodge(float base, float blend) {return (blend==1.0)?blend:min(base/(1.0-blend),1.0);} vec3 blendColorDodge(vec3 base, vec3 blend) {return vec3(blendColorDodge(base.r,blend.r),blendColorDodge(base.g,blend.g),blendColorDodge(base.b,blend.b));} vec3 blendColorDodge(vec3 base, vec3 blend, float opacity) {return (blendColorDodge(base, blend) * opacity + base * (1.0 - opacity));} float blendColorBurn(float base, float blend) {return (blend==0.0)?blend:max((1.0-((1.0-base)/blend)),0.0);} vec3 blendColorBurn(vec3 base, vec3 blend) {return vec3(blendColorBurn(base.r,blend.r),blendColorBurn(base.g,blend.g),blendColorBurn(base.b,blend.b));} vec3 blendColorBurn(vec3 base, vec3 blend, float opacity) {return (blendColorBurn(base, blend) * opacity + base * (1.0 - opacity));} float blendVividLight(float base, float blend) {return (blend<0.5)?blendColorBurn(base,(2.0*blend)):blendColorDodge(base,(2.0*(blend-0.5)));} vec3 blendVividLight(vec3 base, vec3 blend) {return vec3(blendVividLight(base.r,blend.r),blendVividLight(base.g,blend.g),blendVividLight(base.b,blend.b));} vec3 blendVividLight(vec3 base, vec3 blend, float opacity) {return (blendVividLight(base, blend) * opacity + base * (1.0 - opacity));} float blendLighten(float base, float blend) {return max(blend,base);} vec3 blendLighten(vec3 base, vec3 blend) {return vec3(blendLighten(base.r,blend.r),blendLighten(base.g,blend.g),blendLighten(base.b,blend.b));} vec3 blendLighten(vec3 base, vec3 blend, float opacity) {return (blendLighten(base, blend) * opacity + base * (1.0 - opacity));} float blendLinearBurn(float base, float blend) {return max(base+blend-1.0,0.0);} vec3 blendLinearBurn(vec3 base, vec3 blend) {return max(base+blend-vec3(1.0),vec3(0.0));} vec3 blendLinearBurn(vec3 base, vec3 blend, float opacity) {return (blendLinearBurn(base, blend) * opacity + base * (1.0 - opacity));} float blendLinearDodge(float base, float blend) {return min(base+blend,1.0);} vec3 blendLinearDodge(vec3 base, vec3 blend) {return min(base+blend,vec3(1.0));} vec3 blendLinearDodge(vec3 base, vec3 blend, float opacity) {return (blendLinearDodge(base, blend) * opacity + base * (1.0 - opacity));} float blendLinearLight(float base, float blend) {return blend<0.5?blendLinearBurn(base,(2.0*blend)):blendLinearDodge(base,(2.0*(blend-0.5)));} vec3 blendLinearLight(vec3 base, vec3 blend) {return vec3(blendLinearLight(base.r,blend.r),blendLinearLight(base.g,blend.g),blendLinearLight(base.b,blend.b));} vec3 blendLinearLight(vec3 base, vec3 blend, float opacity) {return (blendLinearLight(base, blend) * opacity + base * (1.0 - opacity));}",
        fragment: `varying vec3 v_color;
void main() {
  vec3 color = v_color;
  if (u_darken_top == 1.0) {
    vec2 st = gl_FragCoord.xy / resolution.xy;
    color -= pow(st.y, u_shadow_power) * 0.4;
  }
  gl_FragColor = vec4(color, 1.0);
}`
    };
    this.conf = {
        presetName: "",
        wireframe: false,
        density: [.06, .16],
        zoom: 1,
        rotation: 0,
        playing: true
    };

    if (this.el) {
        this.minigl = new MiniGl(this.el, this.width, this.height, true);
        if (!this.minigl || !this.minigl.gl) {
             console.error("MiniGL initialization failed. Gradient cannot connect.");
             return;
        }
        requestAnimationFrame(() => {
            if (this.el && typeof getComputedStyle === 'function') {
                this.computedCanvasStyle = getComputedStyle(this.el);
                this.waitForCssVars();
            } else if (!this.el) {
                console.error("Canvas element 'el' became undefined before styles could be computed.");
            }
        });
    } else {
      console.error("Canvas element 'el' not set. Gradient cannot connect.");
      return;
    }
  }

  disconnect() {
    if (typeof window !== 'undefined') {
        window.removeEventListener("scroll", this.handleScroll);
        if (this.boundMouseDown) window.removeEventListener("mousedown", this.boundMouseDown);
        if (this.boundMouseUp) window.removeEventListener("mouseup", this.boundMouseUp);
        if (this.boundResize) window.removeEventListener("resize", this.boundResize);
    }
    this.pause();
    if (this.mesh) this.mesh.remove();
  }

  initMaterial() {
    if (!this.minigl || !this.minigl.Uniform) {
        console.error("MiniGL or MiniGL.Uniform not initialized, cannot create material.");
        return null;
    }
    const defaultColor = [1, 0, 1];
    this.uniforms = {
        u_time: new this.minigl.Uniform({ value: 0 }),
        u_shadow_power: new this.minigl.Uniform({ value: 5 }),
        u_darken_top: new this.minigl.Uniform({ value: (this.el && this.el.dataset && this.el.dataset.jsDarkenTop === "") ? 1 : 0 }),
        u_active_colors: new this.minigl.Uniform({ value: this.activeColors, type: "vec4" }),
        u_global: new this.minigl.Uniform({ type: "struct", value: {
            noiseFreq: new this.minigl.Uniform({ value: [this.freqX, this.freqY], type: "vec2" }),
            noiseSpeed: new this.minigl.Uniform({ value: 5e-6 })
        }}),
        u_vertDeform: new this.minigl.Uniform({ type: "struct", excludeFrom: "fragment", value: {
            incline: new this.minigl.Uniform({ value: Math.tan(this.angle) }),
            offsetTop: new this.minigl.Uniform({ value: -0.5 }),
            offsetBottom: new this.minigl.Uniform({ value: -0.5 }),
            noiseFreq: new this.minigl.Uniform({ value: [3, 4], type: "vec2" }),
            noiseAmp: new this.minigl.Uniform({ value: this.amp }),
            noiseSpeed: new this.minigl.Uniform({ value: 10 }),
            noiseFlow: new this.minigl.Uniform({ value: 3 }),
            noiseSeed: new this.minigl.Uniform({ value: this.seed })
        }}),
        u_baseColor: new this.minigl.Uniform({ value: (this.sectionColors && this.sectionColors[0]) || defaultColor, type: "vec3", excludeFrom: "fragment" }),
        u_waveLayers: new this.minigl.Uniform({ value: [], type: "array", excludeFrom: "fragment" })
    };

    if (this.sectionColors && this.sectionColors.length > 0) {
      for (let i = 1; i < this.sectionColors.length; i++) {
          if(this.sectionColors[i]){
            this.uniforms.u_waveLayers.value.push(new this.minigl.Uniform({ type: "struct", value: {
                color: new this.minigl.Uniform({ value: this.sectionColors[i] || defaultColor, type: "vec3" }),
                noiseFreq: new this.minigl.Uniform({ value: [2 + i / this.sectionColors.length, 3 + i / this.sectionColors.length], type: "vec2" }),
                noiseSpeed: new this.minigl.Uniform({ value: 11 + 0.3 * i }),
                noiseFlow: new this.minigl.Uniform({ value: 6.5 + 0.3 * i }),
                noiseSeed: new this.minigl.Uniform({ value: this.seed + 10 * i }),
                noiseFloor: new this.minigl.Uniform({ value: 0.1 }),
                noiseCeil: new this.minigl.Uniform({ value: 0.63 + 0.07 * i })
            }}));
          }
      }
    }
    this.vertexShader = [this.shaderFiles.noise, this.shaderFiles.blend, this.shaderFiles.vertex].join("\n\n");
    return new this.minigl.Material(this.vertexShader, this.shaderFiles.fragment, this.uniforms);
  }

  initMesh() {
    if (!this.minigl) { console.error("MiniGL not initialized for mesh."); return; }
    this.material = this.initMaterial();
    if (!this.material) { console.error("Material not initialized for mesh."); return; }
    this.geometry = new this.minigl.PlaneGeometry(this.width, this.height, this.xSegCount || 1, this.ySegCount || 1); // Pass segment counts
    this.mesh = new this.minigl.Mesh(this.geometry, this.material);
    if (this.conf && this.mesh) this.mesh.wireframe = this.conf.wireframe;
  }

  shouldSkipFrame(timestamp) {
    if (typeof document !== 'undefined' && document.hidden) return true;
    if (!this.conf || !this.conf.playing) return true;
    return false;
  }

  updateFrequency(deltaFreq) {
    this.freqX += deltaFreq;
    this.freqY += deltaFreq;
    if (this.uniforms && this.uniforms.u_global && this.uniforms.u_global.value.noiseFreq) {
        this.uniforms.u_global.value.noiseFreq.value = [this.freqX, this.freqY];
    }
  }

  toggleColor(index) {
    if (this.activeColors[index] !== undefined) {
      this.activeColors[index] = 1 - this.activeColors[index];
    }
    if (this.uniforms && this.uniforms.u_active_colors) {
        this.uniforms.u_active_colors.value = [...this.activeColors];
    }
  }

  showGradientLegend() {
    if (this.width > this.minWidth && typeof document !== 'undefined' && document.body) {
        this.isGradientLegendVisible = true;
        document.body.classList.add("isGradientLegendVisible");
    }
  }

  hideGradientLegend() {
    if (typeof document !== 'undefined' && document.body) {
        this.isGradientLegendVisible = false;
        document.body.classList.remove("isGradientLegendVisible");
    }
  }

  init() {
    if (!this.el || !this.minigl || !this.minigl.gl) {
        console.error("Gradient prerequisites not met for init (el, minigl, or gl context).");
        return;
    }
    this.initGradientColors();
    this.initMesh(); // xSegCount and ySegCount are used here, ensure they are set if needed by PlaneGeometry
    this.resize();

    if (typeof window !== 'undefined') {
        if (this.boundResize) window.removeEventListener("resize", this.boundResize);
        this.boundResize = this.resize;
        window.addEventListener("resize", this.boundResize);

        if (this.el && this.isGradientLegendVisible !== undefined) {
            if (this.boundMouseDown) window.removeEventListener("mousedown", this.boundMouseDown);
            if (this.boundMouseUp) window.removeEventListener("mouseup", this.boundMouseUp);
            this.boundMouseDown = this.handleMouseDown;
            this.boundMouseUp = this.handleMouseUp;
            window.addEventListener("mousedown", this.boundMouseDown);
            window.addEventListener("mouseup", this.boundMouseUp);
        }
    }

    if (this.conf && this.conf.playing) {
        this.play();
    }
    this.addIsLoadedClass();
  }

  waitForCssVars() {
    if (typeof getComputedStyle !== 'function' || !this.el) {
        console.warn("getComputedStyle not available or element missing. Using fallback colors for gradient.");
        this.sectionColors = [0x73b3f2, 0x72aeee, 0x3c8fe5, 0x2675c9].map(normalizeColor);
        this.init();
        return;
    }
    this.computedCanvasStyle = getComputedStyle(this.el);
    const color1 = this.computedCanvasStyle ? this.computedCanvasStyle.getPropertyValue("--gradient-color-1").trim() : "";
    if (color1 && color1.startsWith("#")) {
        this.init();
    } else {
        this.cssVarRetries++;
        if (this.cssVarRetries > this.maxCssVarRetries) {
            console.warn("CSS gradient color variables not found. Using fallback colors.");
            this.sectionColors = [
                normalizeColor(0x73b3f2),
                normalizeColor(0x72aeee),
                normalizeColor(0x3c8fe5),
                normalizeColor(0x2675c9)
            ];
            this.init();
            return;
        }
        requestAnimationFrame(this.waitForCssVars);
    }
  }

  initGradientColors() {
    const defaultFallbackColors = [0x73b3f2, 0x72aeee, 0x3c8fe5, 0x2675c9].map(hexNum => normalizeColor(hexNum));
    if (!this.computedCanvasStyle && typeof getComputedStyle === 'function' && this.el) {
        this.computedCanvasStyle = getComputedStyle(this.el);
    }

    if (!this.computedCanvasStyle) {
        console.warn("Computed style not available for gradient colors. Using hardcoded defaults.");
        this.sectionColors = defaultFallbackColors;
        return;
    }
    const colorVarNames = ["--gradient-color-1", "--gradient-color-2", "--gradient-color-3", "--gradient-color-4"];
    this.sectionColors = colorVarNames.map(varName => {
        let hex = this.computedCanvasStyle.getPropertyValue(varName).trim();
        if (hex && hex.startsWith("#")) {
            if (hex.length === 4) {
                hex = `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
            }
            return normalizeColor(parseInt(hex.substring(1), 16));
        }
        return null;
    }).filter(color => color !== null);

    if (!this.sectionColors || this.sectionColors.length < 4) {
        console.warn("Failed to parse sufficient CSS variables for gradient colors. Using hardcoded defaults or fewer layers.");
        if (!this.sectionColors || this.sectionColors.length === 0) {
            this.sectionColors = defaultFallbackColors;
        }
        while(this.sectionColors.length < 4 && this.sectionColors.length > 0) { // Ensure 4 colors for the shader expecting them
            this.sectionColors.push(defaultFallbackColors[this.sectionColors.length % defaultFallbackColors.length]);
        }
    }
  }

  handleScroll() {
      clearTimeout(this.scrollingTimeout);
      this.scrollingTimeout = setTimeout(this.handleScrollEnd, this.scrollingRefreshDelay);
      if (this.isGradientLegendVisible) this.hideGradientLegend();
      if (this.conf && this.conf.playing) {
          this.isScrolling = true; this.pause();
      }
  }
  handleScrollEnd() {
      this.isScrolling = false;
      if (this.isIntersecting && this.conf && !this.conf.playing) this.play();
  }
  handleMouseDown(event) {
      if (this.isGradientLegendVisible) {
          this.isMetaKey = event.metaKey;
          this.isMouseDown = true;
          if (this.conf && !this.conf.playing) requestAnimationFrame(this.animate);
      }
  }
  handleMouseUp() {
      this.isMouseDown = false;
  }
  animate(timestamp) {
      if (this.shouldSkipFrame(timestamp) && !this.isMouseDown) {
          // Skip frame
      } else {
          if (this.last === 0) this.last = timestamp;
          const delta = timestamp - this.last;
          this.t += Math.min(delta, 1000 / 15);
          this.last = timestamp;

          if (this.isMouseDown) {
              let clickEffectTime = 160;
              if (this.isMetaKey) clickEffectTime = -160;
              this.t += clickEffectTime;
          }
          if (this.mesh && this.mesh.material && this.mesh.material.uniforms.u_time) {
               this.mesh.material.uniforms.u_time.value = this.t;
          }
          if (this.minigl) this.minigl.render();
      }
      const shouldContinueAnimation = (this.isIntersecting && this.conf && this.conf.playing) || this.isMouseDown;
      if (shouldContinueAnimation) {
        requestAnimationFrame(this.animate);
      }
  }
  addIsLoadedClass() {
      if (this.isLoadedClass || !this.el) return;
      this.isLoadedClass = true;
      this.el.classList.add("isLoaded");
      if (this.el.parentElement) {
          setTimeout(() => {
              if (this.el.parentElement) this.el.parentElement.classList.add("isLoaded");
          }, 3000);
      }
  }
  pause() {
      if (this.conf) this.conf.playing = false;
  }
  play() {
      if (this.conf) {
          this.conf.playing = true;
          this.last = 0;
          requestAnimationFrame(this.animate);
      }
  }
  initGradient(selector) {
    if (typeof document === 'undefined') {
        console.error("Document not found. Cannot initialize gradient.");
        return this;
    }
    this.el = document.querySelector(selector);
    if (!this.el) {
      console.error(`Gradient target element "${selector}" not found.`);
      return this;
    }
    if (!this.scrollObserver) { // If scroll observer is not used, assume intersecting
        this.isIntersecting = true;
    }
    this.connect();
    return this;
  }
} // End of Gradient Class

if (typeof window !== 'undefined') {
  window.Gradient = Gradient;
}

})();
