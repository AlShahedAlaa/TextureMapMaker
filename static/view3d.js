/** Three.js PBR material viewer — plane / cube / sphere */
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
    this.ready = false;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
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
    this.controls.target.set(0, 0, 0);
    this.controls.autoRotate = false;
    this.controls.autoRotateSpeed = 1.2;

    this.amb = new THREE.AmbientLight(0xffffff, 0.45);
    this.key = new THREE.DirectionalLight(0xffffff, 1.1);
    this.key.position.set(2.5, 3.5, 2);
    this.fill = new THREE.DirectionalLight(0xa7f3d0, 0.35);
    this.fill.position.set(-2, 1, -1.5);
    this.scene.add(this.amb, this.key, this.fill);

    // soft ground grid (subtle)
    const grid = new THREE.GridHelper(4, 16, 0x1a3d2e, 0x12241c);
    grid.position.y = -0.65;
    this.scene.add(grid);

    this.material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 1,
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

  _setShape(shape) {
    this.shape = shape;
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh = null;
    }

    let geo;
    if (shape === "cube") {
      geo = new THREE.BoxGeometry(1.1, 1.1, 1.1, 64, 64, 64);
    } else if (shape === "sphere") {
      geo = new THREE.SphereGeometry(0.72, 96, 64);
    } else {
      // plane
      geo = new THREE.PlaneGeometry(1.4, 1.4, 128, 128);
    }

    // aoMap needs uv2
    if (geo.attributes.uv && !geo.attributes.uv2) {
      geo.setAttribute("uv2", geo.attributes.uv);
    }

    this.mesh = new THREE.Mesh(geo, this.material);
    if (shape === "plane") {
      this.mesh.rotation.x = -Math.PI * 0.12;
    }
    this.scene.add(this.mesh);

    // frame camera a bit
    this.controls.target.set(0, 0, 0);
    if (shape === "plane") {
      this.camera.position.set(0, 0.55, 1.6);
    } else if (shape === "cube") {
      this.camera.position.set(1.15, 0.9, 1.25);
    } else {
      this.camera.position.set(0.95, 0.55, 1.35);
    }
    this.controls.update();
  }

  setAutoRotate(on) {
    this.controls.autoRotate = !!on;
  }

  setLightIntensity(v) {
    const n = Number(v) || 1;
    this.key.intensity = n;
    this.amb.intensity = 0.35 * n;
    this.fill.intensity = 0.3 * n;
    this.renderer.toneMappingExposure = 0.85 + n * 0.15;
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
    this.material.displacementScale = Number(v) || 0;
    this.material.displacementBias = -0.5 * (Number(v) || 0);
    this.material.needsUpdate = true;
  }

  async setMaps(urls) {
    // urls: { diffuse, normal, height, roughness, ao }
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin("anonymous");

    const load = (url, { srgb = false, colorSpace = null } = {}) =>
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
            if (colorSpace) tex.colorSpace = colorSpace;
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

    // dispose old
    Object.values(this.textures).forEach((t) => t && t.dispose());
    this.textures = { diff, norm, height, rough, ao };

    this.material.map = diff;
    this.material.normalMap = norm;
    this.material.roughnessMap = rough;
    this.material.roughness = 1;
    this.material.metalness = 0.05;
    this.material.aoMap = ao;
    this.material.aoMapIntensity = ao ? 1.0 : 0;
    this.material.displacementMap = height;
    // keep current scales from UI
    this.material.needsUpdate = true;
  }

  dispose() {
    cancelAnimationFrame(this._raf);
    this._ro?.disconnect();
    Object.values(this.textures).forEach((t) => t && t.dispose());
    if (this.mesh) {
      this.mesh.geometry.dispose();
    }
    this.material?.dispose();
    this.renderer.dispose();
  }
}
