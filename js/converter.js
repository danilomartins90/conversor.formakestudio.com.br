// Reads a Bambu Studio / OrcaSlicer 3MF project and rewrites its print profile for another printer.
// The meshes, painting and per-object settings are copied untouched; only the project config is
// rebuilt from the target printer's OrcaSlicer presets plus the settings the author changed.

import { readZip, readText, forEachTagChunk, makeEntry, transformEntry, writeZip } from "./zip.js?version=1.0.1";

const CONFIG = "Metadata/project_settings.config";
const MODEL = "3D/3dmodel.model";
const SETTINGS = "Metadata/model_settings.config";
// Orca lays plates out in a grid spaced by the bed size plus this gap (PartPlate.cpp LOGICAL_PART_PLATE_GAP).
const PLATE_GAP = 1 / 5;
// Keys that describe a preset rather than a setting; they never go into the project config as-is.
const PRESET_META = ["name", "inherits", "filament_id", "compatible_printers", "compatible_printers_condition", "compatible_prints", "compatible_prints_condition"];
// Print settings that point at a filament slot (1-based, 0 = default).
const FILAMENT_INDEX_KEYS = ["wall_filament", "sparse_infill_filament", "solid_infill_filament", "support_filament", "support_interface_filament", "wipe_tower_filament"];

export class ConvertError extends Error {}

const first = (value) => (Array.isArray(value) ? value[0] : value);
const toNumber = (value) => {
  const n = parseFloat(String(value ?? "").trim());
  return Number.isFinite(n) ? n : null;
};
const isPercent = (value) => String(value ?? "").trim().endsWith("%");

function bedRect(area) {
  const list = typeof area === "string" ? area.split(",") : area || [];
  const points = list.map((p) => String(p).split("x").map(Number)).filter((p) => p.length === 2 && p.every(Number.isFinite));
  if (!points.length) return null;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const rect = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  if (!(rect.x1 > rect.x0 && rect.y1 > rect.y0)) return null;
  rect.width = rect.x1 - rect.x0;
  rect.depth = rect.y1 - rect.y0;
  rect.cx = (rect.x0 + rect.x1) / 2;
  rect.cy = (rect.y0 + rect.y1) / 2;
  return rect;
}

const attr = (text, name) => (text.match(new RegExp(`\\b${name}="([^"]*)"`)) || [])[1];
const metadata = (text, key) => (text.match(new RegExp(`<metadata\\s+key="${key}"\\s+value="([^"]*)"`)) || [])[1];
const decodeXml = (text) => String(text ?? "").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

// ---------- painting (TriangleSelector::serialize / FacetsAnnotation::get_triangle_as_string) ----------

// The hex string is read back to front, four bits per digit, least significant bit first. Each
// triangle is a tree: 2 bits of split sides; split nodes add 2 bits of special side and their
// children, leaves add 2 bits of state, where 3 means a nibble follows (state 3 + nibble, or
// 18 + a second nibble when the first is 15).
export function paintStates(code, out = new Set()) {
  const bits = [];
  for (let i = code.length - 1; i >= 0; i--) {
    const digit = parseInt(code[i], 16);
    if (Number.isNaN(digit)) return out;
    for (let b = 0; b < 4; b++) bits.push((digit >> b) & 1);
  }
  let pos = 0;
  const read = (count) => {
    let value = 0;
    for (let b = 0; b < count; b++) value |= (bits[pos++] || 0) << b;
    return value;
  };
  const walk = (depth) => {
    if (pos >= bits.length || depth > 64) return;
    const splitSides = read(2);
    if (splitSides) {
      read(2);
      for (let child = 0; child <= splitSides; child++) walk(depth + 1);
      return;
    }
    let state = read(2);
    if (state === 3) {
      const nibble = read(4);
      state = nibble === 15 ? 18 + read(4) : 3 + nibble;
    }
    out.add(state);
  };
  walk(0);
  return out;
}

// Painted states per object id, for one model file.
async function scanPaint(entry) {
  const byObject = {};
  const cache = new Map();
  let current = null;
  await forEachTagChunk(entry, (text) => {
    const re = /<object\b[^>]*\bid="(\d+)"|<triangle\b[^>]*?\bpaint_color="([0-9A-Fa-f]+)"/g;
    let m;
    while ((m = re.exec(text))) {
      if (m[1]) {
        current = m[1];
        continue;
      }
      if (current == null) continue;
      let states = cache.get(m[2]);
      if (!states) {
        states = paintStates(m[2]);
        cache.set(m[2], states);
      }
      const target = (byObject[current] ||= new Set());
      for (const s of states) if (s > 0) target.add(s);
    }
  });
  return byObject;
}

// ---------- reading ----------

function parseObjects(settingsXml) {
  const objects = {};
  for (const m of settingsXml.matchAll(/<object id="(\d+)">([\s\S]*?)<\/object>/g)) {
    const body = m[2];
    const head = body.split("<part")[0];
    const parts = [...body.matchAll(/<part\b[^>]*>([\s\S]*?)<\/part>/g)].map((p) => Number(metadata(p[1], "extruder")) || null);
    objects[m[1]] = { name: decodeXml(metadata(head, "name") || ""), extruder: Number(metadata(head, "extruder")) || 1, parts };
  }
  return objects;
}

function parsePlates(settingsXml) {
  const plates = [];
  for (const m of settingsXml.matchAll(/<plate>([\s\S]*?)<\/plate>/g)) {
    const body = m[1];
    const instances = [...body.matchAll(/<model_instance>([\s\S]*?)<\/model_instance>/g)].map((i) => ({
      object: metadata(i[1], "object_id"),
      instance: Number(metadata(i[1], "instance_id") || 0),
    }));
    plates.push({
      id: Number(metadata(body, "plater_id")) || plates.length + 1,
      name: decodeXml(metadata(body, "plater_name") || ""),
      thumbnail: metadata(body, "thumbnail_file") || "",
      instances,
    });
  }
  return plates;
}

function parseComponents(modelXml) {
  const components = {};
  const objects = [...modelXml.matchAll(/<object\b[^>]*\bid="(\d+)"[^>]*>([\s\S]*?)<\/object>/g)];
  for (const m of objects) {
    components[m[1]] = [...m[2].matchAll(/<component\b([^>]*)\/?>/g)].map((c) => ({
      path: (attr(c[1], "p:path") || `/${MODEL}`).replace(/^\//, ""),
      object: attr(c[1], "objectid"),
    }));
  }
  return components;
}

export async function readProject(buffer, onProgress = () => {}) {
  const entries = readZip(buffer);
  const find = (name) => entries.find((e) => e.name === name);
  const configEntry = find(CONFIG);
  if (!configEntry) {
    throw new ConvertError("Este 3MF não tem perfil de impressão (Metadata/project_settings.config). Parece ser só um modelo, não um projeto salvo no fatiador.");
  }
  const config = JSON.parse(await readText(configEntry));
  const modelXml = find(MODEL) ? await readText(find(MODEL)) : "";
  const settingsXml = find(SETTINGS) ? await readText(find(SETTINGS)) : "";
  const application = (modelXml.match(/<metadata name="Application">([^<]*)<\/metadata>/) || [])[1] || "";

  const objects = parseObjects(settingsXml);
  const components = parseComponents(modelXml);
  let plates = parsePlates(settingsXml);
  if (!plates.length) {
    plates = [{ id: 1, name: "", thumbnail: "", instances: Object.keys(components).map((object) => ({ object, instance: 0 })) }];
  }

  onProgress("Lendo a pintura das peças…");
  const paint = {};
  for (const entry of entries) {
    if (entry.name === MODEL || (entry.name.startsWith("3D/Objects/") && entry.name.endsWith(".model"))) {
      paint[entry.name] = await scanPaint(entry);
    }
  }
  const hasPaint = Object.values(paint).some((byObject) => Object.keys(byObject).length > 0);

  // Filaments a plate uses: object/part extruders plus painted states of its meshes.
  for (const plate of plates) {
    const used = new Set();
    for (const { object } of plate.instances) {
      const info = objects[object] || { extruder: 1, parts: [] };
      const parts = components[object] || [];
      used.add(info.extruder);
      info.parts.forEach((extruder) => extruder && used.add(extruder));
      const meshes = parts.length ? parts : [{ path: MODEL, object }];
      for (const mesh of meshes) for (const s of paint[mesh.path]?.[mesh.object] || []) used.add(s);
    }
    plate.filaments = [...used].sort((a, b) => a - b);
    const json = find(`Metadata/plate_${plate.id}.json`);
    if (json) {
      try {
        const info = JSON.parse(await readText(json));
        if (Array.isArray(info.bbox_all) && info.bbox_all.length === 4) plate.bbox = info.bbox_all.map(Number);
      } catch {
        // plate info is optional
      }
    }
  }

  const colours = [].concat(config.filament_colour || []);
  const types = [].concat(config.filament_type || []);
  const names = [].concat(config.filament_settings_id || []);
  const vendors = [].concat(config.filament_vendor || []);
  const filaments = colours.map((colour, i) => ({
    index: i + 1,
    colour,
    type: String(types[i] || "").trim(),
    name: names[i] || "",
    vendor: String(vendors[i] || "").trim(),
  }));
  const usedFilaments = [...new Set(plates.flatMap((p) => p.filaments))].filter((i) => i <= filaments.length).sort((a, b) => a - b);

  const different = [].concat(config.different_settings_to_system || []);
  const splitKeys = (value) => String(value || "").split(";").map((k) => k.trim()).filter(Boolean);
  const inherits = [].concat(config.inherits_group || []);
  const processName = inherits[0] || config.print_settings_id || "";

  return {
    entries,
    config,
    modelXml,
    settingsXml,
    application,
    plates,
    filaments,
    usedFilaments,
    hasPaint,
    authorChanges: {
      print: splitKeys(different[0]),
      filament: filaments.map((_, i) => splitKeys(different[i + 1])),
      printer: splitKeys(different[filaments.length + 1]),
    },
    source: {
      printer: config.printer_settings_id || config.printer_model || "",
      model: config.printer_model || "",
      nozzle: String(first(config.nozzle_diameter) ?? ""),
      bed: bedRect(config.printable_area),
      process: config.print_settings_id || "",
      processBase: processName,
      layer: String(first(config.layer_height) ?? ""),
    },
  };
}

// ---------- choices ----------

const qualityOf = (name) => String(name || "").split("@")[0].replace(/\s+/g, " ").trim().toLowerCase();

// Same "0.20mm Standard" prefix first, then the same layer height, then the printer's default.
export function chooseProcess(project, processes) {
  const quality = qualityOf(project.source.processBase);
  const byName = quality && processes.find((p) => qualityOf(p.name) === quality);
  if (byName) return byName;
  const layer = toNumber(project.source.layer);
  if (layer != null) {
    const word = quality.split(" ").slice(1).join(" ");
    const sameLayer = processes.filter((p) => toNumber(p.layer) === layer);
    if (sameLayer.length) return sameLayer.find((p) => word && qualityOf(p.name).includes(word)) || sameLayer[0];
  }
  return processes[0];
}

// ---------- config building ----------

function coerce(source, target) {
  if (target === undefined) return structuredClone(source);
  if (Array.isArray(target)) {
    if (Array.isArray(source)) return source.length === target.length ? source.slice() : new Array(target.length).fill(source[0]);
    return new Array(Math.max(1, target.length)).fill(source);
  }
  return Array.isArray(source) ? source[0] : source;
}

// Collapses variant-sized arrays to the slot of the printer's extruder/nozzle variant, as Orca does
// in update_values_to_printer_extruders when saving a single-extruder project.
function collapseVariants(config, listKey, sets, variant) {
  const list = config[listKey];
  if (!Array.isArray(list) || list.length <= 1) return;
  let index = list.indexOf(variant);
  if (index < 0) index = 0;
  for (const [keys, stride] of sets) {
    for (const key of keys) {
      const value = config[key];
      if (Array.isArray(value) && value.length >= list.length * stride) config[key] = value.slice(index * stride, index * stride + stride);
    }
  }
  config[listKey] = [list[index]];
}

function withoutMeta(config) {
  const out = { ...config };
  for (const key of PRESET_META) delete out[key];
  return out;
}

// Limits on accelerations, jerk and speeds kept from the original.
const LIMIT_ACCEL = [
  "default_acceleration", "outer_wall_acceleration", "inner_wall_acceleration", "initial_layer_acceleration",
  "top_surface_acceleration", "travel_acceleration", "bridge_acceleration", "sparse_infill_acceleration",
  "internal_solid_infill_acceleration",
];
// A percent acceleration is relative to this key; the others in percent are not limited.
const ACCEL_PERCENT_OF = {
  bridge_acceleration: "outer_wall_acceleration",
  sparse_infill_acceleration: "default_acceleration",
  internal_solid_infill_acceleration: "default_acceleration",
};
const LIMIT_JERK = ["default_jerk", "outer_wall_jerk", "inner_wall_jerk", "infill_jerk", "top_surface_jerk", "initial_layer_jerk", "travel_jerk"];
// Speed -> line width used for the filament's volumetric flow limit (null: machine speed only).
const LIMIT_SPEED = {
  outer_wall_speed: "outer_wall_line_width",
  inner_wall_speed: "inner_wall_line_width",
  sparse_infill_speed: "sparse_infill_line_width",
  internal_solid_infill_speed: "internal_solid_infill_line_width",
  top_surface_speed: "top_surface_line_width",
  gap_infill_speed: "line_width",
  support_speed: "support_line_width",
  support_interface_speed: "support_line_width",
  initial_layer_speed: "initial_layer_line_width",
  initial_layer_infill_speed: "initial_layer_line_width",
  bridge_speed: null,
  ironing_speed: null,
  travel_speed: null,
  overhang_1_4_speed: null,
  overhang_2_4_speed: null,
  overhang_3_4_speed: null,
  overhang_4_4_speed: null,
  overhang_totally_speed: null,
};
// Firmwares with a separate travel acceleration limit (M204 T).
const TRAVEL_ACCEL_FLAVORS = ["repetier", "marlin2", "reprapfirmware"];

// ctx: { machine, value(key) -> the value written to the file by default }
function machineLimits(ctx) {
  const { machine, value } = ctx;
  const limit = (key) => {
    const n = toNumber(first(machine[key]));
    return n && n > 0 ? n : null;
  };
  const accel = (toNumber(first(value("default_acceleration"))) || 0) > 0 ? limit("machine_max_acceleration_extruding") : null;
  const travelAccel = TRAVEL_ACCEL_FLAVORS.includes(String(first(machine.gcode_flavor) || "")) ? limit("machine_max_acceleration_travel") : accel;
  const jerkX = limit("machine_max_jerk_x");
  const jerkY = limit("machine_max_jerk_y");
  const jerkOn = (toNumber(first(value("default_jerk"))) || 0) > 0;
  const speedX = limit("machine_max_speed_x");
  const speedY = limit("machine_max_speed_y");
  const flows = [].concat(value("filament_max_volumetric_speed") ?? []).map(toNumber).filter((n) => n > 0);
  return {
    accel,
    travelAccel: accel ? travelAccel : null,
    jerk: jerkOn && jerkX && jerkY ? Math.min(jerkX, jerkY) : null,
    speed: speedX && speedY ? Math.min(speedX, speedY) : speedX || speedY || Infinity,
    flow: flows.length ? Math.min(...flows) : null,
    nozzle: toNumber(first(machine.nozzle_diameter)) || 0.4,
  };
}

// Caps an original value at the target machine's limits; returns [value, reason] with reason
// "machine", "flow" or "".
function capToMachine(key, value, target, limits, ctx) {
  let reason = "";
  const each = (fn) => (Array.isArray(value) ? value.map((v, i) => fn(v, i)) : fn(value, 0));
  const at = (v, i) => toNumber(Array.isArray(v) ? v[Math.min(i, v.length - 1)] : v);

  if (LIMIT_ACCEL.includes(key)) {
    const max = key === "travel_acceleration" ? limits.travelAccel : limits.accel;
    if (!max) return [value, ""];
    const result = each((v, i) => {
      const n = toNumber(v);
      if (n == null) return v;
      if (isPercent(v)) {
        const base = ACCEL_PERCENT_OF[key] && at(ctx.value(ACCEL_PERCENT_OF[key]), i);
        if (!base || base <= 0 || (base * n) / 100 <= max) return v;
        reason = "machine";
        return `${Math.floor((max / base) * 100)}%`;
      }
      if (n <= max) return v;
      reason = "machine";
      return String(Math.floor(max));
    });
    return [result, reason];
  }

  if (LIMIT_JERK.includes(key)) {
    if (!limits.jerk) return [value, ""];
    const result = each((v) => {
      const n = toNumber(v);
      if (n == null || isPercent(v) || n <= limits.jerk) return v;
      reason = "machine";
      return String(+limits.jerk.toFixed(3));
    });
    return [result, reason];
  }

  if (key in LIMIT_SPEED) {
    let max = limits.speed;
    let flowMax = Infinity;
    const widthKey = LIMIT_SPEED[key];
    const layer = toNumber(first(ctx.value(key.startsWith("initial_layer") ? "initial_layer_print_height" : "layer_height")))
      || toNumber(first(ctx.value("layer_height")));
    if (widthKey && limits.flow && layer > 0) {
      const width = (k) => {
        const raw = first(ctx.value(k));
        const n = toNumber(raw);
        if (!n || n <= 0) return null;
        return isPercent(raw) ? (limits.nozzle * n) / 100 : n;
      };
      // Rounded so that floating point (21 / 0.084 = 249.99...) does not flag the exact limit.
      flowMax = +(limits.flow / (layer * (width(widthKey) || width("line_width") || limits.nozzle * 1.125))).toFixed(6);
      max = Math.min(max, flowMax);
    }
    if (!isFinite(max)) return [value, ""];
    const result = each((v, i) => {
      const n = toNumber(v);
      if (n == null || isPercent(v)) return v;
      // Never below the target profile's own value.
      const own = at(target, i);
      if (own != null && n <= own) return v;
      const cap = Math.max(max, own ?? 0);
      if (n <= cap) return v;
      reason = reason || (flowMax <= limits.speed ? "flow" : "machine");
      return String(Math.floor(cap));
    });
    return [result, reason];
  }
  return [value, ""];
}

// Keys that identify the preset or its variant layout rather than how it prints.
const NOT_COMPARED = new Set([...PRESET_META, "print_extruder_variant", "print_extruder_id"]);
const LAYER_KEYS = ["layer_height", "initial_layer_print_height"];
// G-code output, scripts, plugins and notes (Orca's "Others" tab): always the target printer's.
const TARGET_ONLY = new Set([
  "reduce_infill_retraction", "gcode_add_line_number", "gcode_comments", "high_precision_gcode",
  "gcode_label_objects", "exclude_object", "exclude_object_tolerance", "filename_format",
  "process_change_extrusion_role_gcode", "post_process", "slicing_pipeline_plugin",
  "print_plugin_config_overrides", "notes",
]);

const variantOf = (machine) => `${first(machine.extruder_type) || "Direct Drive"} ${first(machine.nozzle_volume_type) || "Standard"}`;

// The target process as it is written for a single-extruder printer.
function targetProcess(target, keys) {
  const process = structuredClone(target.process);
  collapseVariants(process, "print_extruder_variant", [[keys.printVariant, 1]], variantOf(target.machine.config));
  return process;
}

const sameValue = (a, b) => {
  const norm = (v) => [].concat(v).map((x) => {
    const n = toNumber(x);
    return n != null && String(x).trim() !== "" ? String(n) : String(x ?? "").trim();
  }).join(",");
  return norm(a) === norm(b);
};

// Why an original value does not suit the target printer, or "" when it does.
function incompatibility(key, original, known, layers) {
  if (!known) return "unknown";
  if (LAYER_KEYS.includes(key) && layers.min != null && layers.max != null) {
    const n = toNumber(first(original));
    if (n != null && (n < layers.min || n > layers.max)) return "layer";
  }
  return "";
}

// Lists every print setting in which the original differs from the target process. Settings the
// target process does not define are listed only when the author changed them. The original value
// is suggested for the author's own changes and the layer heights, which belong to the model; the
// rest is the source printer's tuning, so the target's value is suggested. An incompatible original
// is never suggested.
export function describeDifferences(project, target, keys) {
  const printKeys = new Set(keys.print);
  const projectKeys = new Set(keys.project);
  const process = targetProcess(target, keys);
  const machine = target.machine.config;
  const layers = { min: toNumber(first(machine.min_layer_height)), max: toNumber(first(machine.max_layer_height)) };
  const author = new Set(project.authorChanges.print);
  // What the file gets by default: the original for the author's changes, the layer heights and the
  // filaments; the target process for the rest.
  const ctx = {
    machine,
    value: (key) => (author.has(key) || LAYER_KEYS.includes(key) || !(key in process) ? project.config[key] : process[key]),
  };
  const limits = machineLimits(ctx);
  const rows = [];
  for (const key of new Set([...keys.print, ...author])) {
    if (NOT_COMPARED.has(key) || TARGET_ONLY.has(key) || projectKeys.has(key) || !(key in project.config)) continue;
    const targetValue = process[key];
    if (targetValue === undefined && !author.has(key)) continue;
    const source = project.config[key];
    const original = coerce(source, targetValue);
    if (targetValue !== undefined && sameValue(original, targetValue)) continue;
    const known = printKeys.has(key);
    const [value, limited] = capToMachine(key, original, targetValue, limits, ctx);
    const capped = !!limited;
    const incompatible = limited ? `limit-${limited}` : incompatibility(key, original, known, layers);
    rows.push({
      key,
      known,
      author: author.has(key),
      source,
      target: targetValue,
      value,
      capped,
      incompatible,
      layers,
      keep: !incompatible && (author.has(key) || LAYER_KEYS.includes(key)),
    });
  }
  return rows.sort((a, b) => Number(!!b.incompatible) - Number(!!a.incompatible) || Number(b.keep) - Number(a.keep) || a.key.localeCompare(b.key));
}

function buildConfig(project, target, plan, keys) {
  const machine = target.machine.config;
  const variant = variantOf(machine);
  const process = targetProcess(target, keys);
  const machineConfig = structuredClone(machine);
  collapseVariants(machineConfig, "printer_extruder_variant", [[keys.printerVariant1, 1], [keys.printerVariant2, 2]], variant);
  const src = project.config;
  const sourceCount = project.filaments.length;
  const slots = plan.slots;
  const count = slots.length;
  const pick = (value) => slots.map((i) => value[i - 1]);
  const perSlot = (value, fallback = "") => slots.map((i) => (Array.isArray(value) && value[i] !== undefined ? value[i] : fallback));

  const out = { ...withoutMeta(process), ...withoutMeta(machineConfig) };

  // Filament settings stay as in the original project, for the slots that are kept. Arrays with
  // several values per filament can only be copied whole, when every slot is kept.
  const allSlots = count === sourceCount;
  const filamentKeys = new Set([...keys.filament, ...Object.keys(src).filter((k) => k.startsWith("filament_"))]);
  for (const key of filamentKeys) {
    if (!(key in src)) continue;
    const value = src[key];
    if (!Array.isArray(value)) out[key] = value;
    else if (value.length === sourceCount) out[key] = pick(value);
    else if (allSlots) out[key] = value.slice();
  }

  // Project-level values follow the source project, resized to the slot count.
  for (const key of keys.project) {
    if (!(key in src)) continue;
    const value = src[key];
    if (!Array.isArray(value)) out[key] = value;
    else if (value.length === sourceCount) out[key] = pick(value);
  }
  out.filament_colour = slots.map((i) => project.filaments[i - 1]?.colour || "#FFFFFF");
  // Without a matrix that matches the slots, the key is left out and the slicer uses its default.
  if (plan.merge) {
    out.flush_volumes_matrix = ["0"];
  } else if (Array.isArray(src.flush_volumes_matrix) && src.flush_volumes_matrix.length % (sourceCount * sourceCount) === 0) {
    out.flush_volumes_matrix = src.flush_volumes_matrix.slice();
  } else {
    delete out.flush_volumes_matrix;
  }
  if (!plan.merge && Array.isArray(src.flush_volumes_vector) && src.flush_volumes_vector.length === sourceCount * 2) {
    out.flush_volumes_vector = src.flush_volumes_vector.slice();
  } else {
    delete out.flush_volumes_vector;
  }
  out.filament_map = new Array(count).fill("1");
  out.nozzle_volume_type = machine.nozzle_volume_type ? [].concat(machine.nozzle_volume_type).slice(0, 1) : ["Standard"];
  if (plan.tower) {
    out.wipe_tower_x = plan.tower.x;
    out.wipe_tower_y = plan.tower.y;
  } else {
    delete out.wipe_tower_x;
    delete out.wipe_tower_y;
  }

  // Print settings kept from the original.
  for (const row of plan.carried) out[row.key] = structuredClone(row.value);
  if (plan.merge) {
    for (const key of FILAMENT_INDEX_KEYS) if (Number(out[key]) > 1) out[key] = "1";
  }

  out.print_settings_id = target.process.name;
  out.printer_settings_id = machine.name;
  // Grouped values hold [print, filament 1..N, printer]; the filament entries come from the original.
  const different = [].concat(src.different_settings_to_system || []);
  out.inherits_group = ["", ...perSlot(src.inherits_group), ""];
  out.different_settings_to_system = [plan.carried.map((r) => r.key).sort().join(";"), ...perSlot(different), ""];
  out.print_compatible_printers = [].concat(target.process.compatible_printers || []);
  out.compatible_machine_expression_group = [target.process.compatible_printers_condition || "", ...perSlot(src.compatible_machine_expression_group), ""];
  out.compatible_process_expression_group = Array.isArray(src.compatible_process_expression_group) && src.compatible_process_expression_group.length === sourceCount
    ? pick(src.compatible_process_expression_group)
    : new Array(count).fill("");
  out.filament_self_index = slots.map((_, i) => String(i + 1));
  if (!Array.isArray(out.filament_extruder_variant) || out.filament_extruder_variant.length !== count) {
    out.filament_extruder_variant = new Array(count).fill(variant);
  }
  out.from = "project";
  out.name = "project_settings";
  out.version = target.machine.version || src.version || "";
  return out;
}

// ---------- geometry ----------

function plateCell(x, y, rect) {
  const strideX = rect.width * (1 + PLATE_GAP);
  const strideY = rect.depth * (1 + PLATE_GAP);
  const col = Math.round((x - rect.cx) / strideX);
  const row = Math.round((y - rect.cy) / strideY);
  return { col, row, localX: x - col * strideX, localY: y - row * strideY };
}

// Moves every build item to the same spot of the same plate on the target bed (centre to centre).
function moveItems(modelXml, source, target) {
  if (!source || !target) return modelXml;
  return modelXml.replace(/(<item\b[^>]*\btransform=")([^"]*)(")/g, (all, before, matrix, after) => {
    const m = matrix.trim().split(/\s+/).map(Number);
    if (m.length !== 12 || m.some((n) => !Number.isFinite(n))) return all;
    const cell = plateCell(m[9], m[10], source);
    m[9] = +(cell.col * target.width * (1 + PLATE_GAP) + cell.localX - source.cx + target.cx).toFixed(6);
    m[10] = +(cell.row * target.depth * (1 + PLATE_GAP) + cell.localY - source.cy + target.cy).toFixed(6);
    return before + m.join(" ") + after;
  });
}

function planTower(project, source, target, process) {
  const width = toNumber(first(process.prime_tower_width)) || 35;
  const margin = 5;
  const move = (values, axis) => [].concat(values ?? []).map((v) => {
    const n = toNumber(v);
    if (n == null || !source || !target) return String(v);
    const shifted = axis === "x" ? n - source.cx + target.cx : n - source.cy + target.cy;
    const lo = (axis === "x" ? target.x0 : target.y0) + margin;
    const hi = (axis === "x" ? target.x1 : target.y1) - width - margin;
    return String(+Math.min(Math.max(shifted, lo), Math.max(lo, hi)).toFixed(3));
  });
  // Without a saved position the keys are left out and the slicer places the tower itself.
  if (project.config.wipe_tower_x === undefined || project.config.wipe_tower_y === undefined) return null;
  return { x: move(project.config.wipe_tower_x, "x"), y: move(project.config.wipe_tower_y, "y") };
}

// Plates whose saved footprint no longer fits the target bed after centring.
function platesOutOfBed(project, source, target) {
  if (!source || !target) return [];
  const dx = target.cx - source.cx;
  const dy = target.cy - source.cy;
  return project.plates
    .filter((p) => p.bbox)
    .filter((p) => {
      const [x0, y0, x1, y1] = p.bbox;
      return x0 + dx < target.x0 - 0.01 || y0 + dy < target.y0 - 0.01 || x1 + dx > target.x1 + 0.01 || y1 + dy > target.y1 + 0.01;
    })
    .map((p) => p.id);
}

export function checkFit(project, machineConfig) {
  return platesOutOfBed(project, project.source.bed, bedRect(machineConfig.printable_area));
}

// ---------- conversion ----------

// target: { printer, machine (data/machines file), process (preset) }
// options: { carry: Set of keys whose original value is kept, merge: boolean }
// slots: the original filament slots (1-based) written to the file, with their original settings.
export function planConversion(project, target, options, keys) {
  const merge = !!options.merge;
  const slots = merge ? [project.usedFilaments[0] || 1] : project.filaments.map((f) => f.index);
  const sourceBed = project.source.bed;
  const targetBed = bedRect(target.machine.config.printable_area);
  // An incompatible original is never written, whatever was chosen.
  const carried = describeDifferences(project, target, keys).filter((row) => !row.incompatible && options.carry.has(row.key));
  return {
    merge,
    slots,
    carried,
    sourceBed,
    targetBed,
    tower: planTower(project, sourceBed, targetBed, target.process),
    outOfBed: platesOutOfBed(project, sourceBed, targetBed),
  };
}

export async function convertProject(project, target, plan, keys, onProgress = () => {}) {
  const config = buildConfig(project, target, plan, keys);
  const replacements = {};
  const removed = new Set();

  // Sliced G-code belongs to the source printer.
  for (const entry of project.entries) {
    if (/^Metadata\/plate_\d+\.gcode(\.md5)?$/.test(entry.name)) removed.add(entry.name);
  }

  let modelXml = moveItems(project.modelXml, plan.sourceBed, plan.targetBed);
  let settingsXml = project.settingsXml;

  if (plan.merge) {
    // One filament: painting would point at slots that no longer exist, so it is dropped.
    const dropPaint = (text) => text.replace(/\s+paint_color="[^"]*"/g, "");
    modelXml = dropPaint(modelXml);
    for (const entry of project.hasPaint ? project.entries : []) {
      if (entry.name.startsWith("3D/Objects/") && entry.name.endsWith(".model") && !removed.has(entry.name)) {
        onProgress(`Removendo a pintura de ${entry.name.split("/").pop()}…`);
        replacements[entry.name] = await transformEntry(entry, dropPaint);
      }
    }
    settingsXml = settingsXml.replace(/(key="extruder"\s+value=")\d+(")/g, "$11$2");
  }
  const count = config.filament_colour.length;
  settingsXml = settingsXml
    .replace(/(key="filament_maps"\s+value=")[^"]*(")/g, `$1${new Array(count).fill("1").join(" ")}$2`)
    .replace(/(key="filament_volume_maps"\s+value=")[^"]*(")/g, `$1${new Array(count).fill("0").join(" ")}$2`);

  // Drop relationships to removed parts (e.g. sliced G-code).
  if (removed.size) {
    for (const entry of project.entries) {
      if (!entry.name.endsWith(".rels") || removed.has(entry.name)) continue;
      const text = await readText(entry);
      const cleaned = text.replace(/[ \t]*<Relationship\b[^>]*\/>\r?\n?/g, (rel) => {
        const targetPath = (attr(rel, "Target") || "").replace(/^\//, "");
        return removed.has(targetPath) ? "" : rel;
      });
      if (cleaned !== text) replacements[entry.name] = await makeEntry(cleaned);
    }
  }

  onProgress("Montando o arquivo…");
  replacements[CONFIG] = await makeEntry(JSON.stringify(config, null, 4));
  if (project.entries.some((e) => e.name === MODEL)) replacements[MODEL] = await makeEntry(modelXml);
  if (project.entries.some((e) => e.name === SETTINGS)) replacements[SETTINGS] = await makeEntry(settingsXml);
  return { blob: writeZip(project.entries, replacements, removed), config };
}
