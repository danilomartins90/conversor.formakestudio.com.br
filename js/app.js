import { readBytes } from "./zip.js?version=1.0.1";
import {
  readProject,
  chooseProcess,
  describeDifferences,
  checkFit,
  planConversion,
  convertProject,
} from "./converter.js?version=1.0.1";

const APP_VERSION = "1.0.1";
const MAX_LISTED = 80;

const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const formatValue = (value) => (Array.isArray(value) ? (new Set(value).size === 1 ? value[0] : value.join(", ")) : value ?? "-");

const state = {
  printers: [],
  keys: null,
  labels: {},
  project: null,
  file: null,
  printer: null,
  machine: null,
  process: null,
  carry: new Set(),
  rows: [],
  thumbUrls: [],
};

const cache = new Map();
async function loadData(path) {
  if (!cache.has(path)) {
    cache.set(path, fetch(`data/${path}?version=${APP_VERSION}`).then((response) => {
      if (!response.ok) throw new Error(`Não foi possível carregar data/${path} (${response.status}).`);
      return response.json();
    }));
  }
  return cache.get(path);
}

function showError(message) {
  $("formError").textContent = message;
  $("formError").hidden = !message;
}

function setStatus(message) {
  $("loadStatus").textContent = message || "";
  $("loadStatus").hidden = !message;
}

const swatch = (colour) => `<span class="swatch" style="background:${escapeHtml(String(colour).slice(0, 7))}"></span>`;

// ---------- step 1: source project ----------

async function openFile(file) {
  showError("");
  setStatus("Lendo o arquivo…");
  try {
    const project = await readProject(await file.arrayBuffer(), setStatus);
    state.project = project;
    state.file = file;
    // The target printer is always picked by hand for each file.
    state.printer = null;
    state.machine = null;
    state.process = null;
    for (const id of ["authorSection", "actions"]) $(id).hidden = true;
    $("warnings").innerHTML = "";
    setStatus("");
    await renderSource();
    $("targetSection").hidden = false;
    renderPrinterList();
  } catch (error) {
    console.error(error);
    state.project = null;
    setStatus("");
    showError(error.message || String(error));
  }
}

async function renderSource() {
  const { project, file } = state;
  const source = project.source;
  $("dropZone").classList.add("loaded");
  $("dropZone").innerHTML = `<span class="drop-file"><strong>${escapeHtml(file.name)}</strong><span>${(file.size / 1048576).toFixed(1)} MB</span></span><span class="drop-change">Trocar arquivo</span>`;
  $("sourcePrinter").textContent = source.printer || "Não identificada";
  const bed = source.bed ? `${source.bed.width}×${source.bed.depth} mm` : "mesa desconhecida";
  $("sourceDetails").textContent = `Bico ${source.nozzle || "?"} · ${bed}`;
  $("sourceProcess").textContent = source.process || "-";
  const count = project.authorChanges.print.length;
  $("sourceAuthor").textContent = count ? `${count} ${count === 1 ? "ajuste" : "ajustes"} do autor no processo` : "Sem ajustes do autor no processo";

  $("sourceFilaments").innerHTML = project.filaments.map((f) => {
    const used = project.usedFilaments.includes(f.index);
    return `<div class="filament-chip${used ? "" : " unused"}">${swatch(f.colour)}<span><strong>${f.index} · ${escapeHtml(f.type || "?")}</strong><small>${escapeHtml(f.name)}${used ? "" : " · não usado"}</small></span></div>`;
  }).join("");

  for (const url of state.thumbUrls) URL.revokeObjectURL(url);
  state.thumbUrls = [];
  $("filamentsTitle").textContent = project.filaments.length === 1 ? "Filamento do projeto" : `${project.filaments.length} filamentos no projeto`;
  $("platesTitle").textContent = project.plates.length === 1 ? "1 mesa" : `${project.plates.length} mesas`;
  const cards = [];
  for (const plate of project.plates) {
    const entry = plate.thumbnail && project.entries.find((e) => e.name === plate.thumbnail);
    let image = "";
    if (entry) {
      const url = URL.createObjectURL(new Blob([await readBytes(entry)], { type: "image/png" }));
      state.thumbUrls.push(url);
      image = `<img src="${url}" alt="Mesa ${plate.id}" />`;
    }
    const colours = plate.filaments.map((i) => swatch(project.filaments[i - 1]?.colour || "#ccc")).join("");
    cards.push(`<div class="plate">${image || '<div class="plate-empty">sem imagem</div>'}<div><strong>Mesa ${plate.id}${plate.name ? ` · ${escapeHtml(plate.name)}` : ""}</strong><small>${plate.instances.length} ${plate.instances.length === 1 ? "objeto" : "objetos"}</small><div class="swatches">${colours}</div></div></div>`);
  }
  $("plates").innerHTML = cards.join("");
  $("sourceInfo").hidden = false;
}

// ---------- step 2: target printer ----------

// Only printers with the original project's nozzle are offered.
function sameNozzlePrinters() {
  const nozzle = Number(state.project?.source.nozzle);
  const same = state.printers.filter((p) => Number(p.nozzle) === nozzle);
  return same.length ? same : state.printers;
}

const searchWords = (text) => String(text).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean);

// Each term must start a word of brand + model, so "x" finds "Kobra X" but not "Max". A term may
// also span words without separators ("ender3" finds "Ender-3").
function searchRank(printer, terms) {
  if (!terms.length) return 0;
  const words = searchWords(`${printer.brand} ${printer.model}`);
  const starts = words.map((_, i) => words.slice(i).join(""));
  if (!terms.every((t) => starts.some((s) => s.startsWith(t)))) return -1;
  const phrase = terms.join(" ");
  const model = searchWords(printer.model).join(" ");
  const full = words.join(" ");
  if (model === phrase || full === phrase) return 0;
  if (` ${full}`.includes(` ${phrase}`)) return 1;
  return 2;
}

function renderPrinterList() {
  const terms = searchWords($("printerSearch").value);
  const pool = sameNozzlePrinters();
  $("targetIntro").textContent = pool === state.printers
    ? "Perfis de impressora do OrcaSlicer. O bico do projeto não foi identificado, então todas as impressoras são mostradas."
    : `Perfis de impressora do OrcaSlicer com bico ${state.project.source.nozzle} mm, o mesmo do projeto original. Impressoras com mais de um bico ainda não são suportadas.`;
  const matches = pool
    .map((p, index) => ({ p, index, rank: searchRank(p, terms) }))
    .filter((m) => m.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((m) => m.p);
  const shown = matches.slice(0, MAX_LISTED);
  $("printerList").innerHTML = shown.map((p) => {
    const selected = state.printer?.id === p.id;
    const bed = p.bed ? `${p.bed[0]}×${p.bed[1]} mm` : "";
    return `<button type="button" class="printer-item${selected ? " selected" : ""}" data-id="${escapeHtml(p.id)}" role="option" aria-selected="${selected}">
      <strong>${escapeHtml(p.model)}</strong>
      <small>${escapeHtml(p.brand)} · bico ${escapeHtml(p.nozzle)} · ${bed}${p.multi ? " · multicor" : " · uma cor"}</small>
    </button>`;
  }).join("") || '<p class="hint">Nenhuma impressora encontrada.</p>';
  $("printerCount").textContent = matches.length > MAX_LISTED
    ? `Mostrando ${MAX_LISTED} de ${matches.length}. Refine a busca.`
    : `${matches.length} ${matches.length === 1 ? "impressora" : "impressoras"}.`;
}

async function selectPrinter(id) {
  showError("");
  const printer = state.printers.find((p) => p.id === id);
  if (!printer) return;
  try {
    state.printer = printer;
    state.machine = await loadData(`machines/${printer.id}.json`);
    const processRef = chooseProcess(state.project, state.machine.processes);
    state.process = await loadData(`processes/${processRef.id}.json`);
    renderSettings();
    renderPrinterList();
  } catch (error) {
    console.error(error);
    showError(error.message || String(error));
  }
}

// ---------- step 3: original × target ----------

const mergeColours = () => !state.printer.multi && state.project.filaments.length > 1;

function renderSettings() {
  const { printer, machine } = state;
  const bed = printer.bed ? `${printer.bed[0]}×${printer.bed[1]} mm` : "";
  $("selectedPrinter").innerHTML = `<span>Destino</span><strong>${escapeHtml(printer.name)}</strong><small>${escapeHtml(printer.brand)} · ${bed}${printer.height ? ` · altura ${printer.height} mm` : ""} · ${printer.multi ? "aceita várias cores" : "uma cor"} · perfis OrcaSlicer ${escapeHtml(machine.version)}</small><small>Comparado com o processo ${escapeHtml(state.process.name)}</small>`;
  renderDifferences();
  renderWarnings();
  $("actions").hidden = false;
}

// Orca's labels rely on the group they sit in ("Externo" under bridge speed); the key's own suffix or
// prefix names that group.
const KEY_GROUPS = [
  [(k) => k.endsWith("_speed"), "Velocidade"],
  [(k) => k.endsWith("_acceleration"), "Aceleração"],
  [(k) => k.endsWith("_jerk"), "Jerk"],
  [(k) => k.startsWith("prime_tower_"), "Torre de purga"],
  [(k) => k.startsWith("ironing_"), "Alisamento"],
];

function settingLabel(key) {
  const label = state.labels[key] || key;
  const group = KEY_GROUPS.find(([test]) => test(key));
  return group ? `${group[1]} · ${label}` : label;
}

const shortValue = (value) => {
  const text = String(formatValue(value));
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
};

function renderDifferences() {
  const { project, keys, labels, printer } = state;
  const target = { machine: state.machine, process: state.process };
  state.rows = describeDifferences(project, target, keys);
  state.carry = new Set(state.rows.filter((r) => r.keep).map((r) => r.key));
  if (!state.rows.length) {
    $("authorChanges").innerHTML = '<p class="hint">O processo original é igual ao perfil da impressora escolhida. Não há o que escolher.</p>';
  } else {
    const head = `<div class="diff-row diff-head"><span>Configuração</span><span>Original</span><span>Perfil ${escapeHtml(printer.model)}</span></div>`;
    $("authorChanges").innerHTML = head + state.rows.map((row) => {
      const label = settingLabel(row.key);
      const problem = {
        "limit-machine": `Acima do máximo da impressora (${formatValue(row.value)})`,
        "limit-flow": `Acima do fluxo máximo do filamento nesta altura de camada (${formatValue(row.value)})`,
        layer: `Fora do limite do bico (${row.layers.min} a ${row.layers.max} mm)`,
        unknown: "Não existe no OrcaSlicer, que ignora esta chave",
      }[row.incompatible] || "";
      const note = row.author ? "ajuste do autor" : "";
      const name = `diff-${row.key}`;
      const keep = state.carry.has(row.key);
      const original = row.capped ? row.source : row.value;
      const targetText = row.target === undefined ? "padrão do OrcaSlicer" : shortValue(row.target);
      return `<div class="diff-row${row.incompatible ? " incompatible" : ""}">
        <span class="change-name"><strong>${escapeHtml(label)}</strong><code>${escapeHtml(row.key)}</code>${note ? `<small>${escapeHtml(note)}</small>` : ""}${problem ? `<em class="diff-problem">${escapeHtml(problem)}</em>` : ""}</span>
        <label class="diff-option"><input type="radio" name="${escapeHtml(name)}" data-key="${escapeHtml(row.key)}" value="original" ${keep ? "checked" : ""}${row.incompatible ? " disabled" : ""} /><span><small>Original</small><b title="${escapeHtml(formatValue(original))}">${escapeHtml(shortValue(original))}</b></span></label>
        <label class="diff-option"><input type="radio" name="${escapeHtml(name)}" data-key="${escapeHtml(row.key)}" value="target" ${keep ? "" : "checked"} /><span><small>Seu perfil</small><b title="${escapeHtml(formatValue(row.target))}">${escapeHtml(targetText)}</b></span></label>
      </div>`;
    }).join("");
    for (const radio of $("authorChanges").querySelectorAll("input[type=radio]")) {
      radio.addEventListener("change", () => {
        if (radio.value === "original") state.carry.add(radio.dataset.key);
        else state.carry.delete(radio.dataset.key);
        renderDiffCount();
      });
    }
  }
  renderDiffCount();
  const notes = [];
  if (project.authorChanges.printer.length) {
    notes.push(`Ajustes na impressora de origem (${project.authorChanges.printer.map((k) => escapeHtml(labels[k] || k)).join(", ")}) não são levados.`);
  }
  $("authorNotes").innerHTML = notes.map((n) => `<p class="hint">${n}</p>`).join("");
  $("authorSection").hidden = false;
}

function renderDiffCount() {
  const total = state.rows.length;
  const kept = state.rows.filter((r) => state.carry.has(r.key)).length;
  const incompatible = state.rows.filter((r) => r.incompatible).length;
  $("diffCount").textContent = total
    ? `${total} ${total === 1 ? "diferença" : "diferenças"} · ${kept} com o valor do original · ${total - kept} com o valor do seu perfil${incompatible ? ` · ${incompatible} ${incompatible === 1 ? "incompatível" : "incompatíveis"}` : ""}`
    : "";
}

function renderWarnings() {
  const { project, printer } = state;
  const warnings = [];
  if (!/^(BambuStudio|OrcaSlicer)-/.test(project.application)) {
    warnings.push(`Este 3MF foi salvo por "${escapeHtml(project.application || "programa desconhecido")}". O conversor foi feito para projetos do Bambu Studio e do OrcaSlicer.`);
  }
  if (mergeColours() && project.usedFilaments.length > 1) {
    warnings.push(`A ${escapeHtml(printer.model)} não tem troca de filamento no OrcaSlicer. As ${project.usedFilaments.length} cores do projeto saem num filamento só e a pintura das peças é removida.`);
  } else if (mergeColours()) {
    warnings.push(`A ${escapeHtml(printer.model)} imprime uma cor. O projeto sai com um filamento só.`);
  }
  const outOfBed = checkFit(project, state.machine.config);
  if (outOfBed.length && printer.bed) {
    warnings.push(`Mesa ${outOfBed.join(", ")}: as peças passam da área de ${printer.bed[0]}×${printer.bed[1]} mm. Depois de abrir, reorganize ou divida as peças no fatiador.`);
  }
  $("warnings").innerHTML = warnings.map((w) => `<div class="warning">${w}</div>`).join("");
}

// ---------- convert ----------

async function convert() {
  showError("");
  const button = $("convertButton");
  const label = button.textContent;
  button.disabled = true;
  try {
    const target = { printer: state.printer, machine: state.machine, process: state.process };
    const plan = planConversion(state.project, target, { carry: state.carry, merge: mergeColours() }, state.keys);
    const { blob } = await convertProject(state.project, target, plan, state.keys, (message) => {
      button.textContent = message;
    });
    const base = state.file.name.replace(/\.3mf$/i, "");
    const fileName = `${base}_${state.printer.name.replace(/[^A-Za-z0-9.]+/g, "_")}.3mf`;
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (error) {
    console.error(error);
    showError(`Falha na conversão: ${error.message || error}`);
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

function resetFile() {
  $("fileInput").value = "";
  $("fileInput").click();
}

// ---------- wiring ----------

function bindEvents() {
  const drop = $("dropZone");
  drop.addEventListener("click", () => $("fileInput").click());
  drop.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      $("fileInput").click();
    }
  });
  drop.addEventListener("dragover", (event) => {
    event.preventDefault();
    drop.classList.add("over");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (event) => {
    event.preventDefault();
    drop.classList.remove("over");
    const file = event.dataTransfer.files[0];
    if (file) openFile(file);
  });
  $("fileInput").addEventListener("change", (event) => {
    const file = event.target.files[0];
    if (file) openFile(file);
  });
  $("printerSearch").addEventListener("input", renderPrinterList);
  $("printerList").addEventListener("click", (event) => {
    const item = event.target.closest(".printer-item");
    if (item) selectPrinter(item.dataset.id);
  });
  $("convertButton").addEventListener("click", convert);
  $("resetButton").addEventListener("click", resetFile);
}

async function init() {
  bindEvents();
  try {
    const [printers, keys, labels, meta] = await Promise.all([
      loadData("printers.json"),
      loadData("keys.json"),
      loadData("labels.json"),
      loadData("meta.json"),
    ]);
    state.printers = printers;
    state.keys = keys;
    state.labels = labels;
    $("buildInfo").textContent = `Versão: ${APP_VERSION} · perfis do OrcaSlicer ${meta.orcaVersion} (${meta.printers} impressoras, gerados em ${meta.generatedAt})`;
  } catch (error) {
    console.error(error);
    showError(`Não foi possível carregar os perfis de impressora: ${error.message || error}`);
  }
}

init();
