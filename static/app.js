import { MaterialViewer3D } from "./view3d.js?v=11";
import { ClientTextureEngine } from "./client_engine.js";

const clientEngine = new ClientTextureEngine();
let currentBlobs = {};
let hasLoadedTexture = false;

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const dropHint = document.getElementById("dropHint");
const diffuseThumb = document.getElementById("diffuseThumb");
const downloadBtn = document.getElementById("downloadBtn");
const saveCurrentBtn = document.getElementById("saveCurrentBtn");
const statusEl = document.getElementById("status");
const errorBox = document.getElementById("errorBox");
const mainPreview = document.getElementById("mainPreview");
const viewerEmpty = document.getElementById("viewerEmpty");
const liveBadge = document.getElementById("liveBadge");
const viewerLabel = document.getElementById("viewerLabel");
const specsTitle = document.getElementById("specsTitle");
const mapTabs = document.getElementById("mapTabs");
const viewerStage2d = document.getElementById("viewerStage2d");
const viewerStage3d = document.getElementById("viewerStage3d");
const view3dEmpty = document.getElementById("view3dEmpty");
const view3dCanvas = document.getElementById("view3dCanvas");
const shapeBtns = document.getElementById("shapeBtns");
const vpMeshGroup = document.getElementById("vpMeshGroup");
const lightPresetBtns = document.getElementById("lightPresetBtns");
const tilingPresetBtns = document.getElementById("tilingPresetBtns");
const vpTilingGroup = document.getElementById("vpTilingGroup");
const tiledPreview = document.getElementById("tiledPreview");
const seamGridOverlay = document.getElementById("seamGridOverlay");
const seamGridToggle = document.getElementById("seamGridToggle");
const tileBtns = document.getElementById("tileBtns");
const seamlessToggle = document.getElementById("seamless");
const seamlessBody = document.getElementById("seamlessBody");
const seamlessMethodEl = document.getElementById("seamlessMethod");
const seamHint = document.getElementById("seamHint");
const namingPreset = document.getElementById("namingPreset");
const aspectMode = document.getElementById("aspectMode");
const normalFormatSeg = document.getElementById("normalFormatSeg");
const roughnessModeSeg = document.getElementById("roughnessModeSeg");

// Dual-layer wipe elements
const wipeContainer = document.getElementById("wipeContainer");
const wipeLayerTop = document.getElementById("wipeLayerTop");
const wipeDivider = document.getElementById("wipeDivider");
const wipeBottomImg = document.getElementById("wipeBottomImg");
const wipeTopImg = document.getElementById("wipeTopImg");
const wipeLeftBadge = document.getElementById("wipeLeftBadge");
const wipeRightBadge = document.getElementById("wipeRightBadge");
const wipeToggleBtn = document.getElementById("wipeToggleBtn");

let wipeMode = true;
let wipePercentage = 50;
let isDraggingWipe = false;

const METHOD_HINTS = {
  smart: "Smart cut: finds the least visible cut path. Best for stone, brick, wood, fabric.",
  blend: "Soft blend: smooth cross-fade. Best for grass, sand, concrete, noisy surfaces.",
  mirror: "Mirror: always seamless, but shows symmetry. Good for abstract patterns.",
};

const TAB_META = {
  diffuse: { label: "Diffuse / Albedo", title: "Source texture", file: "diffuse.png" },
  normal: { label: "Normal map", title: "Normal map settings", file: "normal.png" },
  height: { label: "Height / Displacement", title: "Height map settings", file: "height.png" },
  roughness: { label: "Roughness map", title: "Roughness map settings", file: "roughness.png" },
  ao: { label: "Ambient Occlusion (AO)", title: "Ambient occlusion settings", file: "ao.png" },
  orm: { label: "Packed ORM (glTF / Unreal)", title: "Packed ORM texture settings", file: "orm.png" },
  view3d: { label: "3D material view", title: "3D view settings", file: null },
};

let activeTab = "normal";
let previewUrls = {};
let selectedFile = null;
let debounceTimer = null;
let fullResTimer = null;
let abortCtrl = null;
let genSeq = 0;
let viewer3d = null;
let currentShape = "plane";
let currentLightPreset = "studio";
let tileCount = 1;
let showSeamGrid = false;
let seamlessMethod = "smart";
let normalFormat = "opengl";
let currentDims = { width: 0, height: 0 };

// ── Tabs ───────────────────────────────────────────
function setActiveTab(tab) {
  if (!TAB_META[tab]) return;
  activeTab = tab;

  mapTabs.querySelectorAll(".tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  });

  document.querySelectorAll(".spec-panel").forEach((panel) => {
    panel.hidden = panel.dataset.panel !== tab;
  });

  const meta = TAB_META[tab];
  specsTitle.textContent = meta.title;
  let resText = "";
  if (currentDims.width > 0 && tab !== "view3d") {
    const kTag = currentDims.width >= 8000 ? " (8K Ultra HD)" : (currentDims.width >= 4000 ? " (4K UHD)" : (currentDims.width >= 2000 ? " (2K)" : ""));
    resText = ` · ${currentDims.width}×${currentDims.height} px${kTag}`;
  }
  viewerLabel.textContent = meta.label + resText;

  const is3d = tab === "view3d";
  viewerStage2d.hidden = is3d;
  viewerStage3d.hidden = !is3d;

  if (is3d) {
    saveCurrentBtn.classList.add("disabled");
    saveCurrentBtn.removeAttribute("href");
    ensure3D();
    refresh3D();
  } else {
    updateMainViewer();
  }
}

mapTabs.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => setActiveTab(btn.dataset.tab));
});

function updateWipeInnerWidth() {
  if (!wipeContainer || wipeContainer.hidden) return;
  const w = wipeContainer.clientWidth || 680;
  if (w > 0 && wipeTopImg) {
    wipeTopImg.style.width = `${w}px`;
  }
}

function setWipePercentage(pct) {
  wipePercentage = Math.max(0, Math.min(100, pct));
  if (wipeLayerTop) wipeLayerTop.style.width = `${wipePercentage}%`;
  if (wipeDivider) {
    wipeDivider.style.left = `${wipePercentage}%`;
    wipeDivider.setAttribute("aria-valuenow", Math.round(wipePercentage));
  }
}

function updateMainViewer({ live = false } = {}) {
  if (activeTab === "view3d") {
    if (wipeContainer) wipeContainer.hidden = true;
    if (wipeToggleBtn) wipeToggleBtn.hidden = true;
    return;
  }

  const url = previewUrls[activeTab];
  if (!url) {
    mainPreview.hidden = true;
    tiledPreview.hidden = true;
    seamGridOverlay.hidden = true;
    if (wipeContainer) wipeContainer.hidden = true;
    if (wipeToggleBtn) wipeToggleBtn.hidden = true;
    viewerEmpty.classList.remove("hidden");
    liveBadge.hidden = true;
    saveCurrentBtn.classList.add("disabled");
    saveCurrentBtn.removeAttribute("href");
    return;
  }

  viewerEmpty.classList.add("hidden");

  const canWipe = Boolean(
    previewUrls.diffuse &&
    activeTab !== "diffuse" &&
    previewUrls[activeTab] &&
    tileCount === 1
  );

  if (wipeToggleBtn) {
    wipeToggleBtn.hidden = !previewUrls.diffuse || activeTab === "diffuse";
    wipeToggleBtn.classList.toggle("active", wipeMode && canWipe);
  }

  if (tileCount > 1) {
    if (wipeContainer) wipeContainer.hidden = true;
    mainPreview.hidden = true;
    tiledPreview.hidden = false;
    tiledPreview.style.backgroundImage = `url("${url}")`;
    tiledPreview.style.backgroundSize = `${100 / tileCount}% ${100 / tileCount}%`;

    // Seam grid overlay
    if (showSeamGrid) {
      seamGridOverlay.hidden = false;
      seamGridOverlay.style.backgroundSize = `${100 / tileCount}% ${100 / tileCount}%`;
    } else {
      seamGridOverlay.hidden = true;
    }
    seamGridToggle.hidden = false;
  } else if (wipeMode && canWipe) {
    // Show Dual-layer Split Wipe View
    mainPreview.hidden = true;
    tiledPreview.hidden = true;
    seamGridOverlay.hidden = true;
    seamGridToggle.hidden = true;
    if (wipeContainer) {
      wipeContainer.hidden = false;
      const diffuseUrl = previewUrls.diffuse;

      wipeBottomImg.src = url;
      wipeTopImg.src = diffuseUrl;

      const tabTitle = TAB_META[activeTab]?.label || activeTab;
      wipeLeftBadge.textContent = "Diffuse";
      wipeRightBadge.textContent = tabTitle.split(" ")[0];

      setWipePercentage(wipePercentage);
      requestAnimationFrame(updateWipeInnerWidth);
    }
  } else {
    // Standard single map preview
    if (wipeContainer) wipeContainer.hidden = true;
    tiledPreview.hidden = true;
    seamGridOverlay.hidden = true;
    seamGridToggle.hidden = true;
    mainPreview.hidden = false;
    mainPreview.src = url;
  }

  liveBadge.hidden = !live;
  saveCurrentBtn.classList.remove("disabled");
  saveCurrentBtn.href = url;
  saveCurrentBtn.download = TAB_META[activeTab]?.file || "map.png";
}

// ── 3D Viewport ────────────────────────────────────
function ensure3D() {
  if (viewer3d) {
    requestAnimationFrame(() => viewer3d._resize());
    return viewer3d;
  }
  viewer3d = new MaterialViewer3D(view3dCanvas);
  viewer3d.setShape(currentShape);
  viewer3d.setEnvironmentPreset(currentLightPreset);
  viewer3d.setNormalScale(document.getElementById("view_normal_scale").value);
  viewer3d.setDisplacementScale(document.getElementById("view_disp_scale").value);
  viewer3d.setMetalness(document.getElementById("view_metalness")?.value || 0);
  viewer3d.setLightIntensity(document.getElementById("view_light").value);
  viewer3d.setAutoRotate(document.getElementById("view_auto_rotate").checked);
  viewer3d.setRepeat(document.getElementById("view_repeat").value);
  return viewer3d;
}

async function refresh3D() {
  if (!viewer3d && activeTab !== "view3d") return;
  if (activeTab === "view3d") ensure3D();
  if (!viewer3d) return;

  const hasAny = previewUrls.diffuse || previewUrls.normal;
  if (!hasAny) {
    view3dEmpty.hidden = false;
    return;
  }
  view3dEmpty.hidden = true;
  try {
    await viewer3d.setMaps(previewUrls);
    viewer3d.setNormalScale(document.getElementById("view_normal_scale").value);
    viewer3d.setDisplacementScale(document.getElementById("view_disp_scale").value);
    viewer3d.setMetalness(document.getElementById("view_metalness")?.value || 0);
    viewer3d.setLightIntensity(document.getElementById("view_light").value);
  } catch (e) {
    console.error("Could not load textures into 3D view:", e);
    showError("Could not load textures into 3D view: " + e.message);
  }
}

// Mesh shape synchronization (sidebar & on-canvas viewport toolbar)
function setShape(shape) {
  currentShape = shape;
  shapeBtns.querySelectorAll(".shape-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.shape === shape);
  });
  if (vpMeshGroup) {
    vpMeshGroup.querySelectorAll(".vp-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.shape === shape);
    });
  }
  if (viewer3d) viewer3d.setShape(shape);
}

shapeBtns.querySelectorAll(".shape-btn").forEach((btn) => {
  btn.addEventListener("click", () => setShape(btn.dataset.shape));
});
if (vpMeshGroup) {
  vpMeshGroup.querySelectorAll(".vp-btn").forEach((btn) => {
    btn.addEventListener("click", () => setShape(btn.dataset.shape));
  });
}

// Lighting preset buttons
function setLightPreset(preset) {
  currentLightPreset = preset;
  if (lightPresetBtns) {
    lightPresetBtns.querySelectorAll(".shape-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.preset === preset);
    });
  }
  if (viewer3d) viewer3d.setEnvironmentPreset(preset);
}

if (lightPresetBtns) {
  lightPresetBtns.querySelectorAll(".shape-btn").forEach((btn) => {
    btn.addEventListener("click", () => setLightPreset(btn.dataset.preset));
  });
}

// Tiling presets for 3D view
function set3DTiling(repeat) {
  const r = Number(repeat) || 1;
  const slider = document.getElementById("view_repeat");
  if (slider) {
    slider.value = r;
    const val = slider.parentElement?.querySelector(".val");
    if (val) val.textContent = String(r);
  }
  if (tilingPresetBtns) {
    tilingPresetBtns.querySelectorAll(".shape-btn").forEach((b) => {
      b.classList.toggle("active", Number(b.dataset.repeat) === r);
    });
  }
  if (vpTilingGroup) {
    vpTilingGroup.querySelectorAll(".vp-btn").forEach((b) => {
      b.classList.toggle("active", Number(b.dataset.repeat) === r);
    });
  }
  if (viewer3d) viewer3d.setRepeat(r);
}

if (tilingPresetBtns) {
  tilingPresetBtns.querySelectorAll(".shape-btn").forEach((btn) => {
    btn.addEventListener("click", () => set3DTiling(btn.dataset.repeat));
  });
}
if (vpTilingGroup) {
  vpTilingGroup.querySelectorAll(".vp-btn").forEach((btn) => {
    btn.addEventListener("click", () => set3DTiling(btn.dataset.repeat));
  });
}

// 3D sliders
function wireViewSlider(id, onInput) {
  const el = document.getElementById(id);
  if (!el) return;
  const val = el.parentElement?.querySelector(".val");
  const sync = () => {
    if (val) val.textContent = Number(el.value).toString();
  };
  el.addEventListener("input", () => {
    sync();
    if (viewer3d) onInput(el.value);
  });
  sync();
}

wireViewSlider("view_repeat", (v) => set3DTiling(v));
wireViewSlider("view_normal_scale", (v) => viewer3d?.setNormalScale(v));
wireViewSlider("view_disp_scale", (v) => viewer3d?.setDisplacementScale(v));
wireViewSlider("view_metalness", (v) => viewer3d?.setMetalness(v));
wireViewSlider("view_light", (v) => viewer3d?.setLightIntensity(v));
document.getElementById("view_auto_rotate")?.addEventListener("change", (e) => {
  viewer3d?.setAutoRotate(e.target.checked);
});

// ── Map sliders & controls: Instant automatic updates ─────────
document.querySelectorAll(".slider input[type=range]").forEach((input) => {
  if (input.id.startsWith("view_")) return;

  const val = input.parentElement?.querySelector(".val");
  const sync = () => {
    if (val) val.textContent = Number(input.value).toString();
  };
  input.addEventListener("input", () => {
    sync();
    scheduleLivePreview();
  });
  input.addEventListener("change", () => scheduleFullGenerate());
  input.addEventListener("mouseup", () => scheduleFullGenerate());
  input.addEventListener("touchend", () => scheduleFullGenerate());
  sync();
});

// Dropdowns: Instant automatic update
["roughness_method", "maxSize", "aspectMode", "orm_pack_blue"].forEach((id) => {
  const el = document.getElementById(id);
  if (el) el.addEventListener("change", () => scheduleFullGenerate());
});

// Checkboxes: Instant automatic update
[
  "height_invert",
  "normal_invert_x",
  "normal_invert_y",
  "roughness_invert",
  "include_ao",
].forEach((id) => {
  const el = document.getElementById(id);
  if (el) el.addEventListener("change", () => scheduleFullGenerate());
});

// Normal Format segmented button (OpenGL vs DirectX)
if (normalFormatSeg) {
  normalFormatSeg.querySelectorAll(".seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      normalFormat = btn.dataset.format;
      normalFormatSeg.querySelectorAll(".seg-btn").forEach((b) => {
        b.classList.toggle("active", b === btn);
      });
      const invertY = document.getElementById("normal_invert_y");
      if (invertY) {
        invertY.checked = normalFormat === "opengl";
      }
      scheduleFullGenerate();
    });
  });
}

// Roughness Mode (PBR Roughness vs Inverted Glossiness)
if (roughnessModeSeg) {
  roughnessModeSeg.querySelectorAll(".seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const isInvert = btn.dataset.invert === "true";
      roughnessModeSeg.querySelectorAll(".seg-btn").forEach((b) => {
        b.classList.toggle("active", b === btn);
      });
      const invertBox = document.getElementById("roughness_invert");
      if (invertBox) invertBox.checked = isInvert;
      scheduleFullGenerate();
    });
  });
}

// ── Seamless + 2D Tile Preview ─────────────────────
function syncSeamlessUI() {
  seamlessBody.classList.toggle("is-off", !seamlessToggle.checked);
  seamHint.textContent = METHOD_HINTS[seamlessMethod];
  document.getElementById("seamless_blend").closest(".slider").hidden = seamlessMethod === "mirror";
}

seamlessToggle.addEventListener("change", () => {
  syncSeamlessUI();
  if (seamlessToggle.checked && tileCount === 1) setTileCount(2);
  scheduleFullGenerate();
});

seamlessMethodEl.querySelectorAll(".seg-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    seamlessMethod = btn.dataset.method;
    seamlessMethodEl.querySelectorAll(".seg-btn").forEach((b) => b.classList.toggle("active", b === btn));
    syncSeamlessUI();
    if (seamlessToggle.checked) scheduleFullGenerate();
  });
});

function setTileCount(n) {
  tileCount = n;
  tileBtns.querySelectorAll(".seg-btn").forEach((b) => {
    b.classList.toggle("active", Number(b.dataset.tile) === n);
  });
  updateMainViewer();
}

tileBtns.querySelectorAll(".seg-btn").forEach((btn) => {
  btn.addEventListener("click", () => setTileCount(Number(btn.dataset.tile)));
});

// Seam Grid line toggle
if (seamGridToggle) {
  seamGridToggle.addEventListener("click", () => {
    showSeamGrid = !showSeamGrid;
    seamGridToggle.classList.toggle("active", showSeamGrid);
    updateMainViewer();
  });
}

// ── Wipe Split Comparison Interaction ───────────────
function handleWipeMove(clientX) {
  if (!wipeContainer) return;
  const rect = wipeContainer.getBoundingClientRect();
  if (rect.width <= 0) return;
  const pct = ((clientX - rect.left) / rect.width) * 100;
  setWipePercentage(pct);
}

if (wipeContainer && wipeDivider) {
  wipeDivider.addEventListener("pointerdown", (e) => {
    isDraggingWipe = true;
    wipeDivider.classList.add("is-dragging");
    try {
      wipeDivider.setPointerCapture(e.pointerId);
    } catch (_) {}
    handleWipeMove(e.clientX);
    e.preventDefault();
  });

  wipeDivider.addEventListener("pointermove", (e) => {
    if (!isDraggingWipe) return;
    handleWipeMove(e.clientX);
  });

  const stopWipeDrag = (e) => {
    if (!isDraggingWipe) return;
    isDraggingWipe = false;
    wipeDivider.classList.remove("is-dragging");
    try {
      if (e && e.pointerId) wipeDivider.releasePointerCapture(e.pointerId);
    } catch (_) {}
  };

  wipeDivider.addEventListener("pointerup", stopWipeDrag);
  wipeDivider.addEventListener("pointercancel", stopWipeDrag);

  wipeContainer.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".wipe-divider")) return;
    isDraggingWipe = true;
    wipeDivider.classList.add("is-dragging");
    try {
      wipeDivider.setPointerCapture(e.pointerId);
    } catch (_) {}
    handleWipeMove(e.clientX);
  });

  window.addEventListener("mousemove", (e) => {
    if (isDraggingWipe) handleWipeMove(e.clientX);
  });
  window.addEventListener("mouseup", () => {
    if (isDraggingWipe) {
      isDraggingWipe = false;
      wipeDivider.classList.remove("is-dragging");
    }
  });

  wipeContainer.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches && e.touches[0]) {
        isDraggingWipe = true;
        wipeDivider.classList.add("is-dragging");
        handleWipeMove(e.touches[0].clientX);
      }
    },
    { passive: true }
  );

  window.addEventListener(
    "touchmove",
    (e) => {
      if (isDraggingWipe && e.touches && e.touches[0]) {
        handleWipeMove(e.touches[0].clientX);
      }
    },
    { passive: true }
  );

  window.addEventListener("touchend", () => {
    if (isDraggingWipe) {
      isDraggingWipe = false;
      wipeDivider.classList.remove("is-dragging");
    }
  });
  window.addEventListener("touchcancel", () => {
    if (isDraggingWipe) {
      isDraggingWipe = false;
      wipeDivider.classList.remove("is-dragging");
    }
  });

  wipeDivider.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") {
      setWipePercentage(wipePercentage - 3);
      e.preventDefault();
    } else if (e.key === "ArrowRight") {
      setWipePercentage(wipePercentage + 3);
      e.preventDefault();
    } else if (e.key === "Home") {
      setWipePercentage(0);
      e.preventDefault();
    } else if (e.key === "End") {
      setWipePercentage(100);
      e.preventDefault();
    }
  });

  if (window.ResizeObserver) {
    new ResizeObserver(() => updateWipeInnerWidth()).observe(wipeContainer);
  }
  window.addEventListener("resize", updateWipeInnerWidth);
}

// Wipe Split toggle button in viewer footer
if (wipeToggleBtn) {
  wipeToggleBtn.addEventListener("click", () => {
    wipeMode = !wipeMode;
    wipeToggleBtn.classList.toggle("active", wipeMode);
    if (wipeMode && tileCount > 1) {
      setTileCount(1);
    }
    updateMainViewer();
  });
}

syncSeamlessUI();

function canGenerate() {
  return Boolean(selectedFile || clientEngine.masterImage || hasLoadedTexture);
}

function scheduleLivePreview() {
  if (!canGenerate()) return;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => generate({ preview: true }), 60);
}

function scheduleFullGenerate() {
  if (!canGenerate()) return;
  clearTimeout(debounceTimer);
  clearTimeout(fullResTimer);
  fullResTimer = setTimeout(() => generate({ preview: false }), 90);
}

function showError(msg) {
  if (!msg) {
    errorBox.classList.remove("visible");
    errorBox.textContent = "";
    return;
  }
  if (msg === "AbortError" || msg.includes("aborted")) return;
  errorBox.textContent = msg;
  errorBox.classList.add("visible");
}

// ── Upload & Image Handling ─────────────────────────
function setFile(file) {
  if (!file || !file.type.startsWith("image/")) {
    showError("Please choose an image file (PNG, JPG, WebP, etc.).");
    return;
  }
  if (file.size > 50 * 1024 * 1024) {
    showError(`Image file (${(file.size / (1024 * 1024)).toFixed(1)}MB) exceeds the limit. Please choose an image under 50MB.`);
    return;
  }
  selectedFile = file;
  const url = URL.createObjectURL(file);
  diffuseThumb.src = url;
  diffuseThumb.hidden = false;
  dropHint.hidden = true;
  showError("");
  statusEl.textContent = `Loaded: ${file.name}`;
  // Automatic regeneration starts immediately on drop/selection!
  generate({ preview: false });
}

dropzone.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  if (fileInput.files?.[0]) setFile(fileInput.files[0]);
});
["dragenter", "dragover"].forEach((ev) => {
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  });
});
["dragleave", "drop"].forEach((ev) => {
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
  });
});
dropzone.addEventListener("drop", (e) => {
  const f = e.dataTransfer?.files?.[0];
  if (f) setFile(f);
});

function collectOptions({ preview = false } = {}) {
  const maxSize = document.getElementById("maxSize")?.value || "2048";
  return {
    height_strength: Number(document.getElementById("height_strength")?.value ?? 1.0),
    height_blur: Number(document.getElementById("height_blur")?.value ?? 0.5),
    height_contrast: Number(document.getElementById("height_contrast")?.value ?? 1.0),
    height_invert: Boolean(document.getElementById("height_invert")?.checked),
    height_level: Number(document.getElementById("height_level")?.value ?? 0.0),
    normal_strength: Number(document.getElementById("normal_strength")?.value ?? 2.0),
    normal_macro_detail: Number(document.getElementById("normal_macro_detail")?.value ?? 0.35),
    normal_blur: Number(document.getElementById("normal_blur")?.value ?? 0.0),
    normal_format: normalFormat,
    normal_invert_x: Boolean(document.getElementById("normal_invert_x")?.checked),
    normal_invert_y: Boolean(document.getElementById("normal_invert_y")?.checked),
    roughness_strength: Number(document.getElementById("roughness_strength")?.value ?? 1.0),
    roughness_base: Number(document.getElementById("roughness_base")?.value ?? 0.5),
    roughness_min: Number(document.getElementById("roughness_min")?.value ?? 0.0),
    roughness_max: Number(document.getElementById("roughness_max")?.value ?? 1.0),
    roughness_blur: Number(document.getElementById("roughness_blur")?.value ?? 1.5),
    roughness_contrast: Number(document.getElementById("roughness_contrast")?.value ?? 1.0),
    roughness_invert: Boolean(document.getElementById("roughness_invert")?.checked),
    roughness_method: document.getElementById("roughness_method")?.value || "variance",
    include_ao: Boolean(document.getElementById("include_ao")?.checked),
    ao_strength: Number(document.getElementById("ao_strength")?.value ?? 1.0),
    ao_blur: Number(document.getElementById("ao_blur")?.value ?? 2.0),
    ao_exponent: Number(document.getElementById("ao_exponent")?.value ?? 1.2),
    delight: Number(document.getElementById("delight")?.value ?? 0.0),
    seamless: Boolean(seamlessToggle.checked),
    seamless_method: seamlessMethod,
    seamless_blend: Number(document.getElementById("seamless_blend")?.value ?? 0.25),
    seamless_equalize: Number(document.getElementById("seamless_equalize")?.value ?? 0.0),
    aspect_mode: aspectMode?.value || "keep",
    orm_pack_blue: document.getElementById("orm_pack_blue")?.value || "metallic",
    max_size: preview ? Math.min(1024, Number(maxSize) || 1024) : Number(maxSize || 2048),
  };
}

// ── Automatic Core Map Generator ────────────────────────
async function generate({ preview = false } = {}) {
  const source = selectedFile || clientEngine.masterImage;
  if (!source) return;

  if (abortCtrl) {
    try {
      abortCtrl.abort();
    } catch (_) {}
  }
  const controller = new AbortController();
  abortCtrl = controller;
  const mySeq = ++genSeq;

  showError("");
  statusEl.textContent = preview ? "Updating…" : "Generating maps…";
  statusEl.classList.toggle("live", preview);

  try {
    const opts = collectOptions({ preview });
    const result = await clientEngine.generateAllMaps(source, opts);

    if (mySeq !== genSeq) return;

    previewUrls = result.previews || {};
    currentBlobs = result.blobs || {};
    hasLoadedTexture = true;

    currentDims = { width: result.width, height: result.height };
    const kTag = result.width >= 8000 ? " (8K Ultra HD)" : (result.width >= 4000 ? " (4K UHD)" : (result.width >= 2000 ? " (2K)" : ""));
    const resText = ` · ${result.width}×${result.height} px${kTag}`;
    if (activeTab !== "view3d") {
      viewerLabel.textContent = TAB_META[activeTab].label + resText;
    }

    if (viewer3d) {
      viewer3d.setAspectRatio(result.width / Math.max(1, result.height));
    }

    if (activeTab === "view3d") {
      await refresh3D();
    } else {
      updateMainViewer({ live: preview });
    }

    if (viewer3d && activeTab !== "view3d") {
      refresh3D();
    }

    if (!preview) {
      downloadBtn.classList.remove("disabled");
    }

    statusEl.textContent = preview
      ? `Live · ${result.width}×${result.height}`
      : `Done · ${result.width}×${result.height} · ZIP ready`;
  } catch (err) {
    if (
      controller.signal.aborted ||
      err.name === "AbortError" ||
      err.message?.includes("aborted") ||
      err.message?.includes("abort")
    ) {
      return;
    }
    if (mySeq !== genSeq) return;
    console.error("Texture generation error:", err);
    showError(err.message || "Texture calculation error");
    statusEl.textContent = "Error · Adjust slider or re-drop image";
  } finally {
    if (mySeq === genSeq) {
      statusEl.classList.remove("live");
    }
  }
}

// ── Client-Side ZIP Download Handler (100% offline & zero API calls) ──
downloadBtn.addEventListener("click", async (e) => {
  e.preventDefault();
  if (!currentBlobs || !currentBlobs.diffuse) return;

  const preset = namingPreset?.value || "standard";
  statusEl.textContent = "Packaging ZIP…";
  try {
    const zipBlob = await clientEngine.buildPresetZip(currentBlobs, preset);
    const url = URL.createObjectURL(zipBlob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `pbr_textures_${preset}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    statusEl.textContent = `Downloaded pbr_textures_${preset}.zip (${(zipBlob.size / (1024 * 1024)).toFixed(2)} MB)`;
  } catch (err) {
    console.error(err);
    showError("ZIP creation error: " + err.message);
  }
});

// ── Direct Clipboard Paste (Ctrl+V / Cmd+V anywhere on page) ──
window.addEventListener("paste", (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (let i = 0; i < items.length; i++) {
    if (items[i].type.indexOf("image") !== -1) {
      const blob = items[i].getAsFile();
      if (blob) {
        const file = new File([blob], `clipboard-${Date.now()}.png`, { type: blob.type || "image/png" });
        setFile(file);
        break;
      }
    }
  }
});

// ── Initial Sample Texture Bootstrap ───────────────
async function initSampleTexture() {
  statusEl.textContent = "Loading studio texture…";
  try {
    const sampleCanvas = clientEngine.createSampleDiffuse(1024);
    clientEngine.masterImage = sampleCanvas;
    diffuseThumb.src = sampleCanvas.toDataURL("image/png");
    diffuseThumb.hidden = false;
    dropHint.hidden = true;
    hasLoadedTexture = true;
    await generate({ preview: false });
  } catch (err) {
    console.warn("Could not load initial sample texture:", err);
  }
}

// ── About Modal ────────────────────────────────────
const aboutModal = document.getElementById("aboutModal");
const aboutBtn = document.getElementById("aboutBtn");
const footerAboutBtn = document.getElementById("footerAboutBtn");
const closeAboutBtn = document.getElementById("closeAboutBtn");
const dismissAboutBtn = document.getElementById("dismissAboutBtn");

function openAbout() {
  if (aboutModal) {
    aboutModal.hidden = false;
    document.body.style.overflow = "hidden";
  }
}

function closeAbout() {
  if (aboutModal) {
    aboutModal.hidden = true;
    document.body.style.overflow = "";
  }
}

aboutBtn?.addEventListener("click", openAbout);
footerAboutBtn?.addEventListener("click", openAbout);
closeAboutBtn?.addEventListener("click", closeAbout);
dismissAboutBtn?.addEventListener("click", closeAbout);

aboutModal?.addEventListener("click", (e) => {
  if (e.target === aboutModal) {
    closeAbout();
  }
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && aboutModal && !aboutModal.hidden) {
    closeAbout();
  }
});

setActiveTab("normal");
initSampleTexture();
