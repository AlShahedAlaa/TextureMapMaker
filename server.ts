import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express, { Request, Response } from "express";
import session from "express-session";
import cookieParser from "cookie-parser";
import multer from "multer";
import archiver from "archiver";
import { v4 as uuidv4 } from "uuid";
import { generateAllMaps, GenerateOptions } from "./src/map_generator.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_NAME = "Texture Map Maker";
const APP_VERSION = "1.1";
const PORT = 3000;
const HOST = "0.0.0.0";

const DATA_DIR = process.env.TMM_DATA_DIR ? path.resolve(process.env.TMM_DATA_DIR) : __dirname;
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const OUTPUTS_DIR = path.join(DATA_DIR, "outputs");
const INBOX_DIR = path.join(DATA_DIR, "inbox");

await Promise.all([
  fs.mkdir(UPLOADS_DIR, { recursive: true }),
  fs.mkdir(OUTPUTS_DIR, { recursive: true }),
  fs.mkdir(INBOX_DIR, { recursive: true }),
]);

declare module "express-session" {
  interface SessionData {
    sid?: string;
    diffuse_name?: string;
  }
}

const app = express();
app.set("trust proxy", 1);

app.use(express.json({ limit: "200mb" }));
app.use(express.urlencoded({ extended: true, limit: "200mb" }));
app.use(cookieParser());
app.use(
  session({
    secret: process.env.SECRET_KEY || "texture-map-maker-secret-key-3000",
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 },
  })
);

// Serve static assets
app.use("/static", express.static(path.join(__dirname, "static")));

function getSessionDir(req: Request): { sid: string; dir: string } {
  let sid =
    (req.headers["x-session-id"] as string) ||
    (req.query?.sid as string) ||
    (req.body?.sid as string) ||
    req.session.sid;

  if (!sid || typeof sid !== "string" || !/^[a-zA-Z0-9_-]{4,64}$/.test(sid)) {
    sid = req.session.sid || uuidv4().replace(/-/g, "").slice(0, 12);
  }
  req.session.sid = sid;
  const dir = path.join(OUTPUTS_DIR, sid);
  return { sid, dir };
}

const ALLOWED_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"]);

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const { dir } = getSessionDir(req);
      fs.mkdir(dir, { recursive: true }).then(() => cb(null, dir)).catch((err) => cb(err, dir));
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || ".png";
      cb(null, `upload${ext}`);
    },
  }),
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTS.has(ext)) {
      return cb(new Error(`Unsupported format ${ext}`));
    }
    cb(null, true);
  },
});

function parseBool(val: unknown, defaultVal = false): boolean {
  if (val === undefined || val === null) return defaultVal;
  if (typeof val === "boolean") return val;
  const s = String(val).toLowerCase().trim();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

function parseParams(body: Record<string, any>): GenerateOptions {
  return {
    height_strength: Number(body.height_strength ?? 1.0),
    height_blur: Number(body.height_blur ?? 0.5),
    height_contrast: Number(body.height_contrast ?? 1.0),
    height_invert: parseBool(body.height_invert, false),
    height_level: Number(body.height_level ?? 0.0),
    normal_strength: Number(body.normal_strength ?? 2.0),
    normal_blur: Number(body.normal_blur ?? 0.0),
    normal_format: body.normal_format === "directx" ? "directx" : "opengl",
    normal_macro_detail: Number(body.normal_macro_detail ?? 0.35),
    normal_invert_x: parseBool(body.normal_invert_x, false),
    normal_invert_y: parseBool(body.normal_invert_y, true),
    roughness_method: body.roughness_method || "variance",
    roughness_strength: Number(body.roughness_strength ?? 1.0),
    roughness_blur: Number(body.roughness_blur ?? 1.5),
    roughness_contrast: Number(body.roughness_contrast ?? 1.0),
    roughness_invert: parseBool(body.roughness_invert, false),
    roughness_base: Number(body.roughness_base ?? 0.5),
    roughness_min: Number(body.roughness_min ?? 0.0),
    roughness_max: Number(body.roughness_max ?? 1.0),
    include_ao: parseBool(body.include_ao, true),
    ao_strength: Number(body.ao_strength ?? 1.0),
    ao_blur: Number(body.ao_blur ?? 2.0),
    ao_exponent: Number(body.ao_exponent ?? 1.2),
    max_size: Number(body.max_size || 2048),
    aspect_mode: (body.aspect_mode as any) || "keep",
    delight: Number(body.delight ?? 0.0),
    seamless: parseBool(body.seamless, false),
    seamless_method: body.seamless_method || "smart",
    seamless_blend: Number(body.seamless_blend ?? 0.25),
    seamless_equalize: Number(body.seamless_equalize ?? 0.0),
    tileable: parseBool(body.tileable, false),
    orm_pack_blue: body.orm_pack_blue === "height" ? "height" : "metallic",
  };
}

// ── Routes ───────────────────────────────────────────

app.get("/", async (_req: Request, res: Response) => {
  try {
    const indexPath = path.join(__dirname, "templates", "index.html");
    const html = await fs.readFile(indexPath, "utf-8");
    const rendered = html.replace(/\{\{\s*version\s*\}\}/g, APP_VERSION);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(rendered);
  } catch (err: any) {
    res.status(500).send("Error loading page: " + err.message);
  }
});

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    app: APP_NAME,
    version: APP_VERSION,
    free: true,
    api_key_required: false,
  });
});

app.use("/api", (req: Request, res: Response, next) => {
  if (!req.path.includes("download-zip")) {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
  }
  next();
});

app.post("/api/generate", upload.single("diffuse"), async (req: Request, res: Response) => {
  try {
    const { sid, dir: outDir } = getSessionDir(req);
    await fs.mkdir(outDir, { recursive: true });

    let diffusePath: string | null = null;
    let uploaded = false;

    if (req.file) {
      diffusePath = req.file.path;
      req.session.diffuse_name = path.basename(req.file.path);
      uploaded = true;
    } else {
      const savedName = req.session.diffuse_name;
      if (savedName && existsSync(path.join(outDir, savedName))) {
        diffusePath = path.join(outDir, savedName);
      } else {
        const files = await fs.readdir(outDir);
        const uploadFile = files
          .filter((f) => f.startsWith("upload."))
          .sort((a, b) => b.localeCompare(a))[0];
        if (uploadFile) {
          diffusePath = path.join(outDir, uploadFile);
          req.session.diffuse_name = uploadFile;
        } else if (existsSync(path.join(outDir, "diffuse.png"))) {
          diffusePath = path.join(outDir, "diffuse.png");
        } else {
          res.status(400).json({ error: "Upload a diffuse texture first" });
          return;
        }
      }
    }

    const params = parseParams(req.body);
    const maps = await generateAllMaps(diffusePath, outDir, params);

    const previews: Record<string, string> = {
      diffuse: `/outputs/${sid}/${maps.diffuse}`,
      height: `/outputs/${sid}/${maps.height}`,
      normal: `/outputs/${sid}/${maps.normal}`,
      roughness: `/outputs/${sid}/${maps.roughness}`,
    };
    if (maps.ao) {
      previews.ao = `/outputs/${sid}/${maps.ao}`;
    }
    if (maps.orm) {
      previews.orm = `/outputs/${sid}/${maps.orm}`;
    }

    res.json({
      ok: true,
      sid,
      maps,
      previews,
      uploaded,
      download_zip: `/api/download-zip?sid=${sid}`,
    });
  } catch (err: any) {
    console.error("Generate error:", err);
    res.status(500).json({ error: err.message || "Map generation failed" });
  }
});

app.get("/api/download-zip", async (req: Request, res: Response) => {
  try {
    const { dir: outDir } = getSessionDir(req);
    const names = ["diffuse.png", "normal.png", "height.png", "roughness.png", "ao.png", "orm.png"];
    const existing = names.filter((n) => existsSync(path.join(outDir, n)));

    if (existing.length === 0) {
      res.status(400).json({ error: "Generate maps first" });
      return;
    }

    const preset = String(req.query.preset || "standard").toLowerCase();
    const nameMappings: Record<string, Record<string, string>> = {
      standard: {
        "diffuse.png": "diffuse.png",
        "normal.png": "normal.png",
        "height.png": "height.png",
        "roughness.png": "roughness.png",
        "ao.png": "ao.png",
        "orm.png": "orm.png",
      },
      unreal: {
        "diffuse.png": "Texture_BaseColor.png",
        "normal.png": "Texture_Normal.png",
        "height.png": "Texture_Displacement.png",
        "roughness.png": "Texture_Roughness.png",
        "ao.png": "Texture_AO.png",
        "orm.png": "Texture_ORM.png",
      },
      unity: {
        "diffuse.png": "Texture_Albedo.png",
        "normal.png": "Texture_Normal.png",
        "height.png": "Texture_Height.png",
        "roughness.png": "Texture_Roughness.png",
        "ao.png": "Texture_Occlusion.png",
        "orm.png": "Texture_MaskMap.png",
      },
      blender: {
        "diffuse.png": "Texture_diffuse.png",
        "normal.png": "Texture_nor.png",
        "height.png": "Texture_disp.png",
        "roughness.png": "Texture_rough.png",
        "ao.png": "Texture_ao.png",
        "orm.png": "Texture_orm.png",
      },
    };
    const mapping = nameMappings[preset] || nameMappings.standard;

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="pbr_textures_${preset}.zip"`);

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (err) => {
      console.error("Archive error:", err);
      if (!res.headersSent) res.status(500).json({ error: err.message });
    });
    archive.pipe(res);

    for (const name of existing) {
      const exportName = mapping[name] || name;
      archive.file(path.join(outDir, name), { name: exportName });
    }
    await archive.finalize();
  } catch (err: any) {
    console.error("ZIP download error:", err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.use("/outputs/:sid", (req: Request, res: Response, next) => {
  const sid = req.params.sid;
  const sidDir = path.join(OUTPUTS_DIR, sid);
  express.static(sidDir)(req, res, next);
});

// Import inbox (from Seamless Texture Maker)
const handleInbox = async (req: Request, res: Response) => {
  try {
    const extensions = [".png", ".jpg", ".jpeg", ".webp"];
    let sourcePath: string | null = null;

    for (const ext of extensions) {
      const candidate = path.join(INBOX_DIR, `diffuse${ext}`);
      if (existsSync(candidate)) {
        sourcePath = candidate;
        break;
      }
    }

    if (!sourcePath) {
      res.status(404).json({
        error: "No inbox texture. Use Seamless Texture Maker → Open in Texture Map Maker.",
      });
      return;
    }

    const { sid, dir: outDir } = getSessionDir(req);
    await fs.mkdir(outDir, { recursive: true });

    const ext = path.extname(sourcePath).toLowerCase() || ".png";
    const dest = path.join(outDir, `upload${ext}`);
    await fs.copyFile(sourcePath, dest);
    req.session.diffuse_name = path.basename(dest);

    let params: GenerateOptions;
    if (req.method === "POST" && Object.keys(req.body || {}).length > 0) {
      params = parseParams(req.body);
      params.tileable = true;
    } else {
      params = {
        height_strength: 1.0,
        height_blur: 0.5,
        height_contrast: 1.0,
        height_invert: false,
        height_level: 0.0,
        normal_strength: 2.0,
        normal_blur: 0.0,
        normal_invert_x: false,
        normal_invert_y: true,
        roughness_method: "variance",
        roughness_strength: 1.0,
        roughness_blur: 1.5,
        roughness_contrast: 1.0,
        roughness_invert: false,
        roughness_base: 0.5,
        include_ao: true,
        ao_strength: 1.0,
        ao_blur: 2.0,
        max_size: 2048,
        tileable: true,
      };
    }

    const maps = await generateAllMaps(dest, outDir, params);

    const pendingFlag = path.join(INBOX_DIR, "pending.flag");
    if (existsSync(pendingFlag)) {
      await fs.unlink(pendingFlag).catch(() => {});
    }

    const previews: Record<string, string> = {
      diffuse: `/outputs/${sid}/${maps.diffuse}`,
      height: `/outputs/${sid}/${maps.height}`,
      normal: `/outputs/${sid}/${maps.normal}`,
      roughness: `/outputs/${sid}/${maps.roughness}`,
    };
    if (maps.ao) {
      previews.ao = `/outputs/${sid}/${maps.ao}`;
    }

    res.json({
      ok: true,
      maps,
      previews,
      uploaded: true,
      from: "seamless",
      download_zip: "/api/download-zip",
    });
  } catch (err: any) {
    console.error("Inbox error:", err);
    res.status(500).json({ error: err.message });
  }
};

app.post("/api/import-inbox", handleInbox);
app.get("/api/import-inbox", handleInbox);

app.use((err: any, _req: Request, res: Response, _next: any) => {
  console.error("Global server error:", err);
  if (err && err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "Image file is too large (max 30MB)" });
  }
  if (err && typeof err.message === "string") {
    return res.status(500).json({ error: err.message });
  }
  res.status(500).json({ error: "Internal server error during map generation" });
});

app.listen(PORT, HOST, () => {
  console.log(`Texture Map Maker running at http://${HOST}:${PORT}`);
});
