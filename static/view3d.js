/**
 * Three.js PBR Material Viewer
 * Supports: Plane, Cube, Cylinder, Quad Sphere (pinch-free), and Shader Ball.
 * Multiple lighting environments, UV tiling scale, displacement, normal scale, and specular tuning.
 */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

export class MaterialViewer3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.shape = "plane";
    this.mesh = null;
    this.material = null;
    this.textures = {};
    this.repeat = 1;
    this.aspectRatio = 1.0;
    this.ready = false;
    this.lightPreset = "studio";

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a100c);

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.05, 50);
    this.camera.position.set(0.9, 0.65, 1.35);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.target.set(0, 0, 0);
    this.controls.autoRotate = false;
    this.controls.autoRotateSpeed = 1.2;

    // Lights
    this.amb = new THREE.AmbientLight(0xffffff, 0.5);
    this.key = new THREE.DirectionalLight(0xffffff, 1.2);
    this.key.position.set(2.5, 3.5, 2.0);
    this.fill = new THREE.DirectionalLight(0xa7f3d0, 0.4);
    this.fill.position.set(-2.0, 1.0, -1.5);
    this.rim = new THREE.DirectionalLight(0x38bdf8, 0.35);
    this.rim.position.set(0.0, -2.0, -2.5);
    this.scene.add(this.amb, this.key, this.fill, this.rim);

    // Soft ground grid
    const grid = new THREE.GridHelper(4, 16, 0x1a3d2e, 0x12241c);
    grid.position.y = -0.68;
    this.scene.add(grid);

    this.material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 1.0,
      metalness: 0.0,
      side: THREE.DoubleSide,
    });

    this._setShape("plane");
    this.ready = true;
    this._resize();
    this._animate = this._animate.bind(this);
    this._raf = requestAnimationFrame(this._animate);

    this._ro = new ResizeObserver(() => this._resize());
    if (canvas.parentElement) this._ro.observe(canvas.parentElement);
  }

  _animate() {
    this._raf = requestAnimationFrame(this._animate);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  _resize() {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const w = parent.clientWidth || 512;
    const h = parent.clientHeight || 512;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(h, 1);
    this.camera.updateProjectionMatrix();
  }

  setShape(shape) {
    if (shape === this.shape && this.mesh) return;
    this._setShape(shape);
  }

  /**
   * Builds a Quad-Sphere by subdividing a cube and normalizing each vertex to a sphere radius.
   * Completely avoids polar pinching and spiral wedge UV distortion!
   */
  _createQuadSphereGeometry(radius = 0.72, segments = 48) {
    const geo = new THREE.BoxGeometry(1, 1, 1, segments, segments, segments);
    const pos = geo.attributes.position;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      v.normalize().multiplyScalar(radius);
      pos.setXYZ(i, v.x, v.y, v.z);
    }
    geo.computeVertexNormals();
    return geo;
  }

  /**
   * Creates a comprehensive procedural Shader Ball / Material Test model
   * with flat angled inspection face, curved dome, recessed crevice, and base stand.
   */
  _createShaderBall() {
    const group = new THREE.Group();

    // 1. Core Sphere (inner test sphere)
    const coreGeo = this._createQuadSphereGeometry(0.48, 32);
    if (!coreGeo.attributes.uv2 && coreGeo.attributes.uv) {
      coreGeo.setAttribute("uv2", coreGeo.attributes.uv);
    }
    const coreMesh = new THREE.Mesh(coreGeo, this.material);
    group.add(coreMesh);

    // 2. Outer Shield / Shell with open angle (cut sphere)
    const outerGeo = new THREE.SphereGeometry(0.72, 64, 48, 0, Math.PI * 1.55, 0, Math.PI * 0.85);
    if (!outerGeo.attributes.uv2 && outerGeo.attributes.uv) {
      outerGeo.setAttribute("uv2", outerGeo.attributes.uv);
    }
    const outerMesh = new THREE.Mesh(outerGeo, this.material);
    outerMesh.rotation.y = Math.PI * 0.2;
    group.add(outerMesh);

    // 3. Flat Inspection Plate (chamfered cylinder disc angled at 45° to catch grazing light)
    const discGeo = new THREE.CylinderGeometry(0.32, 0.32, 0.08, 36);
    if (!discGeo.attributes.uv2 && discGeo.attributes.uv) {
      discGeo.setAttribute("uv2", discGeo.attributes.uv);
    }
    const discMesh = new THREE.Mesh(discGeo, this.material);
    discMesh.position.set(0.38, 0.15, 0.38);
    discMesh.rotation.x = Math.PI * 0.3;
    discMesh.rotation.z = -Math.PI * 0.25;
    group.add(discMesh);

    // 4. Pedestal Stand
    const standGeo = new THREE.CylinderGeometry(0.45, 0.65, 0.22, 48);
    if (!standGeo.attributes.uv2 && standGeo.attributes.uv) {
      standGeo.setAttribute("uv2", standGeo.attributes.uv);
    }
    const standMesh = new THREE.Mesh(standGeo, this.material);
    standMesh.position.y = -0.58;
    group.add(standMesh);

    // 5. Collar Ring (crevice detail for AO testing)
    const ringGeo = new THREE.TorusGeometry(0.52, 0.06, 24, 48);
    if (!ringGeo.attributes.uv2 && ringGeo.attributes.uv) {
      ringGeo.setAttribute("uv2", ringGeo.attributes.uv);
    }
    const ringMesh = new THREE.Mesh(ringGeo, this.material);
    ringMesh.rotation.x = Math.PI / 2;
    ringMesh.position.y = -0.48;
    group.add(ringMesh);

    return group;
  }

  _setShape(shape) {
    this.shape = shape;
    if (this.mesh) {
      this.scene.remove(this.mesh);
      if (this.mesh.isGroup) {
        this.mesh.traverse((c) => {
          if (c.geometry) c.geometry.dispose();
        });
      } else {
        this.mesh.geometry?.dispose();
      }
      this.mesh = null;
    }

    let obj;
    if (shape === "cube") {
      const geo = new THREE.BoxGeometry(1.1, 1.1, 1.1, 64, 64, 64);
      if (!geo.attributes.uv2 && geo.attributes.uv) geo.setAttribute("uv2", geo.attributes.uv);
      obj = new THREE.Mesh(geo, this.material);
    } else if (shape === "cylinder") {
      // Cylinder for inspecting radial wrapping
      const geo = new THREE.CylinderGeometry(0.55, 0.55, 1.25, 64, 64, false);
      if (!geo.attributes.uv2 && geo.attributes.uv) geo.setAttribute("uv2", geo.attributes.uv);
      obj = new THREE.Mesh(geo, this.material);
    } else if (shape === "shaderball") {
      obj = this._createShaderBall();
    } else if (shape === "sphere") {
      // Quad Sphere without pole pinching!
      const geo = this._createQuadSphereGeometry(0.72, 48);
      if (!geo.attributes.uv2 && geo.attributes.uv) geo.setAttribute("uv2", geo.attributes.uv);
      obj = new THREE.Mesh(geo, this.material);
    } else {
      // plane - adapt dimensions to texture aspect ratio if non-square
      const aspect = this.aspectRatio || 1.0;
      let w = 1.4;
      let h = 1.4;
      if (aspect > 1.0) {
        h = 1.4 / aspect;
      } else if (aspect < 1.0) {
        w = 1.4 * aspect;
      }
      const geo = new THREE.PlaneGeometry(w, h, 128, 128);
      if (!geo.attributes.uv2 && geo.attributes.uv) geo.setAttribute("uv2", geo.attributes.uv);
      obj = new THREE.Mesh(geo, this.material);
      obj.rotation.x = -Math.PI * 0.12;
    }

    this.mesh = obj;
    this.scene.add(this.mesh);

    // Frame camera appropriately
    this.controls.target.set(0, 0, 0);
    if (shape === "plane") {
      this.camera.position.set(0, 0.55, 1.6);
    } else if (shape === "cube") {
      this.camera.position.set(1.15, 0.9, 1.25);
    } else if (shape === "cylinder") {
      this.camera.position.set(1.0, 0.65, 1.4);
    } else if (shape === "shaderball") {
      this.camera.position.set(1.05, 0.6, 1.35);
    } else {
      this.camera.position.set(0.95, 0.55, 1.35);
    }
    this.controls.update();
  }

  setAspectRatio(ratio) {
    if (!ratio || Math.abs(ratio - this.aspectRatio) < 0.01) return;
    this.aspectRatio = ratio;
    if (this.shape === "plane") {
      this._setShape("plane");
    }
  }

  setAutoRotate(on) {
    this.controls.autoRotate = Boolean(on);
  }

  setLightIntensity(v) {
    const n = Number(v) || 1;
    this.key.intensity = 1.2 * n;
    this.amb.intensity = 0.45 * n;
    this.fill.intensity = 0.35 * n;
    this.rim.intensity = 0.3 * n;
    this.renderer.toneMappingExposure = 0.85 + n * 0.15;
  }

  setEnvironmentPreset(preset) {
    this.lightPreset = preset;
    if (preset === "warm") {
      // Exterior Warm: golden sun + soft blue ambient
      this.scene.background = new THREE.Color(0x11161a);
      this.amb.color.setHex(0xbfe0f7);
      this.amb.intensity = 0.5;
      this.key.color.setHex(0xfef08a);
      this.key.intensity = 1.6;
      this.key.position.set(3.0, 4.0, 2.0);
      this.fill.color.setHex(0xfed7aa);
      this.fill.intensity = 0.4;
      this.rim.color.setHex(0x93c5fd);
      this.rim.intensity = 0.5;
    } else if (preset === "overcast") {
      // Overcast: diffused ambient, soft shadowless lighting
      this.scene.background = new THREE.Color(0x131a17);
      this.amb.color.setHex(0xf1f5f9);
      this.amb.intensity = 0.85;
      this.key.color.setHex(0xe2e8f0);
      this.key.intensity = 0.7;
      this.key.position.set(0.5, 5.0, 0.5);
      this.fill.color.setHex(0xcbd5e1);
      this.fill.intensity = 0.3;
      this.rim.color.setHex(0x94a3b8);
      this.rim.intensity = 0.2;
    } else if (preset === "dramatic") {
      // Dramatic Rim / Grazing: sharp low-angle light highlights displacement & normal maps
      this.scene.background = new THREE.Color(0x060907);
      this.amb.color.setHex(0x334155);
      this.amb.intensity = 0.25;
      this.key.color.setHex(0xffffff);
      this.key.intensity = 1.9;
      this.key.position.set(3.5, 0.7, 1.5); // Grazing low-angle light
      this.fill.color.setHex(0x10b981);
      this.fill.intensity = 0.25;
      this.rim.color.setHex(0x38bdf8);
      this.rim.intensity = 1.1;
      this.rim.position.set(-3.0, 2.0, -2.5);
    } else {
      // Studio Neutral (default)
      this.scene.background = new THREE.Color(0x0a100c);
      this.amb.color.setHex(0xffffff);
      this.amb.intensity = 0.5;
      this.key.color.setHex(0xffffff);
      this.key.intensity = 1.2;
      this.key.position.set(2.5, 3.5, 2.0);
      this.fill.color.setHex(0xa7f3d0);
      this.fill.intensity = 0.4;
      this.rim.color.setHex(0x38bdf8);
      this.rim.intensity = 0.35;
      this.rim.position.set(0.0, -2.0, -2.5);
    }
  }

  setRepeat(v) {
    const n = Math.max(1, Number(v) || 1);
    this.repeat = n;
    Object.values(this.textures).forEach((t) => {
      if (t) {
        t.repeat.set(n, n);
        t.needsUpdate = true;
      }
    });
  }

  setNormalScale(v) {
    const s = Number(v) || 1;
    this.material.normalScale.set(s, s);
    this.material.needsUpdate = true;
  }

  setDisplacementScale(v) {
    const s = Number(v) || 0;
    this.material.displacementScale = s;
    this.material.displacementBias = -0.5 * s;
    this.material.needsUpdate = true;
  }

  setMetalness(v) {
    this.material.metalness = Math.max(0.0, Math.min(1.0, Number(v) || 0.0));
    this.material.needsUpdate = true;
  }

  async setMaps(urls) {
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin("anonymous");

    const load = (url, { srgb = false } = {}) =>
      new Promise((resolve, reject) => {
        if (!url) return resolve(null);
        const bust = url.includes("?") ? `&v=${Date.now()}` : `?v=${Date.now()}`;
        loader.load(
          url + bust,
          (tex) => {
            tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
            tex.repeat.set(this.repeat, this.repeat);
            tex.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy?.() || 1);
            if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
            resolve(tex);
          },
          undefined,
          reject
        );
      });

    const [diff, norm, height, rough, ao] = await Promise.all([
      load(urls.diffuse, { srgb: true }),
      load(urls.normal),
      load(urls.height),
      load(urls.roughness),
      load(urls.ao),
    ]);

    // Dispose old textures
    Object.values(this.textures).forEach((t) => t && t.dispose());
    this.textures = { diff, norm, height, rough, ao };

    this.material.map = diff;
    this.material.normalMap = norm;
    this.material.roughnessMap = rough;
    this.material.roughness = 1.0;
    this.material.aoMap = ao;
    this.material.aoMapIntensity = ao ? 1.0 : 0.0;
    this.material.displacementMap = height;
    this.material.needsUpdate = true;
  }

  dispose() {
    cancelAnimationFrame(this._raf);
    this._ro?.disconnect();
    Object.values(this.textures).forEach((t) => t && t.dispose());
    if (this.mesh) {
      if (this.mesh.isGroup) {
        this.mesh.traverse((c) => c.geometry?.dispose());
      } else {
        this.mesh.geometry?.dispose();
      }
    }
    this.material?.dispose();
    this.renderer.dispose();
  }
}
