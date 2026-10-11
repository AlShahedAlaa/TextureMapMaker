import { MaterialViewer3D } from "./view3d.js?v=8";

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const dropHint = document.getElementById("dropHint");
const diffuseThumb = document.getElementById("diffuseThumb");
const generateBtn = document.getElementById("generateBtn");
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
const tiledPreview = document.getElementById("tiledPreview");
const tileBtns = document.getElementById("tileBtns");
const seamlessToggle = document.getElementById("seamless");
const seamlessBody = document.getElementById("seamlessBody");
const seamlessMethodEl = document.getElementById("seamlessMethod");
const seamHint = document.getElementById("seamHint");

const METHOD_HINTS = {
  smart: "Smart cut: finds the least visible cut path. Best for stone, brick, wood, fabric.",
  blend: "Soft blend: smooth cross-fade. Best for grass, sand, concrete, noisy surfaces.",
  mirror: "Mirror: always seamless, but shows symmetry. Good for abstract patterns.",
};

const TAB_META = {
  diffuse: { label: "Diffuse", title: "Source texture", file: "diffuse.png" },
  normal: { label: "Normal map", title: "Normal map settings", file: "normal.png" },
  height: { label: "Height map", title: "Height map settings", file: "height.png" },
  roughness: { label: "Roughness map", title: "Roughness map settings", file: "roughness.png" },
  ao: { label: "AO map", title: "Ambient occlusion settings", file: "ao.png" },
  view3d: { label: "3D material view", title: "3D view settings", file: null },
};

let activeTab = "normal";
let previewUrls = {};
let selectedFile = null;
let hasUploaded = false;
let debounceTimer = null;
let fullResTimer = null;
let abortCtrl = null;
let genSeq = 0;
let viewer3d = null;
let currentShape = "plane";
let tileCount = 1;
let seamlessMethod = "smart";
let sourceTileable = false; // true when imported from Seamless Texture Maker

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
  viewerLabel.textContent = meta.label;

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

function updateMainViewer({ live = false } = {}) {
  if (activeTab === "view3d") return;

  const url = previewUrls[activeTab];
  if (!url) {
    mainPreview.hidden = true;
    tiledPreview.hidden = true;
    viewerEmpty.classList.remove("hidden");
    liveBadge.hidden = true;
    saveCurrentBtn.classList.add("disabled");
    saveCurrentBtn.removeAttribute("href");
    return;
  }

  viewerEmpty.classList.add("hidden");
  const bust = url.includes("?") ? `&t=${Date.now()}` : `?t=${Date.now()}`;
  if (tileCount > 1) {
    mainPreview.hidden = true;
    tiledPreview.hidden = false;
    // preload so the tiles don't flash while the new image loads
    const img = new Image();
    img.onload = () => {
      tiledPreview.style.backgroundImage = `url("${url + bust}")`;
    };
    img.src = url + bust;
    tiledPreview.style.backgroundSize = `${100 / tileCount}% ${100 / tileCount}%`;
  } else {
    tiledPreview.hidden = true;
    mainPreview.hidden = false;
    mainPreview.src = url + bust;
  }
  liveBadge.hidden = !live;

  saveCurrentBtn.classList.remove("disabled");
  saveCurrentBtn.href = url;
  saveCurrentBtn.download = TAB_META[activeTab].file || "map.png";
}

// ── 3D ─────────────────────────────────────────────
function ensure3D() {
  if (viewer3d) {
    // force resize when becoming visible
    requestAnimationFrame(() => viewer3d._resize());
    return viewer3d;
  }
  viewer3d = new MaterialViewer3D(view3dCanvas);
  viewer3d.setShape(currentShape);
  viewer3d.setNormalScale(document.getElementById("view_normal_scale").value);
  viewer3d.setDisplacementScale(document.getElementById("view_disp_scale").value);
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
    viewer3d.setLightIntensity(document.getElementById("view_light").value);
  } catch (e) {
    console.error(e);
    showError("Could not load textures into 3D view: " + e.message);
  }
}

shapeBtns.querySelectorAll(".shape-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    currentShape = btn.dataset.shape;
    shapeBtns.querySelectorAll(".shape-btn").forEach((b) => {
      b.classList.toggle("active", b === btn);
    });
    if (viewer3d) viewer3d.setShape(currentShape);
  });
});

// 3D-only sliders (no full map regen — just material)
function wireViewSlider(id, onInput) {
  const el = document.getElementById(id);
  if (!el) return;
  const val = el.parentElement.querySelector(".val");
  const sync = () => {
    if (val) val.textContent = Number(el.value).toString();
  };
  el.addEventListener("input", () => {
    sync();
    if (viewer3d) onInput(el.value);
  });
  sync();
}

wireViewSlider("view_repeat", (v) => viewer3d?.setRepeat(v));
wireViewSlider("view_normal_scale", (v) => viewer3d?.setNormalScale(v));
wireViewSlider("view_disp_scale", (v) => viewer3d?.setDisplacementScale(v));
wireViewSlider("view_light", (v) => viewer3d?.setLightIntensity(v));
document.getElementById("view_auto_rotate").addEventListener("change", (e) => {
  viewer3d?.setAutoRotate(e.target.checked);
});

// ── Map sliders ────────────────────────────────────
document.querySelectorAll(".slider input[type=range]").forEach((input) => {
  // skip 3d-only sliders (handled above)
  if (input.id.startsWith("view_")) return;

  const val = input.parentElement.querySelector(".val");
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

["roughness_method", "maxSize"].forEach((id) => {
  const el = document.getElementById(id);
  if (el) el.addEventListener("change", () => scheduleFullGenerate());
});
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

// ── Seamless + tile preview ────────────────────────
function syncSeamlessUI() {
  seamlessBody.classList.toggle("is-off", !seamlessToggle.checked);
  seamHint.textContent = METHOD_HINTS[seamlessMethod];
  document.getElementById("seamless_blend").closest(".slider").hidden = seamlessMethod === "mirror";
}

seamlessToggle.addEventListener("change", () => {
  syncSeamlessUI();
  // turning seamless on is the moment you want to check the repeat
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

syncSeamlessUI();

function canGenerate() {
  return !!(selectedFile || hasUploaded);
}

function scheduleLivePreview() {
  if (!canGenerate()) return;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => generate({ preview: true }), 80);
}

function scheduleFullGenerate() {
  if (!canGenerate()) return;
  clearTimeout(debounceTimer);
  clearTimeout(fullResTimer);
  fullResTimer = setTimeout(() => generate({ preview: false }), 120);
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

// ── Upload ─────────────────────────────────────────
function setFile(file) {
  if (!file || !file.type.startsWith("image/")) {
    showError("Please choose an image file.");
    return;
  }
  selectedFile = file;
  hasUploaded = false;
  sourceTileable = false;
  const url = URL.createObjectURL(file);
  diffuseThumb.src = url;
  diffuseThumb.hidden = false;
  dropHint.hidden = true;
  generateBtn.disabled = false;
  showError("");
  statusEl.textContent = `Loaded: ${file.name}`;
  generate({ preview: false, forceUpload: true });
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

function collectForm({ preview = false, forceUpload = false } = {}) {
  const fd = new FormData();
  if (selectedFile && (forceUpload || !hasUploaded)) {
    fd.append("diffuse", selectedFile);
  }

  const keys = [
    "height_strength",
    "height_blur",
    "height_contrast",
    "height_level",
    "normal_strength",
    "normal_blur",
    "roughness_strength",
    "roughness_blur",
    "roughness_contrast",
    "roughness_base",
    "ao_strength",
    "ao_blur",
  ];
  keys.forEach((k) => {
    const el = document.getElementById(k);
    if (el) fd.append(k, el.value);
  });

  fd.append("height_invert", document.getElementById("height_invert").checked ? "true" : "false");
  fd.append("normal_invert_x", document.getElementById("normal_invert_x").checked ? "true" : "false");
  fd.append("normal_invert_y", document.getElementById("normal_invert_y").checked ? "true" : "false");
  fd.append("roughness_invert", document.getElementById("roughness_invert").checked ? "true" : "false");
  fd.append("include_ao", document.getElementById("include_ao").checked ? "true" : "false");
  fd.append("roughness_method", document.getElementById("roughness_method").value);
  fd.append("seamless", seamlessToggle.checked ? "true" : "false");
  fd.append("seamless_method", seamlessMethod);
  fd.append("seamless_blend", document.getElementById("seamless_blend").value);
  fd.append("seamless_equalize", document.getElementById("seamless_equalize").value);
  fd.append("tileable", sourceTileable ? "true" : "false");

  const maxSize = document.getElementById("maxSize").value;
  fd.append("max_size", preview ? String(Math.min(768, Number(maxSize) || 768)) : maxSize);
  fd.append("preview", preview ? "true" : "false");
  return fd;
}

async function generate({ preview = false, forceUpload = false } = {}) {
  if (!canGenerate()) return;

  if (abortCtrl) {
    try {
      abortCtrl.abort();
    } catch (_) {}
  }
  abortCtrl = new AbortController();
  const mySeq = ++genSeq;

  showError("");
  if (!preview) generateBtn.disabled = true;
  statusEl.textContent = preview ? "Live updating…" : "Generating maps…";
  statusEl.classList.toggle("live", preview);

  try {
    const res = await fetch("/api/generate", {
      method: "POST",
      body: collectForm({ preview, forceUpload }),
      signal: abortCtrl.signal,
    });
    const data = await res.json();
    if (mySeq !== genSeq) return;
    if (!res.ok) throw new Error(data.error || "Generation failed");

    if (forceUpload || data.uploaded) hasUploaded = true;

    previewUrls = data.previews || {};
    if (activeTab === "view3d") {
      await refresh3D();
    } else {
      updateMainViewer({ live: preview });
    }
    // Keep 3D in sync if already created
    if (viewer3d && activeTab !== "view3d") {
      refresh3D();
    }

    if (!preview) {
      downloadBtn.classList.remove("disabled");
      downloadBtn.href = data.download_zip || "/api/download-zip";
    }

    const m = data.maps || {};
    const seamTag = m.seamless ? " · seamless ✓" : "";
    statusEl.textContent = preview
      ? `Live · ${m.width || "?"}×${m.height_px || "?"}${seamTag}`
      : `Done · ${m.width || "?"}×${m.height_px || "?"}${seamTag} · ZIP ready`;
  } catch (err) {
    if (err.name === "AbortError") return;
    if (mySeq !== genSeq) return;
    showError(err.message);
    statusEl.textContent = "Failed";
  } finally {
    if (mySeq === genSeq) {
      generateBtn.disabled = !canGenerate();
      statusEl.classList.remove("live");
    }
  }
}

generateBtn.addEventListener("click", () =>
  generate({ preview: false, forceUpload: !hasUploaded })
);

/** Auto-import when opened from Seamless Texture Maker (?from=seamless) */
async function importFromSeamlessInbox() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("from") !== "seamless") return;

  statusEl.textContent = "Importing seamless diffuse…";
  showError("");
  try {
    const res = await fetch("/api/import-inbox", { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Inbox import failed");

    hasUploaded = true;
    selectedFile = null;
    sourceTileable = true;
    previewUrls = data.previews || {};

    if (previewUrls.diffuse) {
      diffuseThumb.src = previewUrls.diffuse + `?t=${Date.now()}`;
      diffuseThumb.hidden = false;
      dropHint.hidden = true;
    }
    generateBtn.disabled = false;
    downloadBtn.classList.remove("disabled");
    downloadBtn.href = data.download_zip || "/api/download-zip";

    if (activeTab === "view3d") {
      await refresh3D();
    } else {
      updateMainViewer({ live: false });
    }
    if (viewer3d) refresh3D();

    const m = data.maps || {};
    statusEl.textContent = `Imported from Seamless · ${m.width || "?"}×${m.height_px || "?"} · ZIP ready`;

    // clean URL so refresh doesn't re-import unexpectedly without flag
    const url = new URL(window.location.href);
    url.searchParams.delete("from");
    url.searchParams.delete("t");
    window.history.replaceState({}, "", url.pathname);
  } catch (err) {
    showError(err.message);
    statusEl.textContent = "Import failed";
  }
}

setActiveTab("normal");
importFromSeamlessInbox();
