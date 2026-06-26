const TASK_COLORS = [
  "#e07b54", "#5b8fcf", "#74b58a", "#c47bb5", "#e8b84b",
  "#7bb5c4", "#b58a74", "#c4a07b", "#8ab574", "#a07bc4",
  "#d4416c", "#4a90a4", "#e88c4b", "#6d8cc4", "#9bc44b"
];

const DEFAULT_PEOPLE = [
  { id: "juli", name: "Juli", color: "#e07b54" },
  { id: "meli", name: "Meli", color: "#5b8fcf" },
  { id: "adri", name: "Adriana", color: "#74b58a" }
];

const DAYS_SHORT = ["Lun", "Mar", "Mie", "Jue", "Vie", "Sab", "Dom"];
const STORAGE_KEY = "casaOrganizada_v3";
const BA_TIMEZONE = "America/Argentina/Buenos_Aires";
const REMOTE_SYNC_INTERVAL_MS = 15000;

let state = {
  tasks: [],
  checks: {},
  people: DEFAULT_PEOPLE.map((person) => ({ ...person })),
  weekOffset: 0,
  editingTaskId: null,
  newTask: {
    name: "",
    note: "",
    assignments: Array(7).fill(null)
  }
};

let lastRemoteRevision = null;
let remotePollTimer = null;

function getStateSnapshot() {
  return {
    tasks: state.tasks,
    checks: state.checks,
    people: state.people
  };
}

function shouldUseRemoteState() {
  return typeof window !== "undefined" && window.location.protocol !== "file:";
}

function persistLocalSnapshot(snapshot) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
}

async function fetchRemoteState() {
  if (!shouldUseRemoteState()) {
    return null;
  }

  const response = await fetch("/api/state", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`No se pudo obtener estado remoto (${response.status})`);
  }

  const payload = await response.json();
  if (!payload || typeof payload !== "object" || !payload.data || typeof payload.data !== "object") {
    throw new Error("Respuesta remota invalida");
  }

  return payload;
}

async function pushRemoteState(snapshot) {
  if (!shouldUseRemoteState()) {
    return;
  }

  const response = await fetch("/api/state", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ data: snapshot })
  });

  if (!response.ok) {
    throw new Error(`No se pudo guardar estado remoto (${response.status})`);
  }

  const payload = await response.json();
  if (payload && typeof payload.revision === "string") {
    lastRemoteRevision = payload.revision;
  }
}

function downloadDataJson() {
  const blob = new Blob([JSON.stringify(getStateSnapshot(), null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `casa-organizada-${getBuenosAiresTodayKey()}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function openImportJsonDialog() {
  const input = document.getElementById("import-json-input");
  if (!input) {
    return;
  }
  input.value = "";
  input.click();
}

async function importDataJsonFromFile(file) {
  if (!file) {
    return;
  }

  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") {
      throw new Error("Formato invalido");
    }

    hydrateStateFromData(parsed);
    state.weekOffset = 0;
    state.editingTaskId = null;
    state.newTask = {
      name: "",
      note: "",
      assignments: emptyAssignments()
    };

    saveState();
    renderPeopleLegend();
    renderWeekLabel();
    renderCalendar();
    renderDebts();
    renderAssignmentGrid();
    showToast("✅ JSON importado correctamente");
  } catch (error) {
    console.error(error);
    showToast("⚠ No se pudo importar el JSON");
  }
}

function makeTaskId() {
  return "task_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
}

function emptyAssignments() {
  return Array(7).fill(null);
}

function isValidHexColor(color) {
  return typeof color === "string" && /^#[0-9a-fA-F]{6}$/.test(color);
}

function createPersonId(name) {
  const base = (name || "persona")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "persona";

  let candidate = base;
  let n = 1;
  while (state.people.some((person) => person.id === candidate)) {
    n += 1;
    candidate = `${base}-${n}`;
  }

  return candidate;
}

function normalizePeople(people, legacyColors) {
  const fallback = DEFAULT_PEOPLE.map((person) => ({ ...person }));

  if (!Array.isArray(people) || people.length === 0) {
    if (legacyColors && typeof legacyColors === "object") {
      fallback.forEach((person) => {
        const legacy = legacyColors[person.id];
        if (isValidHexColor(legacy)) {
          person.color = legacy;
        }
      });
    }
    return fallback;
  }

  const seenIds = new Set();
  const normalized = [];
  people.forEach((person, index) => {
    if (!person || typeof person !== "object") {
      return;
    }

    let id = typeof person.id === "string" && person.id.trim() ? person.id.trim() : `persona-${index + 1}`;
    if (seenIds.has(id)) {
      id = `${id}-${index + 1}`;
    }
    seenIds.add(id);

    const name = typeof person.name === "string" && person.name.trim() ? person.name.trim() : `Persona ${index + 1}`;
    const color = isValidHexColor(person.color) ? person.color : TASK_COLORS[index % TASK_COLORS.length];

    normalized.push({ id, name, color });
  });

  return normalized.length > 0 ? normalized : fallback;
}

function personExists(personId) {
  return state.people.some((person) => person.id === personId);
}

function getPersonName(personId) {
  const person = state.people.find((item) => item.id === personId);
  return person ? person.name : "Sin persona";
}

function normalizeAssignments(assignments) {
  const result = emptyAssignments();
  if (!Array.isArray(assignments)) {
    return result;
  }

  for (let i = 0; i < 7; i += 1) {
    const value = assignments[i];
    result[i] = personExists(value) ? value : null;
  }

  // Adriana solo una vez por semana
  let adriFound = false;
  for (let i = 0; i < 7; i += 1) {
    if (result[i] !== "adri") {
      continue;
    }
    if (!adriFound) {
      adriFound = true;
    } else {
      result[i] = null;
    }
  }

  return result;
}

function countAssignedDays(assignments) {
  return assignments.filter(Boolean).length;
}

function mixColorWithWhite(hexColor, whiteRatio) {
  const base = hexColor.replace("#", "");
  const r = Number.parseInt(base.slice(0, 2), 16);
  const g = Number.parseInt(base.slice(2, 4), 16);
  const b = Number.parseInt(base.slice(4, 6), 16);

  const rr = Math.round(r + (255 - r) * whiteRatio);
  const gg = Math.round(g + (255 - g) * whiteRatio);
  const bb = Math.round(b + (255 - b) * whiteRatio);

  return `rgb(${rr}, ${gg}, ${bb})`;
}


function renderPeopleLegend() {
  const container = document.getElementById("people-legend-items");
  if (!container) {
    return;
  }

  container.innerHTML = state.people.map((person) => `
    <div class="legend-item">
      <input
        class="person-color-picker"
        type="color"
        value="${person.color}"
        aria-label="Color de ${person.name}"
        onchange="updatePersonColor('${person.id}', this.value)"
      >
      <button type="button" class="legend-person-name" onclick="renamePerson('${person.id}')">${person.name}</button>
      <button
        type="button"
        class="legend-remove-person"
        onclick="removePerson('${person.id}')"
        ${state.people.length <= 1 ? "disabled" : ""}
        title="Eliminar persona"
      >✕</button>
    </div>
  `).join("");
}

function updatePersonColor(personId, color) {
  if (!isValidHexColor(color)) {
    return;
  }

  const person = state.people.find((item) => item.id === personId);
  if (!person) {
    return;
  }

  person.color = color;
  saveState();
  renderPeopleLegend();
  renderCalendar();
  renderDebts();
}

function renamePerson(personId) {
  const person = state.people.find((item) => item.id === personId);
  if (!person) {
    return;
  }

  const nextName = window.prompt("Nuevo nombre de la persona:", person.name);
  if (!nextName) {
    return;
  }

  person.name = nextName.trim() || person.name;
  saveState();
  renderPeopleLegend();
  renderCalendar();
  renderDebts();
  renderAssignmentGrid();
}

function addPerson() {
  const name = window.prompt("Nombre de la nueva persona:");
  if (!name || !name.trim()) {
    return;
  }

  const person = {
    id: createPersonId(name),
    name: name.trim(),
    color: TASK_COLORS[state.people.length % TASK_COLORS.length]
  };

  state.people.push(person);
  saveState();
  renderPeopleLegend();
  renderCalendar();
  renderDebts();
  renderAssignmentGrid();
}

function removePerson(personId) {
  if (state.people.length <= 1) {
    showToast("⚠ Debe quedar al menos una persona");
    return;
  }

  const person = state.people.find((item) => item.id === personId);
  if (!person) {
    return;
  }

  const confirmed = window.confirm(`Eliminar a ${person.name}? Se quitara de las asignaciones.`);
  if (!confirmed) {
    return;
  }

  state.people = state.people.filter((item) => item.id !== personId);
  state.tasks.forEach((task) => {
    task.assignments = task.assignments.map((assigned) => (assigned === personId ? null : assigned));
  });
  state.newTask.assignments = state.newTask.assignments.map((assigned) => (assigned === personId ? null : assigned));

  saveState();
  renderPeopleLegend();
  renderCalendar();
  renderDebts();
  renderAssignmentGrid();
}

function getAssigneeForDate(task, date) {
  const dayIndex = dateKeyToDayIndex(date);
  return task.assignments[dayIndex] || null;
}

function hydrateStateFromData(parsed) {
  state.checks = parsed.checks || {};
  state.people = normalizePeople(parsed.people, parsed.personColors);

  state.tasks = (parsed.tasks || []).map((task) => {
    // Migracion desde modelo anterior: person + days
    if (!task.assignments && task.person && Array.isArray(task.days)) {
      const migrated = emptyAssignments();
      task.days.forEach((dayIndex) => {
        if (dayIndex >= 0 && dayIndex <= 6 && personExists(task.person)) {
          if (task.person === "adri") {
            if (!migrated.includes("adri")) {
              migrated[dayIndex] = "adri";
            }
          } else {
            migrated[dayIndex] = task.person;
          }
        }
      });
      return {
        id: task.id || makeTaskId(),
        name: task.name || "Tarea sin nombre",
        note: typeof task.note === "string" ? task.note : "",
        assignments: normalizeAssignments(migrated)
      };
    }

    return {
      id: task.id || makeTaskId(),
      name: task.name || "Tarea sin nombre",
      note: typeof task.note === "string" ? task.note : typeof task.notes === "string" ? task.notes : "",
      assignments: normalizeAssignments(task.assignments)
    };
  });
}

async function loadState() {
  if (shouldUseRemoteState()) {
    try {
      const remote = await fetchRemoteState();
      if (remote && remote.data) {
        hydrateStateFromData(remote.data);
        lastRemoteRevision = typeof remote.revision === "string" ? remote.revision : null;
        persistLocalSnapshot(getStateSnapshot());
        return;
      }
    } catch (error) {
      console.warn("No se pudo cargar estado remoto, uso cache local", error);
    }
  }

  try {
    const saved = localStorage.getItem(STORAGE_KEY) || localStorage.getItem("casaOrganizada_v2");
    if (!saved) {
      return;
    }

    const parsed = JSON.parse(saved);
    hydrateStateFromData(parsed);
  } catch (error) {
    console.error(error);
  }
}

function saveState() {
  const snapshot = getStateSnapshot();
  persistLocalSnapshot(snapshot);

  if (shouldUseRemoteState()) {
    void pushRemoteState(snapshot).catch((error) => {
      console.error(error);
      showToast("⚠ No se pudo sincronizar con el servidor");
    });
  }
}

function startRemotePolling() {
  if (!shouldUseRemoteState()) {
    return;
  }

  if (remotePollTimer) {
    clearInterval(remotePollTimer);
  }

  remotePollTimer = setInterval(() => {
    void refreshRemoteState();
  }, REMOTE_SYNC_INTERVAL_MS);
}

async function refreshRemoteState() {
  if (!shouldUseRemoteState()) {
    return;
  }

  try {
    const remote = await fetchRemoteState();
    if (!remote || !remote.data) {
      return;
    }

    const incomingRevision = typeof remote.revision === "string" ? remote.revision : null;
    if (!incomingRevision || incomingRevision === lastRemoteRevision) {
      return;
    }

    hydrateStateFromData(remote.data);
    lastRemoteRevision = incomingRevision;
    persistLocalSnapshot(getStateSnapshot());
    renderPeopleLegend();
    renderWeekLabel();
    renderCalendar();
    renderDebts();
    renderAssignmentGrid();
  } catch (error) {
    console.warn("No se pudo refrescar estado remoto", error);
  }
}

function keyFromParts(year, month, day) {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function keyToParts(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return { year, month, day };
}

function getBuenosAiresTodayKey() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BA_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const day = Number(parts.find((part) => part.type === "day")?.value);
  return keyFromParts(year, month, day);
}

function addDaysToKey(dateKey, days) {
  const { year, month, day } = keyToParts(dateKey);
  const utc = new Date(Date.UTC(year, month - 1, day));
  utc.setUTCDate(utc.getUTCDate() + days);
  return keyFromParts(utc.getUTCFullYear(), utc.getUTCMonth() + 1, utc.getUTCDate());
}

function dateKeyToDayIndex(dateKey) {
  const { year, month, day } = keyToParts(dateKey);
  const utc = new Date(Date.UTC(year, month - 1, day));
  const dayOfWeek = utc.getUTCDay();
  return dayOfWeek === 0 ? 6 : dayOfWeek - 1;
}

function getMondayKey(dateKey) {
  return addDaysToKey(dateKey, -dateKeyToDayIndex(dateKey));
}

function getWeekDateKeys() {
  const monday = addDaysToKey(getMondayKey(getBuenosAiresTodayKey()), state.weekOffset * 7);
  return Array.from({ length: 7 }, (_, index) => addDaysToKey(monday, index));
}

function dateFromKeyForDisplay(dateKey) {
  return new Date(`${dateKey}T12:00:00-03:00`);
}

function formatShortDateFromKey(dateKey) {
  return dateFromKeyForDisplay(dateKey).toLocaleDateString("es-ES", { day: "numeric", month: "short" });
}

function friendlyDate(dateKey) {
  return dateFromKeyForDisplay(dateKey).toLocaleDateString("es-ES", {
    weekday: "long",
    day: "numeric",
    month: "long"
  });
}

function renderWeekLabel() {
  const dateKeys = getWeekDateKeys();
  document.getElementById("week-label").textContent = `${formatShortDateFromKey(dateKeys[0])} - ${formatShortDateFromKey(dateKeys[6])}`;
}

function renderDebts() {
  const today = getBuenosAiresTodayKey();
  const banner = document.getElementById("debts-banner");
  const list = document.getElementById("debts-list");
  const debts = [];

  // Solo mostrar pendientes de la semana actual (lunes hasta hoy).
  const start = getMondayKey(today);

  for (let cursor = start; cursor < today; cursor = addDaysToKey(cursor, 1)) {
    const dateStr = cursor;
    state.tasks.forEach((task) => {
      const assignee = getAssigneeForDate(task, dateStr);
      if (!assignee) {
        return;
      }

      const key = `${task.id}_${dateStr}`;
      if (state.checks[key]?.done) {
        return;
      }

      debts.push({ task, dateStr, assignee });
    });
  }

  if (debts.length === 0) {
    banner.style.display = "none";
    return;
  }

  banner.style.display = "block";
  list.innerHTML = debts
    .map(({ task, dateStr, assignee }) => {
      return `<div class="debt-chip">
        <span class="person-dot" style="background:${getPersonColor(assignee)}"></span>
        <strong>${getPersonName(assignee)}</strong>: ${task.name}
        <span style="color:var(--text-muted);font-size:11px"> - ${friendlyDate(dateStr)}</span>
      </div>`;
    })
    .join("");
}

function renderCalendar() {
  const dates = getWeekDateKeys();
  const today = getBuenosAiresTodayKey();
  const grid = document.getElementById("calendar-grid");
  grid.innerHTML = "";

  const corner = document.createElement("div");
  corner.className = "col-header";
  corner.style.cssText = "background:var(--surface2);border-right:2px solid var(--border)";
  corner.innerHTML = '<div class="day-name" style="color:var(--text-muted)">Tarea</div>';
  grid.appendChild(corner);

  dates.forEach((dateKey, i) => {
    const isToday = dateKey === today;
    const dayNumber = Number(dateKey.slice(8, 10));
    const cell = document.createElement("div");
    cell.className = "col-header" + (isToday ? " today-col" : "");
    cell.innerHTML = `
      <div class="day-name">${DAYS_SHORT[i]}</div>
      <div class="day-date">${dayNumber}</div>
      ${isToday ? '<div class="today-badge">Hoy</div>' : ""}
      <button class="day-complete-btn" type="button" onclick="markDayCompleted('${dateKey}')" title="Marcar todas las tareas de este dia como completadas">✓ Todo</button>
    `;
    grid.appendChild(cell);
  });

  if (state.tasks.length === 0) {
    const empty = document.createElement("div");
    empty.style.cssText = "grid-column:1/-1;padding:60px 20px;text-align:center;color:var(--text-muted)";
    empty.innerHTML = `
      <div style="font-size:48px;margin-bottom:16px">✨</div>
      <div style="font-family:Fraunces,serif;font-size:20px;font-weight:700;color:var(--text);margin-bottom:8px">Sin tareas aun</div>
      <div style="font-size:14px">Crea tu primera tarea con el boton <strong>+ Nueva tarea</strong></div>
    `;
    grid.appendChild(empty);
    return;
  }

  state.tasks.forEach((task) => renderTaskRow(grid, task, dates, today));

  const progLabel = document.createElement("div");
  progLabel.className = "progress-label-cell";
  progLabel.textContent = "Progreso";
  grid.appendChild(progLabel);

  dates.forEach((dateKey) => {
    const dateStr = dateKey;
    const cell = document.createElement("div");
    cell.className = "progress-cell";

    const dayTasks = state.tasks.filter((task) => Boolean(getAssigneeForDate(task, dateStr)));
    const done = dayTasks.filter((task) => state.checks[`${task.id}_${dateStr}`]?.done);

    const total = dayTasks.length;
    const doneCount = done.length;

    if (total === 0) {
      cell.innerHTML = '<div class="day-progress">-</div>';
    } else {
      cell.innerHTML = `<div class="day-progress ${doneCount === total ? "complete" : ""}">${doneCount}/${total}</div>`;
    }

    grid.appendChild(cell);
  });
}

function renderTaskRow(grid, task, dates, today) {
  const labelCell = document.createElement("div");
  labelCell.className = "task-label-cell";

  const chips = task.assignments
    .map((person, dayIndex) => {
      if (!person) {
        return null;
      }
      const bg = mixColorWithWhite(getPersonColor(person), 0.82);
      return `<span class="person-badge" style="background:${bg};color:${getPersonColor(person)}">${DAYS_SHORT[dayIndex]}: ${getPersonName(person)}</span>`;
    })
    .filter(Boolean)
    .join(" ");

  labelCell.innerHTML = `
    <div class="task-info">
      <div class="task-name" title="${task.name}">${task.name}</div>
      <div class="task-meta">${chips || "Sin dias asignados"}</div>
      ${task.note ? `<div class="task-meta">Nota: ${task.note}</div>` : ""}
    </div>
    <button class="task-edit-btn" onclick="openEditTask('${task.id}')" title="Editar">✏️</button>
  `;
  grid.appendChild(labelCell);

  dates.forEach((dateKey) => {
    const dateStr = dateKey;
    const isToday = dateStr === today;
    const isPast = dateStr < today;
    const assignee = getAssigneeForDate(task, dateStr);

    const cell = document.createElement("div");
    cell.className = "task-cell" + (isToday ? " today-col" : "");

    if (!assignee) {
      cell.classList.add("no-task");
      grid.appendChild(cell);
      return;
    }

    const key = `${task.id}_${dateStr}`;
    if (!state.checks[key]) {
      state.checks[key] = { done: false };
    }

    const isDone = Boolean(state.checks[key]?.done);
    const isDebt = isPast && !isDone;

    const btn = document.createElement("button");
    btn.className = "check-btn";
    const personColor = getPersonColor(assignee);
    btn.style.setProperty("--person-color", personColor);

    if (isDone) {
      btn.classList.add("checked");
      btn.textContent = "✓";
      btn.title = "Hecho. Click para desmarcar";
    } else if (isDebt) {
      btn.classList.add("debt");
      btn.textContent = "!";
      btn.title = `Pendiente de ${friendlyDate(dateStr)}. Click para marcar`;
      const dot = document.createElement("span");
      dot.className = "debt-indicator";
      btn.appendChild(dot);
    } else {
      btn.classList.add("unchecked");
      btn.textContent = "";
      btn.title = `Marcar como completado (${getPersonName(assignee)})`;
    }

    const content = document.createElement("div");
    content.className = "task-cell-content";
    content.innerHTML = `<div class="cell-task-name" title="${task.name}">${task.name}</div>`;

    btn.onclick = () => toggleCheck(task.id, dateStr, task.name);
    content.appendChild(btn);
    cell.appendChild(content);
    grid.appendChild(cell);
  });
}

function getPersonColor(person) {
  const found = state.people.find((item) => item.id === person);
  return found ? found.color : "#7b7b7b";
}

function toggleCheck(taskId, dateStr) {
  const key = `${taskId}_${dateStr}`;
  if (!state.checks[key]) {
    state.checks[key] = { done: false };
  }

  const wasChecked = state.checks[key].done;
  state.checks[key].done = !wasChecked;

  if (!wasChecked) {
    showToast("✅ Tarea completada");
    spawnConfetti();
  }

  saveState();
  renderCalendar();
  renderDebts();
}

function markDayCompleted(dateStr) {
  let changed = 0;

  state.tasks.forEach((task) => {
    const assignee = getAssigneeForDate(task, dateStr);
    if (!assignee) {
      return;
    }

    const key = `${task.id}_${dateStr}`;
    if (!state.checks[key]) {
      state.checks[key] = { done: false };
    }

    if (!state.checks[key].done) {
      state.checks[key].done = true;
      changed += 1;
    }
  });

  if (changed === 0) {
    showToast("ℹ No habia tareas pendientes en ese dia");
    return;
  }

  saveState();
  renderCalendar();
  renderDebts();
  showToast(`✅ ${changed} tareas marcadas como hechas`);
}

function spawnConfetti() {
  const colors = ["#e07b54", "#5b8fcf", "#74b58a", "#e8b84b", "#d4416c"];
  for (let i = 0; i < 18; i += 1) {
    const piece = document.createElement("div");
    piece.className = "confetti-piece";
    piece.style.cssText = `
      left:${Math.random() * 100}vw;
      top:${Math.random() * 30 + 30}vh;
      background:${colors[Math.floor(Math.random() * colors.length)]};
      animation-delay:${Math.random() * 0.3}s;
      width:${Math.random() * 8 + 4}px;
      height:${Math.random() * 8 + 4}px;
      border-radius:${Math.random() > 0.5 ? "50%" : "2px"};
    `;

    document.body.appendChild(piece);
    setTimeout(() => piece.remove(), 1200);
  }
}

let toastTimeout;
function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => t.classList.remove("show"), 2500);
}

function changeWeek(dir) {
  state.weekOffset += dir;
  renderWeekLabel();
  renderCalendar();
}

function goToday() {
  state.weekOffset = 0;
  renderWeekLabel();
  renderCalendar();
}

function openModal(id) {
  document.getElementById(id).classList.add("active");
}

function closeModal(id) {
  document.getElementById(id).classList.remove("active");
}

const importJsonInput = document.getElementById("import-json-input");
if (importJsonInput) {
  importJsonInput.addEventListener("change", (event) => {
    const file = event.target.files && event.target.files[0];
    void importDataJsonFromFile(file);
  });
}

document.querySelectorAll(".modal-overlay").forEach((overlay) => {
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) {
      closeModal(overlay.id);
    }
  });
});

function setAdriConstraint(dayIndex, nextValue) {
  if (nextValue !== "adri") {
    return true;
  }

  const adriCount = state.newTask.assignments.reduce((acc, value, idx) => {
    if (idx !== dayIndex && value === "adri") {
      return acc + 1;
    }
    return acc;
  }, 0);

  if (adriCount >= 1) {
    showToast("⚠ Adriana solo puede quedar asignada 1 dia por semana");
    return false;
  }

  return true;
}

function setAssignment(dayIndex, value) {
  const normalized = personExists(value) ? value : null;
  if (!setAdriConstraint(dayIndex, normalized)) {
    renderAssignmentGrid();
    return;
  }

  state.newTask.assignments[dayIndex] = normalized;
  renderAssignmentGrid();
}

function renderAssignmentGrid() {
  const container = document.getElementById("assignment-grid");
  container.innerHTML = DAYS_SHORT.map((dayLabel, dayIndex) => {
    const current = state.newTask.assignments[dayIndex] || "";
    const options = state.people.map((person) => `
      <option value="${person.id}" ${current === person.id ? "selected" : ""}>${person.name}</option>
    `).join("");

    return `
      <div class="assignment-cell">
        <div class="assignment-day">${dayLabel}</div>
        <select class="assignment-select" onchange="setAssignment(${dayIndex}, this.value)">
          <option value="" ${current === "" ? "selected" : ""}>Sin asignar</option>
          ${options}
        </select>
      </div>
    `;
  }).join("");
}

function setPreset(preset) {
  const juliId = personExists("juli") ? "juli" : state.people[0]?.id || null;
  const meliId = personExists("meli") ? "meli" : state.people[1]?.id || state.people[0]?.id || null;

  if (preset === "clear") {
    state.newTask.assignments = emptyAssignments();
    renderAssignmentGrid();
    return;
  }

  if (preset === "juli-weekdays") {
    state.newTask.assignments = [juliId, juliId, juliId, juliId, juliId, null, null];
  } else if (preset === "meli-weekdays") {
    state.newTask.assignments = [meliId, meliId, meliId, meliId, meliId, null, null];
  } else if (preset === "rotate") {
    state.newTask.assignments = [juliId, meliId, juliId, meliId, juliId, meliId, null];
  }

  renderAssignmentGrid();
}

function openAddTask() {
  state.editingTaskId = null;
  state.newTask = {
    name: "",
    note: "",
    assignments: emptyAssignments()
  };

  document.getElementById("modal-title").textContent = "Nueva tarea";
  document.getElementById("task-name-input").value = "";
  document.getElementById("task-note-input").value = "";
  document.getElementById("delete-task-btn").style.display = "none";

  renderAssignmentGrid();
  openModal("task-modal");
  document.getElementById("task-name-input").focus();
}

function openEditTask(taskId) {
  closeModal("manage-modal");
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) {
    return;
  }

  state.editingTaskId = taskId;
  state.newTask = {
    name: task.name,
    note: task.note || "",
    assignments: [...task.assignments]
  };

  document.getElementById("modal-title").textContent = "Editar tarea";
  document.getElementById("task-name-input").value = task.name;
  document.getElementById("task-note-input").value = task.note || "";
  document.getElementById("delete-task-btn").style.display = "flex";

  renderAssignmentGrid();
  openModal("task-modal");
}

function saveTask() {
  const name = document.getElementById("task-name-input").value.trim();
  const note = document.getElementById("task-note-input").value.trim();
  const assignments = normalizeAssignments(state.newTask.assignments);

  if (!name) {
    showToast("⚠ Escribi el nombre de la tarea");
    return;
  }

  if (countAssignedDays(assignments) === 0) {
    showToast("⚠ Asigna por lo menos un dia");
    return;
  }

  if (state.editingTaskId) {
    const task = state.tasks.find((item) => item.id === state.editingTaskId);
    if (!task) {
      return;
    }

    task.name = name;
    task.note = note;
    task.assignments = assignments;
    showToast("✅ Tarea actualizada");
  } else {
    state.tasks.push({
      id: makeTaskId(),
      name,
      note,
      assignments
    });
    showToast("✅ Tarea creada");
  }

  saveState();
  closeModal("task-modal");
  renderCalendar();
  renderDebts();
}

function deleteCurrentTask() {
  if (!state.editingTaskId) {
    return;
  }

  if (!window.confirm("Seguro que queres eliminar esta tarea?")) {
    return;
  }

  state.tasks = state.tasks.filter((task) => task.id !== state.editingTaskId);
  Object.keys(state.checks).forEach((key) => {
    if (key.startsWith(state.editingTaskId + "_")) {
      delete state.checks[key];
    }
  });

  saveState();
  closeModal("task-modal");
  renderCalendar();
  renderDebts();
  showToast("🗑 Tarea eliminada");
}

function openManage() {
  const list = document.getElementById("manage-list");

  if (state.tasks.length === 0) {
    list.innerHTML = `<div style="text-align:center;padding:40px;color:var(--text-muted)">
      <div style="font-size:32px;margin-bottom:12px">📋</div>
      <div>No hay tareas todavia</div>
    </div>`;
  } else {
    list.innerHTML = state.tasks
      .map((task) => {
        const assignmentsText = task.assignments
          .map((person, dayIndex) => {
            if (!person) {
              return null;
            }
            return `${DAYS_SHORT[dayIndex]}: ${getPersonName(person)}`;
          })
          .filter(Boolean)
          .join(" · ");

        return `<div class="manage-item">
          <div class="manage-info">
            <div class="manage-name">${task.name}</div>
            <div class="manage-sub">${assignmentsText || "Sin asignaciones"}</div>
            ${task.note ? `<div class="manage-sub">Nota: ${task.note}</div>` : ""}
          </div>
          <div class="manage-actions">
            <button class="icon-btn" onclick="openEditTask('${task.id}')" title="Editar">✏️</button>
            <button class="icon-btn delete" onclick="quickDelete('${task.id}')" title="Eliminar">🗑</button>
          </div>
        </div>`;
      })
      .join("");
  }

  openModal("manage-modal");
}

function quickDelete(taskId) {
  if (!window.confirm("Eliminar esta tarea?")) {
    return;
  }

  state.tasks = state.tasks.filter((task) => task.id !== taskId);
  Object.keys(state.checks).forEach((key) => {
    if (key.startsWith(taskId + "_")) {
      delete state.checks[key];
    }
  });

  saveState();
  openManage();
  renderCalendar();
  renderDebts();
  showToast("🗑 Tarea eliminada");
}

function seedDefaultTasks() {
  if (state.tasks.length > 0) {
    return;
  }

  const defaults = [
    {
      name: "Cocinar",
      note: "Ir rotando quien limpia la cocina al final",
      assignments: ["juli", "meli", "juli", "meli", "juli", "meli", null]
    },
    {
      name: "Lavar los platos",
      note: "Revisar que no queden ollas en remojo",
      assignments: ["juli", "meli", "juli", "meli", "juli", "meli", "juli"]
    },
    {
      name: "Lavar la ropa",
      note: "Separar blancos y color",
      assignments: [null, "meli", null, null, "juli", null, null]
    },
    {
      name: "Limpieza profunda",
      note: "Una vez por semana con Adriana",
      assignments: [null, null, null, "adri", null, null, null]
    }
  ];

  state.tasks = defaults.map((task) => ({
    id: makeTaskId(),
    name: task.name,
    note: task.note || "",
    assignments: normalizeAssignments(task.assignments)
  }));

  saveState();
}

async function initializeApp() {
  await loadState();

  seedDefaultTasks();
  renderPeopleLegend();
  renderWeekLabel();
  renderCalendar();
  renderDebts();
  startRemotePolling();

  setInterval(() => {
    renderCalendar();
    renderDebts();
  }, 60000);
}

void initializeApp();
