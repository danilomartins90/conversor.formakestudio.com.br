#!/usr/bin/env node
// Generates data/ from an OrcaSlicer checkout: one resolved machine file per single-extruder
// printer, plus the process presets those printers can use.
//
// Usage: node tools/generate-profiles.mjs [--orca <OrcaSlicer root>] [--out <data dir>]
//
// The rules below mirror OrcaSlicer's loader (src/libslic3r/Preset*.cpp, PrintConfig.cpp):
// - inherits resolves inside the bundle;
// - composition: parent config, then each include, then the preset's own keys;
// - variant keys are resized to the preset's own *_extruder_variant length (pad with the first value);
// - keys that belong to another preset type are dropped.
// Known gap: an include should only pass keys that differ from the built-in defaults, which live
// in C++; here every composed key of the included template is applied.

import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const argValue = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const ORCA = path.resolve(argValue("--orca", path.join(ROOT, "insumos_para_desenvolvimento/OrcaSlicer-2.5.1")));
const OUT = path.resolve(argValue("--out", path.join(ROOT, "data")));
const PROFILES = path.join(ORCA, "resources/profiles");

// ---------- option key lists, read from the C++ sources ----------

function cppStrings(text, startMarker) {
  const start = text.indexOf(startMarker);
  if (start < 0) throw new Error(`marker not found: ${startMarker}`);
  const end = text.indexOf("};", start);
  const body = text.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

function readKeyLists() {
  const src = (f) => fs.readFileSync(path.join(ORCA, "src/libslic3r", f), "utf8");
  const preset = src("Preset.cpp");
  const printConfig = src("PrintConfig.cpp");
  const bundle = src("PresetBundle.cpp");
  const lists = {
    print: cppStrings(preset, "static std::vector<std::string> s_Preset_print_options"),
    filament: cppStrings(preset, "static std::vector<std::string> s_Preset_filament_options"),
    printer: [
      ...cppStrings(preset, "static std::vector<std::string> s_Preset_printer_options"),
      ...cppStrings(preset, "static std::vector<std::string> s_Preset_machine_limits_options"),
      ...cppStrings(printConfig, "m_extruder_option_keys = {"),
    ],
    project: cppStrings(bundle, "static std::vector<std::string> s_project_options {"),
    printVariant: cppStrings(printConfig, "std::set<std::string> print_options_with_variant = {"),
    printerVariant1: cppStrings(printConfig, "std::set<std::string> printer_options_with_variant_1 = {"),
    printerVariant2: cppStrings(printConfig, "std::set<std::string> printer_options_with_variant_2 = {"),
  };
  for (const [name, values] of Object.entries(lists)) {
    if (!values.length) throw new Error(`empty key list: ${name}`);
  }
  return lists;
}

// Setting labels (def->label in PrintConfig.cpp) translated with the pt_BR catalog, untranslated as fallback.
function readLabels() {
  const printConfig = fs.readFileSync(path.join(ORCA, "src/libslic3r/PrintConfig.cpp"), "utf8");
  const english = {};
  const parts = printConfig.split(/this->add(?:_nullable)?\("/);
  for (const part of parts.slice(1)) {
    const key = part.slice(0, part.indexOf('"'));
    const label = part.match(/def->label\s*=\s*L\("((?:\\.|[^"\\])*)"\)/);
    if (label && !english[key]) english[key] = label[1].replace(/\\"/g, '"');
  }
  const translations = {};
  const poFile = path.join(ORCA, "localization/i18n/pt_BR/OrcaSlicer_pt_BR.po");
  if (fs.existsSync(poFile)) {
    const unquote = (lines) => lines.map((l) => JSON.parse(l.trim())).join("");
    for (const block of fs.readFileSync(poFile, "utf8").split(/\r?\n\r?\n/)) {
      if (/^msgctxt/m.test(block)) continue;
      const id = block.match(/^msgid ((?:"(?:\\.|[^"\\])*"\s*)+)/m);
      const str = block.match(/^msgstr ((?:"(?:\\.|[^"\\])*"\s*)+)/m);
      if (!id || !str) continue;
      try {
        const msgid = unquote(id[1].trim().split(/\n/));
        const msgstr = unquote(str[1].trim().split(/\n/));
        if (msgid && msgstr) translations[msgid] = msgstr;
      } catch {
        // malformed entry, ignore
      }
    }
  }
  const labels = {};
  for (const [key, label] of Object.entries(english)) labels[key] = translations[label] || label;
  return labels;
}

// ---------- bundles ----------

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));

function loadBundle(vendor) {
  const index = readJson(path.join(PROFILES, `${vendor}.json`));
  const bundle = { vendor, index, machine_model: {}, machine: {}, process: {} };
  const lists = { machine_model_list: "machine_model", machine_list: "machine", process_list: "process" };
  for (const [list, type] of Object.entries(lists)) {
    for (const entry of index[list] || []) {
      try {
        bundle[type][entry.name] = readJson(path.join(PROFILES, vendor, entry.sub_path));
      } catch (error) {
        warn(`${vendor}: ${entry.sub_path}: ${error.message}`);
      }
    }
  }
  return bundle;
}

const warnings = [];
const warn = (message) => warnings.push(message);

// ---------- composition ----------

const META_KEYS = new Set([
  "name", "inherits", "include", "from", "instantiation", "setting_id", "type", "renamed_from",
  "filament_id", "description",
]);
const KEEP_META = ["name", "filament_id", "compatible_printers", "compatible_printers_condition", "compatible_prints", "compatible_prints_condition"];

function createComposer(keys) {
  const caches = new Map();
  const variantRules = {
    machine: { list: "printer_extruder_variant", sets: [[new Set(keys.printerVariant1), 1], [new Set(keys.printerVariant2), 2]] },
    process: { list: "print_extruder_variant", sets: [[new Set(keys.printVariant), 1]] },
  };

  function find(bundle, type, name) {
    if (bundle[type][name]) return { bundle, raw: bundle[type][name] };
    return null;
  }

  function resize(type, config) {
    const rule = variantRules[type];
    const variants = Array.isArray(config[rule.list]) && config[rule.list].length ? config[rule.list].length : 1;
    for (const [set, stride] of rule.sets) {
      for (const key of set) {
        const value = config[key];
        if (!Array.isArray(value) || !value.length) continue;
        const width = variants * stride;
        if (value.length === width) continue;
        config[key] = Array.from({ length: width }, (_, i) => (i < value.length ? value[i] : value[0]));
      }
    }
    return config;
  }

  function compose(bundle, type, name, stack = []) {
    const found = find(bundle, type, name);
    if (!found) throw new Error(`${bundle.vendor}: ${type} "${name}" not found`);
    const cacheKey = `${found.bundle.vendor}|${type}|${name}`;
    if (caches.has(cacheKey)) return caches.get(cacheKey);
    if (stack.includes(cacheKey)) throw new Error(`inheritance cycle at ${cacheKey}`);
    const raw = found.raw;
    const config = raw.inherits ? structuredClone(compose(found.bundle, type, raw.inherits, [...stack, cacheKey])) : {};
    for (const includeName of [].concat(raw.include || [])) {
      const template = found.bundle[type][includeName];
      if (!template || String(template.instantiation) !== "false") {
        warn(`${found.bundle.vendor}: ${type} "${name}" can not find include "${includeName}"`);
        continue;
      }
      const included = compose(found.bundle, type, includeName, [...stack, cacheKey]);
      for (const [key, value] of Object.entries(included)) {
        if (!META_KEYS.has(key)) config[key] = structuredClone(value);
      }
    }
    for (const [key, value] of Object.entries(raw)) {
      if (key !== "include") config[key] = structuredClone(value);
    }
    config.name = name;
    resize(type, config);
    caches.set(cacheKey, config);
    return config;
  }

  return { compose, find };
}

function onlyTypeKeys(config, allowed) {
  const out = {};
  for (const key of KEEP_META) if (config[key] !== undefined) out[key] = config[key];
  for (const key of Object.keys(config)) if (allowed.has(key)) out[key] = config[key];
  return out;
}

// ---------- compatibility (Preset.cpp is_compatible_with_printer) ----------

// Covers the expression shapes used by compatible_printers_condition in the profiles:
// key=~/re/, key!~/re/, key[i]==value, key==value, key!=value, bare key, and/or/not, parentheses.
function evaluateCondition(expression, machine) {
  const tokens = [];
  const re = /\s*(\(|\)|and\b|or\b|not\b|[A-Za-z_][A-Za-z0-9_]*(?:\[\d+\])?|=~|!~|==|!=|\/(?:\\.|[^/])*\/|"(?:\\.|[^"])*"|-?\d+(?:\.\d+)?)/y;
  let pos = 0;
  while (pos < expression.length) {
    re.lastIndex = pos;
    const m = re.exec(expression);
    if (!m) {
      if (!expression.slice(pos).trim()) break;
      throw new Error(`unsupported condition: ${expression}`);
    }
    tokens.push(m[1]);
    pos = re.lastIndex;
  }
  let i = 0;
  const peek = () => tokens[i];
  const lookup = (token) => {
    const m = token.match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\[(\d+)\])?$/);
    if (!m) throw new Error(`bad operand ${token}`);
    let value = machine[m[1]];
    if (Array.isArray(value)) value = value[m[2] ? Number(m[2]) : 0];
    return value === undefined ? "" : String(value);
  };
  const literal = (token) => (token.startsWith('"') ? JSON.parse(token) : token);
  const primary = () => {
    const token = tokens[i++];
    if (token === "(") {
      const value = orExpr();
      if (tokens[i++] !== ")") throw new Error("missing )");
      return value;
    }
    if (token === "not") return !primary();
    const left = lookup(token);
    const op = peek();
    if (op === "=~" || op === "!~") {
      i++;
      const regex = tokens[i++];
      const matched = new RegExp(regex.slice(1, -1)).test(left);
      return op === "=~" ? matched : !matched;
    }
    if (op === "==" || op === "!=") {
      i++;
      const right = literal(tokens[i++]);
      const numeric = !isNaN(Number(left)) && !isNaN(Number(right)) && left !== "" && right !== "";
      const equal = numeric ? Number(left) === Number(right) : left === right;
      return op === "==" ? equal : !equal;
    }
    return left === "1" || left === "true";
  };
  const andExpr = () => {
    let value = primary();
    while (peek() === "and") { i++; value = primary() && value; }
    return value;
  };
  const orExpr = () => {
    let value = andExpr();
    while (peek() === "or") { i++; value = andExpr() || value; }
    return value;
  };
  const result = orExpr();
  if (i !== tokens.length) throw new Error(`trailing tokens in condition: ${expression}`);
  return result;
}

function isCompatible(preset, machine) {
  const list = preset.compatible_printers;
  const hasList = Array.isArray(list) && list.length > 0;
  const condition = preset.compatible_printers_condition || "";
  if (!hasList && condition) {
    try {
      return evaluateCondition(condition, machine);
    } catch (error) {
      warn(error.message);
      return false;
    }
  }
  return !hasList || list.includes(machine.name);
}

// ---------- helpers ----------

const first = (value) => (Array.isArray(value) ? value[0] : value);

function fnv(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x1000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0").slice(0, 6);
}

const slug = (vendor, name) =>
  `${vendor}-${name}`.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 70) +
  "-" + fnv(`${vendor}|${name}`);

function bedSize(area) {
  const list = typeof area === "string" ? area.split(",") : area || [];
  const points = list.map((p) => String(p).split("x").map(Number)).filter((p) => p.length === 2 && p.every(Number.isFinite));
  if (!points.length) return null;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
}

// Removes the .json files this script generates, so presets dropped upstream do not linger.
function clearGenerated(dir) {
  if (!fs.existsSync(dir)) return;
  for (const file of fs.readdirSync(dir)) if (file.endsWith(".json")) fs.unlinkSync(path.join(dir, file));
}

// ---------- main ----------

function main() {
  if (!fs.existsSync(PROFILES)) throw new Error(`OrcaSlicer profiles not found at ${PROFILES}`);
  const keys = readKeyLists();
  const allowed = {
    machine: new Set(keys.printer),
    process: new Set(keys.print),
  };

  const composer = createComposer(keys);
  const vendors = fs.readdirSync(PROFILES)
    .filter((f) => f.endsWith(".json") && f !== "blacklist.json" && f !== "OrcaFilamentLibrary.json")
    .map((f) => f.slice(0, -5))
    .sort((a, b) => a.localeCompare(b));

  for (const sub of ["machines", "processes"]) clearGenerated(path.join(OUT, sub));

  const printers = [];
  const writtenProcesses = new Map();
  const skipped = { multiExtruder: 0, noProcess: 0, errors: 0 };

  for (const vendor of vendors) {
    let bundle;
    try {
      bundle = loadBundle(vendor);
    } catch (error) {
      warn(`${vendor}: bundle not loaded: ${error.message}`);
      continue;
    }
    const vendorName = bundle.index.name || vendor;
    const version = bundle.index.version || "";
    const instantiable = (type) => Object.keys(bundle[type]).filter((n) => String(bundle[type][n].instantiation) === "true");

    const processes = [];
    for (const name of instantiable("process")) {
      try {
        processes.push(composer.compose(bundle, "process", name));
      } catch (error) {
        warn(error.message);
      }
    }
    for (const machineName of instantiable("machine")) {
      let machine;
      try {
        machine = composer.compose(bundle, "machine", machineName);
      } catch (error) {
        warn(error.message);
        skipped.errors++;
        continue;
      }
      const nozzles = [].concat(machine.nozzle_diameter || ["0.4"]);
      if (nozzles.length !== 1) {
        skipped.multiExtruder++;
        continue;
      }

      // Process presets: compatible ones, the default first.
      const compatibleProcesses = processes.filter((p) => isCompatible(p, machine));
      const defaultName = first(machine.default_print_profile);
      let defaultProcess = compatibleProcesses.find((p) => p.name === defaultName);
      if (!defaultProcess && bundle.process[defaultName]) {
        try {
          defaultProcess = composer.compose(bundle, "process", defaultName);
          compatibleProcesses.unshift(defaultProcess);
        } catch (error) {
          warn(error.message);
        }
      }
      if (!defaultProcess) {
        defaultProcess = [...compatibleProcesses].sort((a, b) =>
          Math.abs(Number(first(a.layer_height)) - 0.2) - Math.abs(Number(first(b.layer_height)) - 0.2) ||
          Number(!/standard/i.test(b.name)) - Number(!/standard/i.test(a.name)))[0];
        if (defaultProcess) warn(`${vendor}: "${machineName}" default process "${defaultName}" missing, using "${defaultProcess.name}"`);
      }
      if (!defaultProcess) {
        skipped.noProcess++;
        continue;
      }

      const processRef = (p) => {
        const id = slug(vendor, p.name);
        if (!writtenProcesses.has(id)) {
          writtenProcesses.set(id, true);
          writeJson(path.join(OUT, "processes", `${id}.json`), onlyTypeKeys(p, allowed.process));
        }
        return { id, name: p.name, layer: first(p.layer_height) || "" };
      };
      const id = slug(vendor, machineName);
      const machineConfig = onlyTypeKeys(machine, allowed.machine);
      const processList = [defaultProcess, ...compatibleProcesses.filter((p) => p !== defaultProcess)].map(processRef);
      const semm = String(first(machine.single_extruder_multi_material)) === "1";
      writeJson(path.join(OUT, "machines", `${id}.json`), {
        vendor,
        version,
        config: machineConfig,
        processes: processList,
      });
      printers.push({
        id,
        name: machineName,
        model: machine.printer_model || machineName,
        brand: vendorName,
        nozzle: String(nozzles[0]),
        bed: bedSize(machine.printable_area),
        height: Number(first(machine.printable_height)) || null,
        // Orca shows the add/remove filament buttons only for SEMM printers or the BBL vendor.
        multi: semm || vendor === "BBL",
      });
    }
  }

  printers.sort((a, b) => a.brand.localeCompare(b.brand) || a.model.localeCompare(b.model) || Number(a.nozzle) - Number(b.nozzle));
  writeJson(path.join(OUT, "printers.json"), printers);
  writeJson(path.join(OUT, "keys.json"), {
    print: keys.print,
    filament: keys.filament,
    printer: keys.printer,
    project: keys.project,
    printVariant: keys.printVariant,
    printerVariant1: keys.printerVariant1,
    printerVariant2: keys.printerVariant2,
  });
  writeJson(path.join(OUT, "labels.json"), readLabels());
  const orcaVersion = (fs.readFileSync(path.join(ORCA, "version.inc"), "utf8").match(/SoftFever_VERSION\s+"([^"]+)"/) || [])[1] || "";
  writeJson(path.join(OUT, "meta.json"), { orcaVersion, generatedAt: new Date().toISOString().slice(0, 10), printers: printers.length });

  console.log(`printers: ${printers.length}`);
  console.log(`processes: ${writtenProcesses.size}`);
  console.log(`skipped: ${JSON.stringify(skipped)}`);
  console.log(`warnings: ${warnings.length}`);
  if (args.includes("--verbose")) for (const w of warnings) console.log("  " + w);
}

main();
