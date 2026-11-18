const TABLES = ["workers", "agents", "companies", "payments", "handovers", "expenses", "user_profiles", "history"];
const DATA_TABLES = TABLES.filter(table => !["user_profiles", "history"].includes(table));
const DB_NAME = "passport-desk-v3";
const PAGE_SIZE = 50;
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const today = () => new Date().toISOString().slice(0, 10);
function uuid() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    try { return crypto.randomUUID(); } catch (_) {}
  }
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    try {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      bytes[6] = (bytes[6] & 0x0f) | 0x40; // RFC 4122 v4
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    } catch (_) {}
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : ((r & 0x3) | 0x8);
    return v.toString(16);
  });
}

function getCloudConfig() {
  const storedUrl = storageRead("passport-desk-cloud-url");
  const storedKey = storageRead("passport-desk-cloud-key");
  const fileUrl = window.PDESK_CONFIG?.supabaseUrl;
  const fileKey = window.PDESK_CONFIG?.supabaseAnonKey;

  const url = storedUrl || (fileUrl && !fileUrl.includes("PASTE") ? fileUrl : "");
  const key = storedKey || (fileKey && !fileKey.includes("PASTE") ? fileKey : "");

  return { supabaseUrl: url, supabaseAnonKey: key };
}

let config = getCloudConfig();

async function pushAllToCloud() {
  if (!state.supabase) return toast("Connect your cloud database first.");
  let count = 0;
  for (const table of DATA_TABLES) {
    for (const row of state.rows[table]) {
      if (row.id) {
        state.pending.set(`${table}:${row.id}`, row);
        count++;
      }
    }
  }
  toast(`Queueing ${count} local records for cloud sync...`);
  await syncNow();
  toast(`OK Synced ${count} records to cloud database! Zero data loss.`);
}
function copyText(text) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(() => toast(`Copied ${text}`)).catch(() => execCopy(text));
  } else {
    execCopy(text);
  }
}

function execCopy(text) {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    toast(`Copied ${text}`);
  } catch (_) {
    toast(`Passport: ${text}`);
  }
}

function storageRead(key, fallback = "") {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function storageWrite(key, value) {
  try { localStorage.setItem(key, value); } catch { toast("Browser preferences could not be saved. Your records remain in IndexedDB."); }
}
function safeJson(text) {
  try { const value = JSON.parse(text); return value && typeof value === "object" ? value : {}; } catch { return {}; }
}
const state = {
  rows: Object.fromEntries(TABLES.map(table => [table, []])),
  pending: new Map(),
  errors: new Map(),
  supabase: null,
  user: null,
  role: null,
  page: "dashboard",
  form: null,
  pageIndex: 0,
  camera: null,
  scannerActive: false,
  scanBusy: false,
  mrzWorker: null,
  mrzRequestId: 0,
  mrzRequests: new Map(),
  saving: false,
  db: null,
  dbUser: null,
  syncing: false,
  lastSync: null,
  lastBackup: Number(storageRead("passport-desk-last-backup", "0")),
  dashFilter: { agent: "", agency: "", company: "" },
  workerFilterPresets: null
};

const FIELDS = {
  workers: [
    ["name", "Full name", "text", true], ["phone", "Phone number", "tel"], ["passport_no", "Passport number", "text"],
    ["passport_expiry", "Passport expiry", "date"], ["dob", "Date of birth", "date"], ["sex", "Sex", "select", ["", "M", "F"]],
    ["nationality", "Nationality", "text"],
    ["submission_agency", "Submission agency (passport submitted to)", "agency", true],
    ["submission_status", "Passport submission status", "select", ["In Office (Not Submitted)", "Submitted to Agency", "Taken Back by Agent", "Visa Stamped", "Received from Agency", "Delivered to Candidate"]],
    ["submission_date", "Agency submission date", "date"],
    ["passport_withdrawn_date", "Passport taken back date (by agent)", "date"],
    ["passport_withdrawn_by", "Passport taken back by (person/agent)", "text"],
    ["passport_withdrawn_reason", "Reason for taking passport back", "text"],
    ["passport_withdrawn_notes", "Withdrawal remarks / return expected", "text"],
    ["agent_id", "Agent pair", "agent"], ["company", "Company", "company"],
    ["position", "Position", "text"], ["received", "Date received", "date"], ["passenger_status", "Pipeline status", "select", ["New", "In Processing", "Completed / Deployed", "On Hold", "Cancelled"]],
    ["passport_status", "Passport document", "select", ["Pending", "Received"]], ["photo_status", "Photo", "select", ["Pending", "Received"]],
    ["bgmt_status", "BG/MT documents", "select", ["Pending", "Received"]], ["medical_status", "Medical status", "select", ["Pending", "Fit", "Failed/Issue", "Not Required"]],
    ["medical_expiry", "Medical expiry", "date"], ["contract_fee", "Contract fee (BDT)", "number"], ["review", "Needs date review", "checkbox"],
    ["notes", "Notes", "textarea", true]
  ],
  agents: [
    ["id", "Agent ID", "text"], ["status", "Status", "select", ["Active", "Inactive"]],
    ["ml_name", "Malaysia agent name", "text"], ["ml_phone", "Malaysia agent phone", "tel"],
    ["bd_name", "Bangladesh agent name", "text"], ["bd_phone", "Bangladesh agent phone", "tel"], ["notes", "Notes", "textarea", true]
  ],
  companies: [
    ["name", "Company name", "text"], ["vacancy", "Vacancy quota", "number"], ["fee", "Package fee (BDT)", "number"],
    ["position", "Position", "text"], ["status", "Status", "select", ["Active", "Inactive"]], ["notes", "Notes", "textarea", true]
  ],
  payments: [
    ["worker_id", "Worker", "worker"], ["stage", "Payment stage", "select", ["Advance", "Calling Visa", "Flight/BMET"]],
    ["amount", "Amount paid (BDT)", "number"], ["paid_at", "Payment date", "date"], ["method", "Payment method", "select", ["Cash", "Bank", "Mobile banking", "Other"]],
    ["receipt_no", "Receipt / reference", "text"], ["collector", "Received by", "text"], ["notes", "Notes", "textarea", true]
  ],
  handovers: [
    ["paid_at", "Handover date", "date"], ["company", "Destination company", "company"], ["handover_type", "Handover type", "select", ["Candidate collection", "Office deposit", "Agent payment", "Other"]],
    ["recipient", "Recipient", "text"], ["amount", "Amount (BDT)", "number"], ["given_by", "Given by", "text"],
    ["method", "Payment method", "select", ["Cash", "Bank", "Mobile banking", "Other"]], ["reference", "Reference / transaction", "text"],
    ["status", "Status", "select", ["Pending", "Completed"]], ["notes", "Notes", "textarea", true]
  ],
  expenses: [
    ["paid_at", "Expense date", "date"], ["category", "Category", "select", ["Office Rent", "Electricity", "Operations & Logistics", "Government & Processing", "Medical", "Transport", "Other"]],
    ["description", "Description", "text", true], ["amount", "Amount (BDT)", "number"], ["method", "Payment method", "select", ["Cash", "Bank", "Mobile banking", "Other"]],
    ["vendor", "Paid to / vendor", "text"], ["company", "Related company", "company"], ["worker_id", "Related worker", "worker"],
    ["voucher_no", "Voucher / receipt no.", "text"], ["entered_by", "Entered by", "text"], ["notes", "Notes", "textarea", true]
  ],
  user_profiles: [["email", "Email", "text"], ["role", "Role", "select", ["admin", "staff", "viewer"]], ["enabled", "Enabled", "checkbox"]]
};

function toast(message) {
  let element = $("#toast");
  if (!element) {
    element = document.createElement("div");
    element.id = "toast";
    element.className = "toast";
    element.setAttribute("role", "status");
    document.body.append(element);
  }
  element.textContent = message;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.remove(), 3800);
}

function openDatabase(userId) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(`${DB_NAME}-${userId || "offline"}`, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const table of TABLES) if (!db.objectStoreNames.contains(table)) db.createObjectStore(table, { keyPath: "id" });
      if (!db.objectStoreNames.contains("pending")) db.createObjectStore("pending", { keyPath: "key" });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open offline database."));
  });
}

function idbRequest(storeName, mode, action) {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let request;
    try { request = action(store); } catch (error) { reject(error); return; }
    tx.oncomplete = () => resolve(request ? request.result : undefined);
    tx.onerror = () => reject(tx.error || new Error("Local storage operation failed."));
    tx.onabort = () => reject(tx.error || new Error("Local storage operation was cancelled."));
  });
}

function persistRecord(table, row, enqueue) {
  return new Promise((resolve, reject) => {
    try {
      const stores = enqueue ? [table, "pending"] : [table];
      const tx = state.db.transaction(stores, "readwrite");
      tx.objectStore(table).put(row);
      if (enqueue) tx.objectStore("pending").put({ key: `${table}:${row.id}`, table, row });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("Local storage operation failed."));
      tx.onabort = () => reject(tx.error || new Error("Local storage operation was cancelled."));
    } catch (error) { reject(error); }
  });
}

async function loadLocal() {
  for (const table of TABLES) state.rows[table] = await idbRequest(table, "readonly", store => store.getAll());
  const pending = await idbRequest("pending", "readonly", store => store.getAll());
  state.pending = new Map(pending.map(item => [item.key, item.row]));
  state.lastSync = await idbRequest("meta", "readonly", store => store.get("lastSync")).then(item => item && item.value);
}

function isWritable() { return ["admin", "staff"].includes(state.role); }
function active(table) { return state.rows[table].filter(row => !row.deleted_at); }
function rowById(table, id) { return state.rows[table].find(row => row.id === id); }
function agentName(id) {
  const agent = state.rows.agents.find(item => item.id === id);
  return agent ? `${agent.ml_name || "-"} / ${agent.bd_name || "-"}` : "No agent";
}
function workerLabel(worker) { return `${worker.wid || "Local"}  -  ${worker.name || "Unnamed"}${worker.passport_no ? `  -  ${worker.passport_no}` : ""}`; }
function money(amount) { return `BDT ${Number(amount || 0).toLocaleString("en-BD")}`; }
function expiryBucket(date) {
  if (!date) return "No expiry";
  const days = Math.floor((Date.parse(date) - Date.now()) / 86400000);
  if (days < 0) return "Expired";
  if (days <= 183) return "Within 6 months";
  if (days <= 548) return "Within 18 months";
  return "Valid";
}
function workerPayments(workerId) { return active("payments").filter(payment => payment.worker_id === workerId); }
function totalPaid(workerId) { return workerPayments(workerId).reduce((sum, item) => sum + Number(item.amount || 0), 0); }
function uniqueId(table) {
  if (table === "agents") {
    const maximum = Math.max(0, ...state.rows.agents.map(item => Number(String(item.id).replace(/\D/g, "")) || 0));
    return `AGT-${String(maximum + 1).padStart(3, "0")}`;
  }
  return uuid();
}

const DEFAULT_AGENCIES = [
  "Eastern Agency",
  "Al-Razi Recruiting",
  "Skyline Travels & Tours",
  "Delta International",
  "Gulf Manpower Services"
];

function getSubmissionAgencies() {
  const custom = safeJson(storageRead("passport-desk-custom-agencies", "[]"));
  const deleted = safeJson(storageRead("passport-desk-deleted-agencies", "[]"));
  const deletedSet = new Set(Array.isArray(deleted) ? deleted : []);
  const fromWorkers = active("workers").map(w => w.submission_agency).filter(Boolean);
  const combined = Array.isArray(custom) ? [...DEFAULT_AGENCIES, ...custom, ...fromWorkers] : [...DEFAULT_AGENCIES, ...fromWorkers];
  return [...new Set(combined.map(s => String(s).trim()).filter(Boolean))]
    .filter(name => !deletedSet.has(name))
    .sort();
}

function addSubmissionAgency(name) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return null;
  const deleted = safeJson(storageRead("passport-desk-deleted-agencies", "[]"));
  if (Array.isArray(deleted) && deleted.includes(trimmed)) {
    const nextDeleted = deleted.filter(item => item !== trimmed);
    storageWrite("passport-desk-deleted-agencies", JSON.stringify(nextDeleted));
  }
  const custom = safeJson(storageRead("passport-desk-custom-agencies", "[]"));
  const list = Array.isArray(custom) ? custom : [];
  if (!list.includes(trimmed)) {
    list.push(trimmed);
    storageWrite("passport-desk-custom-agencies", JSON.stringify(list));
  }
  return trimmed;
}

async function updateSubmissionAgency(oldName, newName) {
  const oldTrim = String(oldName || "").trim();
  const newTrim = String(newName || "").trim();
  if (!oldTrim || !newTrim) return null;
  if (oldTrim === newTrim) return oldTrim;

  addSubmissionAgency(newTrim);

  const custom = safeJson(storageRead("passport-desk-custom-agencies", "[]"));
  const list = (Array.isArray(custom) ? custom : []).filter(item => item !== oldTrim);
  storageWrite("passport-desk-custom-agencies", JSON.stringify(list));

  const deleted = safeJson(storageRead("passport-desk-deleted-agencies", "[]"));
  const deletedList = Array.isArray(deleted) ? deleted : [];
  if (!deletedList.includes(oldTrim)) {
    deletedList.push(oldTrim);
    storageWrite("passport-desk-deleted-agencies", JSON.stringify(deletedList));
  }

  const affected = active("workers").filter(w => w.submission_agency === oldTrim);
  for (const worker of affected) {
    await saveLocal("workers", {
      ...worker,
      submission_agency: newTrim,
      updated_at: new Date().toISOString()
    }, true);
  }

  const sel = $("#agency-filter");
  if (sel && sel.value === oldTrim) {
    sel.value = newTrim;
  }

  return newTrim;
}

async function deleteSubmissionAgency(name) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return false;

  const affected = active("workers").filter(w => w.submission_agency === trimmed);
  const confirmMsg = affected.length > 0
    ? `Agency "${trimmed}" is currently assigned to ${affected.length} candidate(s).\n\nDelete this agency and change those candidates to "In Office (Not Submitted)"?`
    : `Are you sure you want to delete agency "${trimmed}"?`;

  if (!window.confirm(confirmMsg)) return false;

  const custom = safeJson(storageRead("passport-desk-custom-agencies", "[]"));
  const list = (Array.isArray(custom) ? custom : []).filter(item => item !== trimmed);
  storageWrite("passport-desk-custom-agencies", JSON.stringify(list));

  const deleted = safeJson(storageRead("passport-desk-deleted-agencies", "[]"));
  const deletedList = Array.isArray(deleted) ? deleted : [];
  if (!deletedList.includes(trimmed)) {
    deletedList.push(trimmed);
    storageWrite("passport-desk-deleted-agencies", JSON.stringify(deletedList));
  }

  for (const worker of affected) {
    await saveLocal("workers", {
      ...worker,
      submission_agency: null,
      submission_status: "In Office (Not Submitted)",
      submission_date: null,
      updated_at: new Date().toISOString()
    }, true);
  }

  const sel = $("#agency-filter");
  if (sel && sel.value === trimmed) {
    sel.value = "";
  }

  toast(`Agency "${trimmed}" deleted.`);
  return true;
}

function renderAgencyManageList() {
  const container = $("#agency-manage-list");
  const badge = $("#agency-count-badge");
  if (!container) return;

  const agencies = getSubmissionAgencies();
  if (badge) badge.textContent = agencies.length;

  if (!agencies.length) {
    container.innerHTML = '<div class="empty" style="padding:14px;font-size:13px;">No agencies registered. Add one above.</div>';
    return;
  }

  container.innerHTML = agencies.map(agency => {
    const assigned = active("workers").filter(w => w.submission_agency === agency).length;
    return `
      <div class="card" style="display:flex; justify-content:space-between; align-items:center; padding:10px 12px; margin:0; gap:8px;">
        <div style="flex:1; min-width:0;">
          <strong style="font-size:14px; display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"> ${esc(agency)}</strong>
          <span class="meta" style="font-size:12px; color:var(--muted);">${assigned} candidate passport(s)</span>
        </div>
        <div style="display:flex; gap:6px; flex-shrink:0;">
          <button type="button" class="secondary edit-agency-item-btn" data-agency="${esc(agency)}" style="min-height:36px; padding:6px 10px; font-size:12px; border-radius:8px;"> Edit</button>
          <button type="button" class="danger delete-agency-item-btn" data-agency="${esc(agency)}" style="min-height:36px; padding:6px 10px; font-size:12px; border-radius:8px;"> Delete</button>
        </div>
      </div>
    `;
  }).join("");

  container.querySelectorAll(".edit-agency-item-btn").forEach(btn => {
    btn.onclick = () => {
      const agencyName = btn.dataset.agency;
      setAgencyEditMode(agencyName);
    };
  });

  container.querySelectorAll(".delete-agency-item-btn").forEach(btn => {
    btn.onclick = async () => {
      const agencyName = btn.dataset.agency;
      const done = await deleteSubmissionAgency(agencyName);
      if (done) {
        resetAgencyForm();
        renderAgencyManageList();
        renderWorkers();
      }
    };
  });
}

function setAgencyEditMode(agencyName) {
  const input = $("#new-agency-name");
  const oldHidden = $("#editing-agency-old-name");
  const saveBtn = $("#btn-save-agency");
  const cancelBtn = $("#btn-cancel-edit-agency");
  const desc = $("#agency-form-desc");

  if (oldHidden) oldHidden.value = agencyName;
  if (input) {
    input.value = agencyName;
    input.focus();
    input.select();
  }
  if (saveBtn) saveBtn.textContent = "Update Agency";
  if (cancelBtn) cancelBtn.style.display = "inline-flex";
  if (desc) desc.innerHTML = `Editing <b>${esc(agencyName)}</b>. Change name and tap Update.`;
}

function resetAgencyForm() {
  const input = $("#new-agency-name");
  const oldHidden = $("#editing-agency-old-name");
  const saveBtn = $("#btn-save-agency");
  const cancelBtn = $("#btn-cancel-edit-agency");
  const desc = $("#agency-form-desc");

  if (oldHidden) oldHidden.value = "";
  if (input) input.value = "";
  if (saveBtn) saveBtn.textContent = "Save Agency";
  if (cancelBtn) cancelBtn.style.display = "none";
  if (desc) desc.textContent = "Add a new agency or choose from the list below to edit or delete.";
}

let agencyDialogCallback = null;

function openAgencyDialog(onSaved = null) {
  agencyDialogCallback = onSaved;
  const dlg = $("#agency-dialog");
  resetAgencyForm();
  renderAgencyManageList();
  if (dlg) {
    if (!dlg.open) dlg.showModal();
    setTimeout(() => $("#new-agency-name")?.focus(), 80);
  }
}

function setupAgencyDialog() {
  const dlg = $("#agency-dialog");
  const input = $("#new-agency-name");
  const saveBtn = $("#btn-save-agency");
  const cancelBtn = $("#btn-cancel-edit-agency");

  cancelBtn?.addEventListener("click", () => {
    resetAgencyForm();
  });

  const save = async () => {
    const name = input?.value?.trim();
    if (!name) {
      toast("Please enter an agency name.");
      input?.focus();
      return;
    }
    const oldName = $("#editing-agency-old-name")?.value?.trim();
    if (oldName) {
      const updated = await updateSubmissionAgency(oldName, name);
      toast(`Agency updated to "${updated}".`);
      resetAgencyForm();
      renderAgencyManageList();
      renderWorkers();
      if (typeof agencyDialogCallback === "function") {
        const cb = agencyDialogCallback;
        agencyDialogCallback = null;
        cb(updated);
      }
    } else {
      const added = addSubmissionAgency(name);
      toast(`Agency "${added}" added successfully.`);
      resetAgencyForm();
      renderAgencyManageList();
      renderWorkers();
      if (typeof agencyDialogCallback === "function") {
        const cb = agencyDialogCallback;
        agencyDialogCallback = null;
        cb(added);
      }
    }
  };

  saveBtn?.addEventListener("click", save);
  input?.addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      save();
    }
  });
}

function openTakebackDialog(worker) {
  const dlg = $("#takeback-dialog");
  if (!dlg || !worker) return;

  const agent = rowById("agents", worker.agent_id);
  const defaultPerson = agent ? `${agent.bd_name || agent.ml_name || "Agent"} (${worker.agent_id})` : "";
  const defaultPhone = agent?.bd_phone || agent?.ml_phone || worker.phone || "";

  $("#takeback-worker-id").value = worker.id;
  $("#takeback-worker-info").innerHTML = `
    <div style="font-size:14px; font-weight:750; color:var(--ink);">${esc(worker.name || "Unnamed")}</div>
    <div style="font-size:12px; margin-top:2px;">
       Passport: <b class="mono">${esc(worker.passport_no || "No passport")}</b>
       -  Agent: <b>${esc(agentName(worker.agent_id))}</b>
    </div>
  `;

  $("#takeback-date").value = today();
  $("#takeback-by").value = worker.passport_withdrawn_by || defaultPerson;
  $("#takeback-phone").value = defaultPhone;
  $("#takeback-reason").value = worker.passport_withdrawn_reason || "Candidate Cancelled / Not Going";
  $("#takeback-expected-return").value = "";
  $("#takeback-notes").value = "";

  dlg.showModal();
}

async function markPassportReceivedBack(worker) {
  if (!worker) return;
  if (!window.confirm(`Confirm original passport for "${worker.name}" (${worker.passport_no || "No passport"}) has been RECEIVED BACK into office custody?`)) return;

  const returnDate = today();
  const logEntry = `[${returnDate}] Returned to office from ${worker.passport_withdrawn_by || "agent"}`;
  const nextNotes = worker.notes ? `${worker.notes}\n${logEntry}` : logEntry;

  const updated = {
    ...worker,
    submission_status: "In Office (Not Submitted)",
    passport_status: "Received",
    notes: nextNotes,
    passport_withdrawn_notes: `Returned to office on ${returnDate}. Previous withdrawal: ${worker.passport_withdrawn_by || "agent"} (${worker.passport_withdrawn_date || "-"})`,
    updated_at: new Date().toISOString()
  };

  await saveLocal("workers", updated);
  toast(`OK Passport for "${worker.name}" received back into office.`);
  renderWorkers();
}

function setupTakebackDialog() {
  const dlg = $("#takeback-dialog");
  if (!dlg) return;

  const save = async (shouldPrint = false) => {
    const workerId = $("#takeback-worker-id")?.value;
    const worker = rowById("workers", workerId);
    if (!worker) {
      toast("Candidate record not found.");
      return;
    }

    const withdrawnDate = $("#takeback-date")?.value || today();
    const withdrawnBy = $("#takeback-by")?.value?.trim() || "Agent";
    const phone = $("#takeback-phone")?.value?.trim() || "";
    const reason = $("#takeback-reason")?.value || "Temporary Withdrawal";
    const expectedReturn = $("#takeback-expected-return")?.value || "";
    const notes = $("#takeback-notes")?.value?.trim() || "";

    const logEntry = `[${withdrawnDate}] Passport taken back by ${withdrawnBy}${phone ? ` (${phone})` : ""}. Reason: ${reason}.${expectedReturn ? ` Exp. return: ${expectedReturn}.` : ""}${notes ? ` Notes: ${notes}` : ""}`;
    const nextNotes = worker.notes ? `${worker.notes}\n${logEntry}` : logEntry;

    const updated = {
      ...worker,
      submission_status: "Taken Back by Agent",
      passport_status: "Pending",
      passport_withdrawn_date: withdrawnDate,
      passport_withdrawn_by: withdrawnBy + (phone ? `  -   ${phone}` : ""),
      passport_withdrawn_reason: reason,
      passport_withdrawn_notes: notes + (expectedReturn ? ` (Expected Return: ${expectedReturn})` : ""),
      notes: nextNotes,
      updated_at: new Date().toISOString()
    };

    await saveLocal("workers", updated);
    dlg.close();
    toast(` Passport for "${worker.name}" marked as taken by agent.`);
    renderWorkers();

    if (shouldPrint) {
      printPassportReturnSlip(updated);
    }
  };

  $("#btn-save-takeback")?.addEventListener("click", () => save(false));
  $("#btn-save-and-print-takeback")?.addEventListener("click", () => save(true));
}

function printPassportReturnSlip(worker) {
  const docTitle = `Passport Withdrawal & Handover Acknowledgement - ${worker.name || "Candidate"}`;

  const content = `
    <div class="print-manifest-wrap" style="max-width: 800px; margin: 0 auto;">
      <div class="print-header">
        <div class="header-title">
          <h1>PASSPORT DESK  -  RECRUITMENT OFFICE</h1>
          <h2>PASSPORT WITHDRAWAL &amp; HANDOVER ACKNOWLEDGEMENT SLIP</h2>
        </div>
        <div class="header-meta">
          <div><b>Slip ID:</b> WTH-${Date.now().toString().slice(-6)}</div>
          <div><b>Date Issued:</b> ${worker.passport_withdrawn_date || today()}</div>
          <div><b>Time:</b> ${new Date().toLocaleTimeString()}</div>
        </div>
      </div>

      <div class="filter-summary" style="background:#fffbeb; border-color:#f59e0b; margin-bottom:16px;">
        <div>
          <b style="color:#b45309; font-size:13px;"> NOTICE: ORIGINAL PASSPORT BOOKLET HANDOVER TO AGENT / REPRESENTATIVE</b>
          <div style="font-size:11px; color:#451a03; margin-top:3px;">
            The original passport booklet described below has been withdrawn from office custody and handed over to the authorized agent/person.
          </div>
        </div>
      </div>

      <table style="margin-bottom: 16px;">
        <tbody>
          <tr>
            <td style="width:25%; background:#f9fafb; font-weight:700;">Candidate Name:</td>
            <td style="width:25%;"><b>${esc(worker.name || "-")}</b></td>
            <td style="width:25%; background:#f9fafb; font-weight:700;">Worker ID:</td>
            <td style="width:25%;" class="mono">${esc(worker.wid || worker.id)}</td>
          </tr>
          <tr>
            <td style="background:#f9fafb; font-weight:700;">Passport Number:</td>
            <td class="mono"><b>${esc(worker.passport_no || "No passport")}</b></td>
            <td style="background:#f9fafb; font-weight:700;">Passport Expiry:</td>
            <td>${esc(worker.passport_expiry || "-")}</td>
          </tr>
          <tr>
            <td style="background:#f9fafb; font-weight:700;">Candidate Phone:</td>
            <td>${esc(worker.phone || "-")}</td>
            <td style="background:#f9fafb; font-weight:700;">Destination Company:</td>
            <td>${esc(worker.company || "Unassigned")}</td>
          </tr>
          <tr>
            <td style="background:#f9fafb; font-weight:700;">Agent Pair (Office):</td>
            <td colspan="3">${esc(worker.agent_id ? `${worker.agent_id}  -  ${agentName(worker.agent_id)}` : "None")}</td>
          </tr>
        </tbody>
      </table>

      <h3 style="font-size:12px; text-transform:uppercase; color:#1f2937; margin:14px 0 6px;">Withdrawal &amp; Handover Details</h3>
      <table style="margin-bottom: 20px;">
        <tbody>
          <tr>
            <td style="width:30%; background:#f9fafb; font-weight:700;">Passport Handed Over To:</td>
            <td><b>${esc(worker.passport_withdrawn_by || "Agent")}</b></td>
          </tr>
          <tr>
            <td style="background:#f9fafb; font-weight:700;">Handover / Withdrawal Date:</td>
            <td><b>${esc(worker.passport_withdrawn_date || today())}</b></td>
          </tr>
          <tr>
            <td style="background:#f9fafb; font-weight:700;">Reason for Withdrawal:</td>
            <td><span class="status-pill" style="background:#fef3c7; border-color:#f59e0b; color:#92400e; font-weight:bold;">${esc(worker.passport_withdrawn_reason || "Not specified")}</span></td>
          </tr>
          ${worker.passport_withdrawn_notes ? `
          <tr>
            <td style="background:#f9fafb; font-weight:700;">Remarks / Expected Return:</td>
            <td>${esc(worker.passport_withdrawn_notes)}</td>
          </tr>
          ` : ""}
        </tbody>
      </table>

      <div style="background:#f8fafc; border:1px solid #cbd5e1; border-radius:6px; padding:10px 12px; font-size:10.5px; line-height:1.5; color:#334155; margin-bottom:24px;">
        <b>DECLARATION &amp; RECEIPT ACKNOWLEDGEMENT:</b><br>
        I, the undersigned receiver, hereby confirm that I have received back the <b>original passport booklet</b> of the candidate mentioned above in sound and undamaged condition from <b>Passport Desk Recruitment Office</b>. From this moment of handover, full responsibility for the safety and custody of this passport rests with the undersigned receiver.
      </div>

      <div class="signature-section" style="grid-template-columns: 1fr 1fr; margin-top:20px;">
        <div class="sign-box">
          <h4>Handed Over By (Office Authorization)</h4>
          <p style="font-size:10px; color:#555; margin:4px 0 32px;">Passport booklet verified and released from office safe.</p>
          <div class="sign-line"></div>
          <div class="sign-label">Authorized Officer Signature, Name &amp; Office Seal</div>
        </div>

        <div class="sign-box" style="border: 2px solid #b45309; background:#fffbeb;">
          <h4 style="color:#b45309;">Received By (Agent / Authorized Receiver)</h4>
          <p style="font-size:10px; color:#555; margin:4px 0 32px;">I acknowledge receipt of original passport booklet in good condition.</p>
          <div class="sign-line"></div>
          <div class="sign-label">Receiver Signature, Full Name, Phone &amp; NID / Date</div>
        </div>
      </div>
    </div>
  `;

  printDocument(docTitle, content);
}

async function saveLocal(table, row, enqueue = true) {
  try {
    await persistRecord(table, row, enqueue);
    state.errors.delete("storage");
    const index = state.rows[table].findIndex(item => item.id === row.id);
    if (index < 0) state.rows[table].push(row); else state.rows[table][index] = row;
    const key = `${table}:${row.id}`;
    if (enqueue) state.pending.set(key, row);
    render();
  } catch (error) {
    state.errors.set("storage", error.name === "QuotaExceededError" ? "Phone storage is full. Export a backup and free space." : error.message);
    updateSyncPill();
    toast(state.errors.get("storage"));
    throw error;
  }
}

async function removeQueued(key) {
  await idbRequest("pending", "readwrite", store => store.delete(key));
  state.pending.delete(key);
}

function updateSyncPill() {
  const pill = $("#sync-pill");
  if (!pill) return;
  const errors = [...state.errors.values()];
  pill.textContent = errors.length ? `Sync issue  -  ${state.pending.size} pending` :
    !state.supabase ? "Local only  -  configure cloud" :
      !state.user ? "Sign in required" :
        !navigator.onLine ? `Offline  -  ${state.pending.size} pending` :
          state.syncing ? "Syncing..." :
            state.pending.size ? `${state.pending.size} pending` : "Saved";
  pill.title = errors.join("; ") || (state.lastSync ? `Last sync ${new Date(state.lastSync).toLocaleString()}` : "No cloud sync yet");
}

function serverRow(row) {
  const copy = { ...row };
  delete copy.wid;
  delete copy._local;
  delete copy.surname;
  delete copy.given_names;
  if (copy.receipt_no === null || copy.receipt_no === "") delete copy.receipt_no;
  return copy;
}

async function syncNow() {
  if (!state.supabase || !state.user || !state.role || !navigator.onLine || state.syncing) return updateSyncPill();
  state.syncing = true;
  updateSyncPill();
  try {
    for (const [key, row] of [...state.pending.entries()]) {
      const table = key.split(":")[0];
      if (!TABLES.includes(table)) continue;
      const { data: current, error: readError } = await state.supabase.from(table).select("*").eq("id", row.id).maybeSingle();
      if (readError) {
        state.errors.set(key, readError.message);
        continue;
      }
      if (current && Date.parse(current.updated_at || 0) > Date.parse(row.updated_at || 0)) {
        await saveLocal(table, current, false);
        await removeQueued(key);
        state.errors.delete(key);
        continue;
      }
      const { data, error } = await state.supabase.from(table).upsert(serverRow(row), { onConflict: "id" }).select("*").single();
      if (error) {
        state.errors.set(key, error.message);
        if (error.code === "401" || /JWT expired|session.*expired/i.test(error.message)) {
          await state.supabase.auth.refreshSession();
        }
        continue;
      }
      await saveLocal(table, data, false);
      await removeQueued(key);
      state.errors.delete(key);
    }
    for (const table of TABLES) {
      let offset = 0;
      while (true) {
        const orderColumn = table === "history" ? "changed_at" : "updated_at";
        const { data, error } = await state.supabase.from(table).select("*").order(orderColumn, { ascending: true }).range(offset, offset + 499);
        if (error) throw error;
        if (!data.length) break;
        for (const remote of data) {
          const key = `${table}:${remote.id}`;
          if (state.pending.has(key)) continue;
          const local = rowById(table, remote.id);
          if (!local || Date.parse(remote.updated_at || 0) >= Date.parse(local.updated_at || 0)) await saveLocal(table, remote, false);
        }
        offset += data.length;
        if (data.length < 500) break;
      }
    }
    state.lastSync = new Date().toISOString();
    await idbRequest("meta", "readwrite", store => store.put({ key: "lastSync", value: state.lastSync }));
    state.errors.delete("cloud");
  } catch (error) {
    state.errors.set("cloud", error.message || "Cloud sync failed.");
  } finally {
    state.syncing = false;
    updateSyncPill();
    render();
  }
}

function setupSearchableSelect(selectEl, searchInputEl, clearBtnEl, countEl) {
  if (!selectEl || !searchInputEl) return;
  const originalOptions = Array.from(selectEl.options).map(opt => ({
    value: opt.value,
    text: opt.text
  }));

  const runFilter = () => {
    const q = searchInputEl.value.trim().toLowerCase();
    if (clearBtnEl) clearBtnEl.style.display = q ? "block" : "none";
    const currentVal = selectEl.value;

    if (!q) {
      selectEl.innerHTML = originalOptions.map(opt => 
        `<option value="${esc(opt.value)}" ${opt.value === currentVal ? "selected" : ""}>${esc(opt.text)}</option>`
      ).join("");
      if (countEl) countEl.textContent = "";
      return;
    }

    const matches = originalOptions.filter(opt => {
      if (!opt.value) return false;
      return opt.text.toLowerCase().includes(q) || opt.value.toLowerCase().includes(q);
    });

    const firstPlaceholder = originalOptions[0]?.value === "" ? originalOptions[0].text : "- Select from matches -";
    selectEl.innerHTML = [
      `<option value="">${esc(firstPlaceholder)}</option>`,
      ...matches.map(opt => `<option value="${esc(opt.value)}" ${opt.value === currentVal ? "selected" : ""}>${esc(opt.text)}</option>`)
    ].join("");

    if (countEl) countEl.textContent = matches.length === 1 ? "1 match" : `${matches.length} matches`;
    if (matches.length === 1) {
      selectEl.value = matches[0].value;
    }
  };

  searchInputEl.addEventListener("input", runFilter);
  searchInputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const firstNonEmpty = Array.from(selectEl.options).find(o => o.value);
      if (firstNonEmpty) {
        selectEl.value = firstNonEmpty.value;
        selectEl.focus();
      }
    }
  });

  if (clearBtnEl) {
    clearBtnEl.addEventListener("click", () => {
      searchInputEl.value = "";
      runFilter();
      searchInputEl.focus();
    });
  }
}

function fieldInput(table, definition, value) {
  const [name, label, type, option] = definition;
  const id = `field-${name}`;
  const wide = option === true || type === "textarea" || ["name", "notes", "description", "worker_id", "agent_id", "company"].includes(name);
  if (type === "checkbox") return `<label class="check-label ${wide ? "wide" : ""}"><input id="${id}" type="checkbox" ${value ? "checked" : ""}> ${esc(label)}</label>`;

  if (type === "agent" || type === "company") {
    let options = [];
    if (type === "agent") options = ["", ...active("agents").map(item => item.id)];
    if (type === "company") options = ["", ...active("companies").map(item => item.name)];
    if (value && !options.includes(value)) options.push(value);
    const placeholder = type === "agent" ? " Search agent (Dhaka/KL or ID)..." : " Search company name...";
    return `
      <div class="searchable-field-wrap ${wide ? "wide" : ""}" data-field="${name}">
        <label for="${id}" style="font-weight:600; display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
          <span>${esc(label)}</span>
          <span class="search-match-count" id="${id}-count" style="font-size:11.5px; color:var(--muted); font-weight:normal;"></span>
        </label>
        <div class="search-input-box" style="margin-bottom:6px;">
          <input type="text" id="${id}-search" class="search-filter-input" placeholder="${placeholder}" autocomplete="off">
          <button type="button" id="${id}-clear" class="search-clear-inline" title="Clear filter" tabindex="-1" style="display:none;">x</button>
        </div>
        <select id="${id}">
          ${options.map(item => {
            const title = type === "agent" ? (item ? `${item}  -  ${agentName(item)}` : "- (No Agent)") : item || "- (No Company)";
            return `<option value="${esc(item)}" ${String(item) === String(value ?? "") ? "selected" : ""}>${esc(title)}</option>`;
          }).join("")}
        </select>
      </div>
    `;
  }

  if (type === "select" || type === "worker") {
    let options = option || [];
    if (type === "worker") options = ["", ...active("workers").map(item => item.id)];
    if (value && !options.includes(value)) options.push(value);
    return `<label class="${wide ? "wide" : ""}">${esc(label)}<select id="${id}">${options.map(item => {
      const title = type === "worker" ? (item ? workerLabel(rowById("workers", item) || {}) : "-") : item || "-";
      return `<option value="${esc(item)}" ${String(item) === String(value ?? "") ? "selected" : ""}>${esc(title)}</option>`;
    }).join("")}</select></label>`;
  }
  if (type === "agency") {
    const existingAgencies = getSubmissionAgencies();
    const options = [...existingAgencies];
    if (value && !options.includes(value)) options.unshift(value);
    return `<label class="${wide ? "wide" : ""}">${esc(label)}
      <div class="filter-with-add" style="margin-top:4px;">
        <select id="${id}" style="flex:1;">
          <option value=""> In Office (Not Submitted to Agency)</option>
          ${options.map(item => `<option value="${esc(item)}" ${item === value ? "selected" : ""}> ${esc(item)}</option>`).join("")}
          <option value="__add_new__"> Add New Agency /  Manage (Edit &amp; Delete)...</option>
        </select>
        <button type="button" id="btn-add-agency-form" class="quick-add-btn" title="Manage Agencies (Add, Edit, Delete)" aria-label="Manage Agencies"></button>
      </div>
    </label>`;
  }
  if (type === "textarea") return `<label class="wide">${esc(label)}<textarea id="${id}">${esc(value || "")}</textarea></label>`;
  const inputMode = type === "number" ? 'inputmode="numeric"' : type === "tel" ? 'inputmode="tel"' : "";
  const caps = (name === "passport_no" || name === "name") ? 'autocapitalize="characters" autocorrect="off" autocomplete="off" spellcheck="false"' : "";
  return `<label class="${wide ? "wide" : ""}">${esc(label)}<input id="${id}" type="${type}" ${inputMode} ${caps} value="${esc(value ?? "")}" ${table === "agents" && name === "id" && state.form?.row ? "readonly" : ""}></label>`;
}

function openForm(table, row = null, opts = {}) {
  if (!isWritable()) return toast("Your account is read-only.");
  state.form = { table, row, options: opts };
  const defaults = {
    workers: { passenger_status: "New", passport_status: "Pending", photo_status: "Pending", bgmt_status: "Pending", medical_status: "Pending", submission_status: "In Office (Not Submitted)", nationality: "Bangladeshi", contract_fee: 700000, received: today(), ...safeJson(storageRead(`passport-desk-last-assignment-${state.user?.id || "local"}`, "{}")) },
    agents: { id: uniqueId("agents"), status: "Active" },
    companies: { status: "Active", vacancy: 0, fee: 700000 },
    payments: { paid_at: today(), method: "Cash" },
    handovers: { paid_at: today(), method: "Cash", status: "Completed" },
    expenses: { paid_at: today(), method: "Cash" }
  };
  const value = { ...(defaults[table] || {}), ...(opts.defaults || {}), ...(row || {}) };
  $("#form-title").textContent = `${row ? "Edit" : "New"} ${table === "workers" ? "worker" : table.slice(0, -1)}`;

  if (table === "workers" && !row) {
    // Streamlined registration layout: Scanned Info + Searchable Company & Agent + Related Papers
    const coreNames = ["name", "passport_no", "passport_expiry", "dob", "sex", "nationality", "phone"];
    const placementNames = ["company", "agent_id"];
    const docNames = ["passport_status", "photo_status", "bgmt_status", "medical_status"];
    const regNames = new Set([...coreNames, ...placementNames, ...docNames]);

    const coreFields = FIELDS.workers.filter(f => coreNames.includes(f[0]));
    const placementFields = FIELDS.workers.filter(f => placementNames.includes(f[0]));
    const docFields = FIELDS.workers.filter(f => docNames.includes(f[0]));
    const extraFields = FIELDS.workers.filter(f => !regNames.has(f[0]));

    $("#form-fields").innerHTML = `
      <div class="form-section-header wide"> Candidate &amp; Passport Information</div>
      ${coreFields.map(field => fieldInput(table, field, value[field[0]])).join("")}

      <div class="form-section-header wide" style="margin-top:10px;"> Company &amp; Agent Placement</div>
      ${placementFields.map(field => fieldInput(table, field, value[field[0]])).join("")}

      <div class="form-section-header wide" style="margin-top:10px;"> Related Papers &amp; Documents</div>
      ${docFields.map(field => fieldInput(table, field, value[field[0]])).join("")}

      <button type="button" id="btn-toggle-extra-fields" class="extra-fields-toggle-btn wide">Show additional fields (agency submission, withdrawal, notes...)</button>
      <div id="extra-worker-fields" class="form-grid wide" style="display:none; padding:0; gap:10px;">
        <div class="form-section-header wide" style="margin-top:10px;"> Additional Details &amp; Agency Submission</div>
        ${extraFields.map(field => fieldInput(table, field, value[field[0]])).join("")}
      </div>
    `;

    $("#btn-toggle-extra-fields")?.addEventListener("click", (e) => {
      const extraDiv = $("#extra-worker-fields");
      if (!extraDiv) return;
      const isHidden = extraDiv.style.display === "none";
      extraDiv.style.display = isHidden ? "grid" : "none";
      e.currentTarget.textContent = isHidden ? "Hide additional fields" : "Show additional fields (agency submission, withdrawal, notes...)";
    });
  } else {
    $("#form-fields").innerHTML = FIELDS[table].map(field => fieldInput(table, field, value[field[0]])).join("");
  }

  // Activate searchable select controls
  document.querySelectorAll("#form-fields .searchable-field-wrap").forEach(wrap => {
    const select = wrap.querySelector("select");
    const searchInput = wrap.querySelector(".search-filter-input");
    const clearBtn = wrap.querySelector(".search-clear-inline");
    const countEl = wrap.querySelector(".search-match-count");
    setupSearchableSelect(select, searchInput, clearBtn, countEl);
  });

  $("#form-fields").scrollTop = 0;
  $("#form-warning").hidden = !opts.warnings?.length;
  $("#form-warning").innerHTML = (opts.warnings || []).map(esc).join("<br>");
  $("#save-next-button").hidden = table !== "workers" || !!row;
  $("#delete-button").hidden = !row;
  $("#delete-button").textContent = row?.deleted_at ? "Restore from trash" : "Move to trash";
  $("#history-button").hidden = !row;

  const handleAgencyDialog = () => {
    openAgencyDialog((newAgency) => {
      const sel = $("#field-submission_agency");
      if (sel) {
        if (!sel.querySelector(`option[value="${newAgency}"]`)) {
          const opt = document.createElement("option");
          opt.value = newAgency;
          opt.textContent = ` ${newAgency}`;
          const addOpt = sel.querySelector('option[value="__add_new__"]');
          if (addOpt) sel.insertBefore(opt, addOpt);
          else sel.appendChild(opt);
        }
        sel.value = newAgency;
      }
    });
  };

  $("#field-submission_agency")?.addEventListener("change", (e) => {
    if (e.target.value === "__add_new__") {
      e.target.value = value.submission_agency || "";
      handleAgencyDialog();
    }
  });
  $("#btn-add-agency-form")?.addEventListener("click", handleAgencyDialog);
  $("#record-dialog").showModal();
}

function collectForm() {
  const { table, row } = state.form;
  const result = { ...(row || {}), id: row?.id || uniqueId(table) };
  for (const [name, , type] of FIELDS[table]) {
    const input = $(`#field-${name}`);
    if (!input) continue;
    let value = type === "checkbox" ? input.checked : input.value.trim();
    if (type === "number") value = value === "" ? null : Number(value);
    else if (value === "") value = null;
    result[name] = value;
  }
  if (table === "workers" && result.name) result.name = result.name.toUpperCase().replace(/\s+/g, " ");
  if (table === "workers" && result.passport_no) result.passport_no = result.passport_no.toUpperCase().replace(/\s/g, "");
  result.updated_at = new Date().toISOString();
  result.created_at ||= result.updated_at;
  return result;
}

function validateRecord(table, row) {
  if (table === "workers") {
    if (!row.name || !row.name.trim()) return "Please enter the candidate's full name.";
    if (row.passport_no) {
      const cleanPassport = row.passport_no.toUpperCase().replace(/\s/g, "");
      const duplicate = active("workers").find(item => item.id !== row.id && item.passport_no && item.passport_no.toUpperCase().replace(/\s/g, "") === cleanPassport);
      if (duplicate) return `Passport ${row.passport_no} is already assigned to ${duplicate.name || duplicate.wid}. Duplicate passport numbers are blocked.`;
    }
  }
  if (table === "agents" && (!row.id || active("agents").some(item => item.id === row.id && item.id !== state.form.row?.id))) return "Agent ID is required and must be unique (e.g. AGT-001).";
  if (table === "companies" && (!row.name || active("companies").some(item => item.id !== row.id && item.name?.toLowerCase().trim() === row.name.toLowerCase().trim()))) return "Company name is required and must be unique.";
  if (table === "payments" && (!row.worker_id || !row.stage)) return "Please choose a candidate and a payment stage.";
  if (["payments", "handovers", "expenses"].includes(table) && (!Number.isFinite(Number(row.amount)) || Number(row.amount) < 0)) return "Please enter a valid non-negative amount.";
  if (table === "expenses" && !row.description) return "Expense description is required.";
  return null;
}

async function submitForm(saveNext = false) {
  if (state.saving) return;
  state.saving = true;
  const saveBtn = $("#save-button");
  const origSaveText = saveBtn ? saveBtn.textContent : "Save";
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = "Saving..."; }
  const button = $("#save-next-button");
  if (button) button.disabled = true;
  try {
    const { table } = state.form;
    const row = collectForm();
    const problem = validateRecord(table, row);
    if (problem) {
      toast(problem);
      return;
    }
    if (table === "payments") {
      const worker = rowById("workers", row.worker_id);
      const over = totalPaid(row.worker_id) - Number(state.form.row?.amount || 0) + Number(row.amount || 0) > Number(worker?.contract_fee || 0);
      if (over) row.overpayment = true;
    }
    if (table === "workers") storageWrite(`passport-desk-last-assignment-${state.user?.id || "local"}`, JSON.stringify({ agent_id: row.agent_id || null, company: row.company || null }));
    await saveLocal(table, row);
    toast("Saved successfully.");
    if (saveNext) {
      state.form = null;
      $("#record-dialog").close();
      await startScanner();
    } else {
      $("#record-dialog").close();
    }
    syncNow();
  } catch (err) {
    toast(`Save error: ${err.message || "Could not save record."}`);
  } finally {
    state.saving = false;
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = origSaveText; }
    if (button) button.disabled = false;
  }
}

async function softDeleteCurrent() {
  const { table, row } = state.form;
  if (!row) return;
  if (!row.deleted_at && !window.confirm(`Move "${row.name || row.wid || row.id}" to trash?\n\nYou can restore this record anytime from More -> Trash.`)) return;
  const updated = { ...row, deleted_at: row.deleted_at ? null : new Date().toISOString(), updated_at: new Date().toISOString() };
  await saveLocal(table, updated);
  $("#record-dialog").close();
  toast(updated.deleted_at ? "Moved to trash. You can restore it later." : "Restored from trash.");
}

function maskPassport(passportNo) {
  if (!passportNo) return "No passport";
  const str = String(passportNo).trim();
  if (str.length <= 4) return str;
  return "**** " + str.slice(-4);
}

function highlightMatch(text, query) {
  if (!text || !query) return esc(text || "");
  const cleanQ = query.trim().replace(/\s+/g, " ");
  if (!cleanQ) return esc(text);
  const escaped = esc(text);
  try {
    const regex = new RegExp(`(${cleanQ.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
    return escaped.replace(regex, '<mark class="search-highlight">$1</mark>');
  } catch (_) {
    return escaped;
  }
}

function filteredWorkers() {
  const rawQ = $("#worker-search")?.value || "";
  const q = rawQ.trim().toLowerCase().replace(/\s+/g, " ");
  const qCompact = rawQ.replace(/[\s-]/g, "").toLowerCase();
  const agency = $("#agency-filter")?.value || "";
  const subStatus = $("#substatus-filter")?.value || "";
  const agent = $("#agent-filter")?.value || "";
  const company = $("#company-filter")?.value || "";
  const filter = $("#worker-filter")?.value || "";
  const pipeline = $("#pipeline-filter")?.value || "";
  const medical = $("#medical-filter")?.value || "";

  const workers = state.rows.workers.filter(row => (filter === "trash") === !!row.deleted_at);
  const counts = new Map();
  active("workers").forEach(row => row.passport_no && counts.set(row.passport_no.toUpperCase(), (counts.get(row.passport_no.toUpperCase()) || 0) + 1));

  return workers.filter(row => {
    const words = [
      row.wid, row.name, row.phone, row.passport_no, row.company,
      row.agent_id, agentName(row.agent_id),
      row.submission_agency, row.submission_status,
      row.passport_withdrawn_by, row.passport_withdrawn_reason, row.notes
    ].filter(Boolean).join(" ").toLowerCase();

    const duplicate = !!row.passport_no && counts.get(row.passport_no.toUpperCase()) > 1;

    const matchAgency = !agency || (agency === "__none__" ? (!row.submission_agency || row.submission_status === "In Office (Not Submitted)") : row.submission_agency === agency);
    const matchSubStatus = !subStatus || (row.submission_status || "In Office (Not Submitted)") === subStatus;
    const matchMedical = !medical || row.medical_status === medical;

    const matchQuery = !q ||
      (row.name && row.name.toLowerCase().replace(/\s+/g, " ").includes(q)) ||
      (row.passport_no && row.passport_no.replace(/[\s-]/g, "").toLowerCase().includes(qCompact)) ||
      (row.wid && row.wid.toLowerCase().includes(q)) ||
      words.includes(q);

    return matchQuery &&
      (!agent || row.agent_id === agent) &&
      (!company || row.company === company) &&
      matchAgency &&
      matchSubStatus &&
      matchMedical &&
      (!pipeline || row.passenger_status === pipeline) &&
      (!filter || filter === "trash" ||
        (filter.startsWith("agency:") && row.submission_agency === filter.replace("agency:", "")) ||
        (filter.startsWith("sub:") && (row.submission_status || "In Office (Not Submitted)") === filter.replace("sub:", "")) ||
        (filter === "docs" && [row.passport_status, row.photo_status, row.bgmt_status].some(v => v !== "Received")) ||
        (filter === "medical" && row.medical_status === "Pending") ||
        (filter === "duplicate" && duplicate) ||
        (filter === "review" && row.review) ||
        (filter === "expired" && expiryBucket(row.passport_expiry) === "Expired") ||
        (filter === "6" && expiryBucket(row.passport_expiry) === "Within 6 months") ||
        (filter === "18" && ["Within 6 months", "Within 18 months"].includes(expiryBucket(row.passport_expiry))));
  }).sort((a, b) => String(b.wid || "").localeCompare(String(a.wid || "")));
}

function statusTag(text, kind = "") { return `<span class="tag ${kind}">${esc(text)}</span>`; }
function copyDashboardBriefing(workers, filterDesc = "All Candidates") {
  const total = workers.length;
  const inOffice = workers.filter(w => !w.submission_agency || w.submission_status === "In Office (Not Submitted)");
  const submitted = workers.filter(w => w.submission_status === "Submitted to Agency");
  const withAgent = workers.filter(w => w.submission_status === "Taken Back by Agent");
  const stamped = workers.filter(w => w.submission_status === "Visa Stamped");
  const deployed = workers.filter(w => w.passenger_status === "Completed / Deployed");

  const collected = workers.reduce((sum, w) => sum + totalPaid(w.id), 0);
  const totalFee = workers.reduce((sum, w) => sum + Number(w.contract_fee || 0), 0);
  const due = Math.max(0, totalFee - collected);

  const agencyMap = new Map();
  submitted.forEach(w => {
    const ag = w.submission_agency || "Other";
    agencyMap.set(ag, (agencyMap.get(ag) || 0) + 1);
  });
  const agencyList = [...agencyMap.entries()].map(([k, v]) => `   * ${k}: ${v}`).join("\n");

  const lines = [
    ` *PASSPORT DESK  -  OFFICE REPORT*`,
    ` Date: ${today()} | ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
    ` Scope: ${filterDesc} (${total} total)`,
    ``,
    ` *PASSPORT LOCATION:*`,
    `*  In Office Safe: ${inOffice.length}`,
    `*  At Agencies: ${submitted.length}${agencyList ? `\n${agencyList}` : ""}`,
    `*  With Agents: ${withAgent.length}`,
    `* OK Visas Stamped: ${stamped.length}`,
    `*  Deployed: ${deployed.length}`,
    ``,
    ` *FINANCIAL OVERVIEW:*`,
    `* Total Payments Collected: ${money(collected)}`,
    `* Total Balance Due: ${money(due)}`,
    ``,
    ` Medical: ${workers.filter(w => w.medical_status === "Fit").length} Fit, ${workers.filter(w => w.medical_status === "Pending").length} Pending`
  ];

  if (withAgent.length > 0) {
    lines.push(``);
    lines.push(` *PASSPORTS WITH AGENTS:*`);
    withAgent.forEach((w, idx) => {
      lines.push(`${idx + 1}. ${w.name} (${w.passport_no || "No passport"})`);
      lines.push(`   Taken by: ${w.passport_withdrawn_by || agentName(w.agent_id)}`);
      if (w.passport_withdrawn_date) lines.push(`   Date: ${w.passport_withdrawn_date}`);
      if (w.passport_withdrawn_reason) lines.push(`   Reason: ${w.passport_withdrawn_reason}`);
    });
  }

  if (total <= 12 && total > 0) {
    lines.push(``);
    lines.push(` *CANDIDATE BREAKDOWN:*`);
    workers.forEach((w, idx) => {
      const paid = totalPaid(w.id);
      lines.push(`${idx + 1}. ${w.name}  -   ${w.passport_no || "-"}  -  ${w.submission_status || "In Office"}`);
      lines.push(`   Co: ${w.company || "-"} | Med: ${w.medical_status || "Pending"} | Paid: ${money(paid)}`);
    });
  }

  lines.push(``);
  lines.push(`_Generated via Passport Desk_`);

  const text = lines.join("\n");
  copyText(text);
  toast("OK Briefing copied to clipboard! Ready to share on WhatsApp or read on the phone.");
}

function renderDashboard() {
  const allWorkers = active("workers");
  const dashFilter = state.dashFilter || { agent: "", agency: "", company: "" };

  const agents = active("agents");
  const agencies = getSubmissionAgencies();

  // Apply dashboard filter if selected
  const workers = allWorkers.filter(w => {
    if (dashFilter.agent && w.agent_id !== dashFilter.agent) return false;
    if (dashFilter.agency) {
      if (dashFilter.agency === "__none__") {
        if (w.submission_agency && w.submission_status !== "In Office (Not Submitted)") return false;
      } else if (w.submission_agency !== dashFilter.agency) {
        return false;
      }
    }
    if (dashFilter.company && w.company !== dashFilter.company) return false;
    return true;
  });

  const isFiltered = !!(dashFilter.agent || dashFilter.agency || dashFilter.company);
  let filterDesc = "All Office Candidates";
  if (dashFilter.agent) {
    const ag = agents.find(a => a.id === dashFilter.agent);
    filterDesc = `Agent ${dashFilter.agent} (${ag ? `${ag.bd_name || ag.ml_name}` : ""})`;
  } else if (dashFilter.agency) {
    filterDesc = dashFilter.agency === "__none__" ? "In Office (Not Submitted)" : `Agency: ${dashFilter.agency}`;
  } else if (dashFilter.company) {
    filterDesc = `Company: ${dashFilter.company}`;
  }

  // Custody Counts
  const inOfficeCount = workers.filter(w => !w.submission_agency || w.submission_status === "In Office (Not Submitted)").length;
  const submittedCount = workers.filter(w => w.submission_status === "Submitted to Agency").length;
  const withAgentCount = workers.filter(w => w.submission_status === "Taken Back by Agent").length;
  const stampedCount = workers.filter(w => w.submission_status === "Visa Stamped").length;
  const deployedCount = workers.filter(w => w.passenger_status === "Completed / Deployed").length;

  // Financials
  const collected = workers.reduce((sum, row) => sum + totalPaid(row.id), 0);
  const totalContract = workers.reduce((sum, row) => sum + Number(row.contract_fee || 0), 0);
  const due = Math.max(0, totalContract - collected);
  const allCollected = active("payments").reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const submittedHandovers = active("handovers").filter(row => row.handover_type === "Office deposit" && row.status === "Completed").reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const cashInOffice = Math.max(0, allCollected - submittedHandovers);

  // Issues / Alerts
  const pendingDocs = workers.filter(w => [w.passport_status, w.photo_status, w.bgmt_status].some(v => v !== "Received")).length;
  const pendingMedical = workers.filter(w => w.medical_status === "Pending").length;
  const expiry6m = workers.filter(w => ["Expired", "Within 6 months"].includes(expiryBucket(w.passport_expiry)));

  // Agency Breakdown
  const agencyStats = agencies.map(agency => {
    const count = workers.filter(w => w.submission_agency === agency && w.submission_status === "Submitted to Agency").length;
    const stamped = workers.filter(w => w.submission_agency === agency && w.submission_status === "Visa Stamped").length;
    return { agency, count, stamped };
  }).filter(item => item.count > 0 || item.stamped > 0);

  $("#page-dashboard").innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; margin-bottom:8px;">
      <div>
        <h2 style="margin:0;">Office Dashboard</h2>
        <div class="meta" style="font-size:12px;">Real-time passport tracking &amp; phone briefing</div>
      </div>
      <button type="button" id="btn-copy-briefing" class="primary" style="font-size:13px; font-weight:700; padding:8px 14px; border-radius:10px; background:#14532d;">
         Copy Phone / WhatsApp Briefing
      </button>
    </div>

    <!-- Quick Action Hub -->
    <div class="quick-action-grid">
      ${isWritable() ? `
        <div class="quick-action-card" id="qa-scan">
          <span class="qa-icon"></span>
          <div>
            <div>Scan Passport</div>
            <div class="meta" style="font-size:11px;">Camera MRZ reader</div>
          </div>
        </div>
        <div class="quick-action-card" id="qa-add">
          <span class="qa-icon"></span>
          <div>
            <div>New Candidate</div>
            <div class="meta" style="font-size:11px;">Add passport record</div>
          </div>
        </div>
      ` : ""}
      <div class="quick-action-card" id="qa-pdf" style="grid-column: ${isWritable() ? 'auto' : 'span 2'};">
        <span class="qa-icon"></span>
        <div>
          <div>Download Manifest</div>
          <div class="meta" style="font-size:11px;">A4 Landscape Print</div>
        </div>
      </div>
      <div class="quick-action-card" id="qa-agency">
        <span class="qa-icon"></span>
        <div>
          <div>Manage Agencies</div>
          <div class="meta" style="font-size:11px;">Add, edit &amp; delete</div>
        </div>
      </div>
    </div>

    <!-- Interactive Filter Card for Phone Calls -->
    <div class="dashboard-filter-card">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
        <strong style="font-size:13px; color:var(--ink);"> Filter Dashboard (Read on Call)</strong>
        ${isFiltered ? `<button type="button" id="btn-clear-dash-filter" class="clear-filters-btn">x Reset</button>` : ""}
      </div>
      <div class="dashboard-filter-row">
        <select id="dash-agent-filter" aria-label="Filter by Agent Pair">
          <option value=""> All Agent Pairs (${agents.length})</option>
          ${agents.map(a => `<option value="${esc(a.id)}" ${a.id === dashFilter.agent ? "selected" : ""}>${esc(a.id)}  -  ${esc(a.bd_name || a.ml_name || "Agent")}</option>`).join("")}
        </select>
        <select id="dash-agency-filter" aria-label="Filter by Submission Agency">
          <option value=""> All Agencies (${agencies.length})</option>
          <option value="__none__" ${dashFilter.agency === "__none__" ? "selected" : ""}> In Office (Not Submitted)</option>
          ${agencies.map(ag => `<option value="${esc(ag)}" ${ag === dashFilter.agency ? "selected" : ""}> ${esc(ag)}</option>`).join("")}
          <option value="__add_new__"> Add New Agency /  Manage...</option>
        </select>
      </div>
      ${isFiltered ? `
        <div style="margin-top:6px; font-size:12px; color:var(--green); font-weight:600;">
          Showing: <b>${esc(filterDesc)}</b> (${workers.length} candidate${workers.length === 1 ? "" : "s"})
        </div>
      ` : ""}
    </div>

    <!-- Passport Location & Custody (Interactive Stat Cards) -->
    <h3 style="margin:14px 0 6px;"> Passport Custody &amp; Movement</h3>
    <div class="stat-grid">
      <div class="stat clickable stat-highlight-green" id="stat-in-office" title="Tap to view passports in office">
        <b>${inOfficeCount}</b>
        <span> In Office Safe</span>
        <div class="meta" style="font-size:11px; margin-top:2px;">Safe custody  -  Tap to view -></div>
      </div>

      <div class="stat clickable stat-highlight-blue" id="stat-submitted" title="Tap to view passports submitted to agencies">
        <b>${submittedCount}</b>
        <span> At Agencies</span>
        <div class="meta" style="font-size:11px; margin-top:2px;">Submitted for visa  -  Tap to view -></div>
      </div>

      <div class="stat clickable stat-highlight-amber" id="stat-with-agent" title="Tap to view passports taken back by agents">
        <b style="color:${withAgentCount > 0 ? 'var(--red)' : 'var(--ink)'};">${withAgentCount}</b>
        <span> With Agents</span>
        <div class="meta" style="font-size:11px; margin-top:2px;">${withAgentCount > 0 ? " Taken by agent  -  Tap ->" : "None with agents"}</div>
      </div>

      <div class="stat clickable stat-highlight-green" id="stat-stamped" title="Tap to view stamped calling visas">
        <b>${stampedCount}</b>
        <span>OK Visas Stamped</span>
        <div class="meta" style="font-size:11px; margin-top:2px;">${deployedCount} deployed  -  Tap -></div>
      </div>
    </div>

    <!-- Agency Breakdown -->
    ${agencyStats.length ? `
      <h3 style="margin:16px 0 6px;"> Agency Passport Holdings</h3>
      <div style="margin-bottom:14px;">
        ${agencyStats.map(item => `
          <div class="agency-summary-item" data-goto-agency="${esc(item.agency)}">
            <div>
              <strong style="font-size:13.5px;"> ${esc(item.agency)}</strong>
              <div class="meta" style="font-size:11.5px;">${item.stamped > 0 ? `${item.stamped} visa(s) stamped` : "Processing"}</div>
            </div>
            <div style="text-align:right;">
              <span class="tag good" style="font-size:12px; font-weight:700;">${item.count} passport(s)</span>
              <span style="font-size:12px; color:var(--muted); margin-left:4px;">-></span>
            </div>
          </div>
        `).join("")}
      </div>
    ` : ""}

    <!-- Financial Snapshot -->
    <h3 style="margin:16px 0 6px;"> Finance Snapshot</h3>
    <div class="stat-grid">
      <div class="stat clickable" id="stat-collected" title="View finance">
        <b>${money(collected)}</b>
        <span>Payments Collected</span>
        <div class="meta" style="font-size:11px; margin-top:2px;">${isFiltered ? "For selected scope" : "Total collections"}  -  Tap -></div>
      </div>

      <div class="stat clickable" id="stat-due" title="View finance">
        <b style="color:var(--amber);">${money(due)}</b>
        <span>Balance Due</span>
        <div class="meta" style="font-size:11px; margin-top:2px;">Pending candidate fees  -  Tap -></div>
      </div>

      ${!isFiltered ? `
        <div class="stat" style="grid-column: span 2;">
          <b>${money(cashInOffice)}</b>
          <span> Cash In Office (Undeposited)</span>
          <div class="meta" style="font-size:11px; margin-top:2px;">Total Collected ${money(allCollected)}  -  Deposited to Office ${money(submittedHandovers)}</div>
        </div>
      ` : ""}
    </div>

    <!-- Action Alerts -->
    <h3 style="margin:16px 0 6px;"> Action Alerts</h3>
    <div class="stat-grid">
      <div class="stat clickable ${expiry6m.length ? 'stat-highlight-red' : ''}" id="stat-expiry">
        <b style="color:${expiry6m.length ? 'var(--red)' : 'var(--ink)'};">${expiry6m.length}</b>
        <span>Expiring <= 6m</span>
        <div class="meta" style="font-size:11px; margin-top:2px;">${expiry6m.length ? " Renew before submit" : "All passports valid"}  -  Tap -></div>
      </div>

      <div class="stat clickable ${pendingMedical ? 'stat-highlight-amber' : ''}" id="stat-medical">
        <b>${pendingMedical}</b>
        <span>Medical Pending</span>
        <div class="meta" style="font-size:11px; margin-top:2px;">${workers.filter(w => w.medical_status === "Fit").length} already Fit  -  Tap -></div>
      </div>
    </div>
  `;

  // Attach Quick Actions
  $("#qa-scan")?.addEventListener("click", startScanner);
  $("#qa-add")?.addEventListener("click", () => openForm("workers"));
  $("#qa-pdf")?.addEventListener("click", () => printWorkers(workers));
  $("#qa-agency")?.addEventListener("click", () => openAgencyDialog());

  // Attach Briefing Generator
  $("#btn-copy-briefing")?.addEventListener("click", () => copyDashboardBriefing(workers, filterDesc));

  // Attach Dashboard Filters
  $("#dash-agent-filter")?.addEventListener("change", (e) => {
    state.dashFilter.agent = e.target.value;
    state.dashFilter.agency = "";
    renderDashboard();
  });
  $("#dash-agency-filter")?.addEventListener("change", (e) => {
    if (e.target.value === "__add_new__") {
      e.target.value = state.dashFilter.agency || "";
      openAgencyDialog(() => renderDashboard());
      return;
    }
    state.dashFilter.agency = e.target.value;
    state.dashFilter.agent = "";
    renderDashboard();
  });
  $("#btn-clear-dash-filter")?.addEventListener("click", () => {
    state.dashFilter = { agent: "", agency: "", company: "" };
    renderDashboard();
  });

  // Attach Interactive Click Handlers to Stat Cards
  $("#stat-in-office")?.addEventListener("click", () => {
    navigateToWorkers({ subStatus: "In Office (Not Submitted)", agency: "", filter: "" });
  });
  $("#stat-submitted")?.addEventListener("click", () => {
    navigateToWorkers({ subStatus: "Submitted to Agency", filter: "" });
  });
  $("#stat-with-agent")?.addEventListener("click", () => {
    navigateToWorkers({ subStatus: "Taken Back by Agent", filter: "" });
  });
  $("#stat-stamped")?.addEventListener("click", () => {
    navigateToWorkers({ subStatus: "Visa Stamped", filter: "" });
  });
  $("#stat-expiry")?.addEventListener("click", () => {
    navigateToWorkers({ filter: "6" });
  });
  $("#stat-medical")?.addEventListener("click", () => {
    navigateToWorkers({ filter: "medical" });
  });
  $("#stat-collected")?.addEventListener("click", () => {
    setPage("finance");
  });
  $("#stat-due")?.addEventListener("click", () => {
    setPage("finance");
  });

  // Agency items click
  document.querySelectorAll("[data-goto-agency]").forEach(el => {
    el.addEventListener("click", () => {
      const ag = el.dataset.gotoAgency;
      navigateToWorkers({ agency: ag, subStatus: "" });
    });
  });
}

function workerCard(row) {
  const currentQuery = ($("#worker-search")?.value || "").trim();
  const duplicate = row.passport_no && active("workers").filter(item => item.passport_no?.toUpperCase() === row.passport_no.toUpperCase()).length > 1;
  const expiry = expiryBucket(row.passport_expiry);
  const tagClass = expiry === "Expired" ? "bad" : expiry.startsWith("Within") ? "warn" : "good";
  const paid = totalPaid(row.id);
  const fee = Number(row.contract_fee || 0);
  const pendingDocs = [row.passport_status, row.photo_status, row.bgmt_status].filter(v => v !== "Received").length;
  const statusColor = {
    "New": "var(--blue)",
    "In Processing": "var(--amber)",
    "Completed / Deployed": "var(--good)",
    "On Hold": "var(--muted)",
    "Cancelled": "var(--red)"
  }[row.passenger_status || "New"] || "var(--muted)";

  const isWithdrawn = row.submission_status === "Taken Back by Agent";

  const agencyTag = isWithdrawn
    ? `<span class="tag bad" style="font-weight:750;"> Passport With Agent</span>`
    : row.submission_agency
      ? `<span class="tag good"> Agency: ${esc(row.submission_agency)}</span>`
      : `<span class="tag"> In Office</span>`;

  const subStatusTag = isWithdrawn
    ? ""
    : (row.submission_status && row.submission_status !== "In Office (Not Submitted)"
      ? `<span class="tag warn">${esc(row.submission_status)}</span>`
      : "");

  const masked = maskPassport(row.passport_no);
  const displayedName = highlightMatch(row.name || "Unnamed worker", currentQuery);
  const displayedPassport = highlightMatch(masked, currentQuery);

  return `<article class="card record-card" data-open="workers" data-id="${esc(row.id)}">
    <div class="record-title">
      <div>
        <strong>${displayedName}</strong>
        <div class="passport-badge-wrap">
          <span class="passport-pill"> <span class="pp-text" data-passport-id="${esc(row.id)}" data-full="${esc(row.passport_no || '')}" data-masked="${esc(masked)}">${displayedPassport}</span></span>
          ${row.passport_no ? `<button type="button" class="unmask-passport-btn" data-toggle-mask="${esc(row.id)}" title="Show full passport" aria-label="Show full passport">Show</button>` : ""}
          ${row.passport_no ? `<button type="button" class="copy-passport-btn" data-copy="${esc(row.passport_no)}" title="Copy passport"> Copy</button>` : ""}
          ${duplicate ? statusTag("Duplicate", "bad") : ""}
          ${row.review ? statusTag("Review date", "warn") : ""}
        </div>
      </div>
      ${statusTag(expiry, tagClass)}
    </div>

    <div class="route-badge" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:6px;">
      <div>
        <span> ${esc(agentName(row.agent_id))}</span>
        <span>-></span>
        <span> ${esc(row.company || "Unassigned")}</span>
      </div>
      <div>
        ${agencyTag} ${subStatusTag}
      </div>
    </div>

    <div class="meta" style="margin: 4px 0;">
      <span style="font-weight: 700; color: ${statusColor};"> ${esc(row.passenger_status || "New")}</span>
       -  Expiry ${esc(row.passport_expiry || "-")}
      ${row.submission_date ? ` -  Submitted: <b>${esc(row.submission_date)}</b>` : ""}
       -  Paid <b>${money(paid)}</b>${fee ? ` / ${money(fee)}` : ""}
    </div>

    <div class="meta" style="display:flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 6px;">
      <span class="tag ${pendingDocs === 0 ? "good" : "warn"}">Docs: ${pendingDocs === 0 ? "OK Complete" : `${pendingDocs} pending`}</span>
      <span class="tag ${row.medical_status === "Fit" ? "good" : row.medical_status === "Failed/Issue" ? "bad" : "warn"}">Med: ${esc(row.medical_status || "Pending")}</span>
      ${row.phone ? `<a href="tel:${esc(row.phone)}" class="phone-action-btn" onclick="event.stopPropagation()"> ${esc(row.phone)}</a>` : ""}
    </div>

    ${isWithdrawn ? `
      <div style="background:color-mix(in srgb, var(--red) 12%, var(--panel)); border:1px solid color-mix(in srgb, var(--red) 40%, transparent); border-radius:10px; padding:9px 12px; margin:8px 0 2px; font-size:12px;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <strong style="color:var(--red); font-size:12.5px;"> PASSPORT WITH AGENT</strong>
          <span style="font-weight:600; color:var(--muted);">${esc(row.passport_withdrawn_date || "")}</span>
        </div>
        <div style="margin-top:3px; color:var(--ink);">Taken by: <b>${esc(row.passport_withdrawn_by || agentName(row.agent_id))}</b></div>
        ${row.passport_withdrawn_reason ? `<div style="font-size:11px; color:var(--muted); margin-top:2px;">Reason: ${esc(row.passport_withdrawn_reason)}</div>` : ""}
        ${row.passport_withdrawn_notes ? `<div style="font-size:11px; color:var(--muted); margin-top:1px;">Notes: ${esc(row.passport_withdrawn_notes)}</div>` : ""}
      </div>
    ` : ""}

    <div class="card-actions">
      ${isWithdrawn ? `
        <button type="button" class="primary" data-receive-back="${esc(row.id)}" style="font-size: 13px; font-weight:700;"> Receive Back</button>
        <button type="button" class="secondary" data-print-slip="${esc(row.id)}" style="font-size: 13px;"> Slip</button>
        <button type="button" class="secondary" data-open="workers" data-id="${esc(row.id)}" style="font-size: 13px;"> Edit</button>
        <button type="button" class="danger delete-worker-btn" data-delete-worker="${esc(row.id)}" style="font-size: 13px; padding: 6px 10px;" title="Move to trash">Trash</button>
      ` : `
        <button type="button" class="secondary take-back-btn" data-take-back="${esc(row.id)}" style="font-size: 13px; font-weight:700; color:#b45309; border-color:#f59e0b; background:#fffbeb;"> Take Back</button>
        <button type="button" data-dossier="${esc(row.id)}" class="secondary" style="font-size: 13px;"> Dossier</button>
        <button type="button" class="primary" data-open="workers" data-id="${esc(row.id)}" style="font-size: 13px;"> Edit</button>
        <button type="button" class="danger delete-worker-btn" data-delete-worker="${esc(row.id)}" style="font-size: 13px; padding: 6px 10px;" title="Move to trash">Trash</button>
      `}
    </div>
  </article>`;
}

function renderWorkers() {
  const previous = {
    query: $("#worker-search")?.value || "",
    agency: $("#agency-filter")?.value || "",
    subStatus: $("#substatus-filter")?.value || "",
    agent: $("#agent-filter")?.value || "",
    company: $("#company-filter")?.value || "",
    pipeline: $("#pipeline-filter")?.value || "",
    medical: $("#medical-filter")?.value || "",
    filter: $("#worker-filter")?.value || ""
  };
  if (state.workerFilterPresets) {
    Object.assign(previous, state.workerFilterPresets);
    state.workerFilterPresets = null;
  }
  const list = filteredWorkers();
  const visible = list.slice(state.pageIndex * PAGE_SIZE, (state.pageIndex + 1) * PAGE_SIZE);

  const agencies = getSubmissionAgencies();
  const subStatuses = ["In Office (Not Submitted)", "Submitted to Agency", "Taken Back by Agent", "Visa Stamped", "Received from Agency", "Delivered to Candidate"];
  const agentIds = [...new Set(active("workers").map(row => row.agent_id).filter(Boolean))].sort();
  const companies = [...new Set(active("workers").map(row => row.company).filter(Boolean))].sort();
  const pipelineStatuses = [...new Set(active("workers").map(row => row.passenger_status).filter(Boolean))].sort();

  const activeChip = previous.filter || (previous.subStatus ? `sub:${previous.subStatus}` : previous.agency ? `agency:${previous.agency}` : previous.pipeline ? `pipe:${previous.pipeline}` : "all");

  const chips = [
    { id: "all", label: `All (${active("workers").length})` },
    { id: "sub:Taken Back by Agent", label: ` With Agent (${active("workers").filter(w => w.submission_status === "Taken Back by Agent").length})` },
    { id: "sub:Submitted to Agency", label: ` Submitted (${active("workers").filter(w => w.submission_status === "Submitted to Agency").length})` },
    { id: "sub:In Office (Not Submitted)", label: ` In Office (${active("workers").filter(w => !w.submission_agency || w.submission_status === "In Office (Not Submitted)").length})` },
    { id: "sub:Visa Stamped", label: `OK Stamped (${active("workers").filter(w => w.submission_status === "Visa Stamped").length})` },
    { id: "pipe:New", label: "New" },
    { id: "pipe:In Processing", label: "Processing" },
    { id: "pipe:Completed / Deployed", label: "Deployed" },
    { id: "docs", label: "Docs pending" },
    { id: "medical", label: "Medical pending" },
    { id: "6", label: "Expiry <= 6m" },
    { id: "review", label: "Review" },
    { id: "trash", label: "Trash" }
  ];

  const filterCount = [previous.query, previous.agency, previous.subStatus, previous.agent, previous.company, previous.pipeline, previous.medical, previous.filter].filter(Boolean).length;

  let emptyStateHtml;
  if (previous.query) {
    emptyStateHtml = `<div class="empty">
      <div style="font-size:26px; margin-bottom:6px;"></div>
      <b>No candidates match "${esc(previous.query)}"</b>
      <p class="meta" style="margin-top:4px;">Check for spelling errors or search by passport number.</p>
      <button type="button" id="btn-reset-search-empty" class="secondary" style="margin-top:10px;">x Clear Search</button>
    </div>`;
  } else if (filterCount > 0) {
    emptyStateHtml = `<div class="empty">
      <div style="font-size:26px; margin-bottom:6px;"></div>
      <b>No candidates match the selected filters.</b>
      <p class="meta" style="margin-top:4px;">Try changing or clearing your filters.</p>
      <button type="button" id="clear-filters-btn-empty" class="secondary" style="margin-top:10px;">x Reset Filters</button>
    </div>`;
  } else {
    emptyStateHtml = `<div class="empty">
      <div style="font-size:30px; margin-bottom:6px;"></div>
      <b>No workers registered yet.</b>
      <p class="meta" style="margin-top:4px;">Scan a passport or add a candidate to get started.</p>
    </div>`;
  }

  $("#page-workers").innerHTML = `<h2>Workers &amp; Passports</h2>
    <div class="search-bar">
      <div class="search-input-wrap">
        <svg class="search-icon-svg" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
        <input id="worker-search" type="search" placeholder="Search candidate name or passport number..." value="${esc(previous.query)}" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Search candidates">
        ${previous.query ? '<button type="button" id="clear-search-btn" class="clear-search-btn" title="Clear search" aria-label="Clear search">x</button>' : ''}
      </div>
      <div class="filter-chips">
        ${chips.map(chip => `<button type="button" class="filter-chip ${chip.id === activeChip ? "active" : ""}" data-filter="${esc(chip.id)}">${esc(chip.label)}</button>`).join("")}
      </div>

      <div class="filters-dropdown-grid">
        <div class="filter-with-add">
          <select id="agency-filter" aria-label="Filter by Submission Agency">
            <option value=""> All Submission Agencies (${agencies.length})</option>
            <option value="__none__" ${previous.agency === "__none__" ? "selected" : ""}> In Office (Not Submitted)</option>
            ${agencies.map(ag => `<option value="${esc(ag)}" ${ag === previous.agency ? "selected" : ""}> ${esc(ag)}</option>`).join("")}
            <option value="__add_new__"> Add /  Manage Agencies (Edit &amp; Delete)...</option>
          </select>
          <button id="btn-add-agency-filter" class="quick-add-btn" type="button" title="Manage Agencies (Add, Edit, Delete)" aria-label="Manage Agencies"></button>
        </div>

        <select id="substatus-filter" aria-label="Filter by Passport Status">
          <option value=""> All Submission Statuses</option>
          ${subStatuses.map(st => `<option value="${esc(st)}" ${st === previous.subStatus ? "selected" : ""}>${esc(st)}</option>`).join("")}
        </select>

        <select id="agent-filter" aria-label="Filter by Agent Pair">
          <option value=""> All Agents (${agentIds.length})</option>
          ${agentIds.map(id => `<option value="${esc(id)}" ${id === previous.agent ? "selected" : ""}>${esc(id)}  -  ${esc(agentName(id))}</option>`).join("")}
        </select>

        <select id="company-filter" aria-label="Filter by Employer Company">
          <option value=""> All Companies (${companies.length})</option>
          ${companies.map(company => `<option value="${esc(company)}" ${company === previous.company ? "selected" : ""}>${esc(company)}</option>`).join("")}
        </select>

        <select id="pipeline-filter" aria-label="Filter by Pipeline Status">
          <option value=""> All Pipeline Statuses</option>
          ${pipelineStatuses.map(status => `<option value="${esc(status)}" ${status === previous.pipeline ? "selected" : ""}>${esc(status)}</option>`).join("")}
        </select>

        <select id="medical-filter" aria-label="Filter by Medical Status">
          <option value=""> All Medical Statuses</option>
          <option value="Fit" ${previous.medical === "Fit" ? "selected" : ""}>Medical Fit</option>
          <option value="Pending" ${previous.medical === "Pending" ? "selected" : ""}>Medical Pending</option>
          <option value="Failed/Issue" ${previous.medical === "Failed/Issue" ? "selected" : ""}>Medical Issue</option>
        </select>
      </div>

      ${filterCount > 0 ? `
        <div class="active-filter-banner">
          <span>Active Filter: <b>${list.length} candidate(s)</b> found</span>
          <button id="clear-filters-btn" class="clear-filters-btn" type="button">x Reset All</button>
        </div>
      ` : ""}

      <input type="hidden" id="worker-filter" value="${esc(previous.filter)}">
    </div>

    <div class="button-row">
      ${isWritable() ? '<button id="scan-worker" class="primary btn-lg"> Scan passport</button><button id="add-worker" class="secondary btn-lg"> Add candidate</button>' : ""}
    </div>

    <div class="button-row" style="margin-top:-4px;">
      <button id="workers-pdf" class="primary btn-lg" style="flex:1.7; background:#14532d; font-weight:700;"> Download Filtered PDF (${list.length})</button>
      <button id="workers-excel" class="secondary"> Excel</button>
      <button id="workers-csv" class="secondary"> CSV</button>
    </div>

    <div class="list-count">${list.length} candidate(s)  -  page ${state.pageIndex + 1} of ${Math.max(1, Math.ceil(list.length / PAGE_SIZE))}</div>
    ${visible.length ? visible.map(workerCard).join("") : emptyStateHtml}
    <div class="button-row"><button id="prev-page" ${state.pageIndex ? "" : "disabled"}>Previous</button><button id="next-page" ${(state.pageIndex + 1) * PAGE_SIZE < list.length ? "" : "disabled"}>Next</button></div>`;

  document.querySelectorAll(".filter-chip").forEach(chip => {
    chip.onclick = () => {
      const filterId = chip.dataset.filter;
      if (filterId.startsWith("sub:")) {
        $("#substatus-filter").value = filterId.replace("sub:", "");
        $("#agency-filter").value = "";
        $("#worker-filter").value = "";
        $("#pipeline-filter").value = "";
      } else if (filterId.startsWith("pipe:")) {
        $("#pipeline-filter").value = filterId.replace("pipe:", "");
        $("#worker-filter").value = "";
      } else if (filterId === "all") {
        $("#agency-filter").value = "";
        $("#substatus-filter").value = "";
        $("#agent-filter").value = "";
        $("#company-filter").value = "";
        $("#pipeline-filter").value = "";
        $("#medical-filter").value = "";
        $("#worker-filter").value = "";
        $("#worker-search").value = "";
      } else {
        $("#worker-filter").value = filterId;
        $("#pipeline-filter").value = "";
      }
      state.pageIndex = 0;
      renderWorkers();
    };
  });

  $("#clear-filters-btn")?.addEventListener("click", () => {
    $("#agency-filter").value = "";
    $("#substatus-filter").value = "";
    $("#agent-filter").value = "";
    $("#company-filter").value = "";
    $("#pipeline-filter").value = "";
    $("#medical-filter").value = "";
    $("#worker-filter").value = "";
    $("#worker-search").value = "";
    state.pageIndex = 0;
    renderWorkers();
  });

  const searchInput = $("#worker-search");
  if (searchInput) {
    let debounceTimer;
    searchInput.addEventListener("input", () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        state.pageIndex = 0;
        const curStart = searchInput.selectionStart;
        const curEnd = searchInput.selectionEnd;
        renderWorkers();
        const fresh = $("#worker-search");
        if (fresh) {
          fresh.focus();
          try { if (curStart !== null) fresh.setSelectionRange(curStart, curEnd); } catch (_) {}
        }
      }, 160);
    });
  }

  $("#clear-search-btn")?.addEventListener("click", () => {
    const input = $("#worker-search");
    if (input) input.value = "";
    state.pageIndex = 0;
    renderWorkers();
    $("#worker-search")?.focus();
  });

  $("#btn-reset-search-empty")?.addEventListener("click", () => {
    const input = $("#worker-search");
    if (input) input.value = "";
    state.pageIndex = 0;
    renderWorkers();
  });

  $("#clear-filters-btn-empty")?.addEventListener("click", () => {
    $("#clear-filters-btn")?.click();
  });
  $("#agency-filter").addEventListener("change", (e) => {
    if (e.target.value === "__add_new__") {
      e.target.value = previous.agency || "";
      openAgencyDialog((newAgency) => {
        state.pageIndex = 0;
        renderWorkers();
        const sel = $("#agency-filter");
        if (sel) {
          sel.value = newAgency;
          state.pageIndex = 0;
          renderWorkers();
        }
      });
      return;
    }
    state.pageIndex = 0;
    renderWorkers();
  });
  $("#btn-add-agency-filter")?.addEventListener("click", () => {
    openAgencyDialog((newAgency) => {
      state.pageIndex = 0;
      renderWorkers();
      const sel = $("#agency-filter");
      if (sel) {
        sel.value = newAgency;
        state.pageIndex = 0;
        renderWorkers();
      }
    });
  });
  $("#substatus-filter").addEventListener("change", () => { state.pageIndex = 0; renderWorkers(); });
  $("#agent-filter").addEventListener("change", () => { state.pageIndex = 0; renderWorkers(); });
  $("#company-filter").addEventListener("change", () => { state.pageIndex = 0; renderWorkers(); });
  $("#pipeline-filter").addEventListener("change", () => { state.pageIndex = 0; renderWorkers(); });
  $("#medical-filter").addEventListener("change", () => { state.pageIndex = 0; renderWorkers(); });

  $("#prev-page").onclick = () => { state.pageIndex = Math.max(0, state.pageIndex - 1); renderWorkers(); };
  $("#next-page").onclick = () => { state.pageIndex += 1; renderWorkers(); };
  $("#add-worker")?.addEventListener("click", () => openForm("workers"));
  $("#scan-worker")?.addEventListener("click", startScanner);
  $("#workers-csv").onclick = () => exportCsv(list);
  $("#workers-excel").onclick = () => exportExcel(list);
  $("#workers-pdf").onclick = () => printWorkers(list);
}

function renderSimpleTable(table, target) {
  const rows = active(table);
  const title = { agents: "Agents", companies: "Companies" }[table];
  const addButton = isWritable() ? `<button id="add-${table}" class="primary">Add ${table === "agents" ? "agent pair" : "company"}</button>` : "";
  const cards = rows.map(row => {
    if (table === "agents") {
      const count = active("workers").filter(worker => worker.agent_id === row.id).length;
      return `<article class="card record-card" data-open="${table}" data-id="${esc(row.id)}"><div class="record-title"><b>${esc(row.id)}</b>${statusTag(`${count} workers`, count ? "good" : "")}</div><div class="meta">Malaysia: ${esc(row.ml_name || "-")}  -  ${esc(row.ml_phone || "-")}</div><div class="meta">Bangladesh: ${esc(row.bd_name || "-")}  -  ${esc(row.bd_phone || "-")}</div></article>`;
    }
    const assigned = active("workers").filter(worker => worker.company === row.name).length;
    return `<article class="card record-card" data-open="${table}" data-id="${esc(row.id)}"><div class="record-title"><b>${esc(row.name)}</b>${statusTag(`${assigned}/${row.vacancy || 0}`, assigned > Number(row.vacancy || 0) ? "bad" : "good")}</div><div class="meta">Vacancies remaining ${Number(row.vacancy || 0) - assigned}  -  Fee ${money(row.fee)}</div></article>`;
  }).join("");
  $(target).innerHTML = `<h2>${title}</h2><div class="button-row">${addButton}</div>${cards || '<div class="empty">No records yet. Add your first record.</div>'}`;
  $(`#add-${table}`)?.addEventListener("click", () => openForm(table));
}

function renderFinance() {
  const tab = $("#finance-tab")?.value || "payments";
  const rows = active(tab);
  const title = { payments: "Payments", handovers: "Money handover", expenses: "Office expenses" }[tab];
  const cards = rows.slice().sort((a, b) => String(b.paid_at || "").localeCompare(String(a.paid_at || ""))).map(row => {
    const worker = row.worker_id ? rowById("workers", row.worker_id) : null;
    const overpaid = row.overpayment || (worker && totalPaid(worker.id) > Number(worker.contract_fee || 0));
    return `<article class="card record-card" data-open="${tab}" data-id="${esc(row.id)}"><div class="record-title"><b>${esc(tab === "payments" ? workerLabel(worker || {}) : row.description || row.handover_type || row.company || row.category || "Ledger record")}</b>${statusTag(money(row.amount), overpaid ? "bad" : "good")}</div><div class="meta">${esc(row.stage || row.category || row.handover_type || "")}  -  ${esc(row.paid_at || "No date")}  -  ${esc(row.method || "")}</div><div class="meta">${esc(row.receipt_no || row.reference || row.vendor || row.notes || "")} ${overpaid ? " -  OVERPAYMENT" : ""}</div>${tab === "payments" ? `<div class="card-actions"><button data-receipt="${esc(row.id)}">Receipt</button></div>` : ""}</article>`;
  }).join("");
  $("#page-finance").innerHTML = `<h2>Finance</h2><label>Ledger<select id="finance-tab">${["payments", "handovers", "expenses"].map(item => `<option value="${item}" ${item === tab ? "selected" : ""}>${{ payments: "Payments", handovers: "Money handover", expenses: "Office expenses" }[item]}</option>`).join("")}</select></label>
    <div class="button-row">${isWritable() ? `<button id="add-finance" class="primary">Add ${tab === "payments" ? "payment" : tab === "handovers" ? "handover" : "expense"}</button>` : ""}<button id="finance-csv">Export CSV</button></div>${cards || '<div class="empty">No finance records yet.</div>'}`;
  $("#finance-tab").onchange = renderFinance;
  $("#add-finance")?.addEventListener("click", () => openForm(tab));
  $("#finance-csv").onclick = () => exportCsv(rows, tab);
  document.querySelectorAll("[data-receipt]").forEach(button => button.onclick = event => { event.stopPropagation(); printReceipt(rowById("payments", button.dataset.receipt)); });
}

function renderData() {
  const trash = DATA_TABLES.flatMap(table => state.rows[table].filter(row => row.deleted_at).map(row => ({ table, row })));
  const adminPanel = state.role === "admin" ? `<section class="card">
    <h3>Accounts</h3>
    <p class="meta">Create a staff login and assign a role. Accounts are confirmed immediately without email rate limits.</p>
    <label>New user email<input id="new-user-email" type="email" placeholder="staff@zkrecruiting.com" autocomplete="off"></label>
    <label>Temporary password<input id="new-user-password" type="password" placeholder="At least 8 characters" autocomplete="new-password"></label>
    <label>Role<select id="new-user-role">
      <option value="staff">Staff (read/write)</option>
      <option value="viewer">Viewer (read only)</option>
      <option value="admin">Admin (full access)</option>
    </select></label>
    <button id="create-user" class="primary btn-lg" style="margin-top:12px;">Create account</button>
    <div style="margin-top:16px;">
      <h4 style="font-size:13px; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:8px; color:var(--muted);">Registered Users (${active("user_profiles").length})</h4>
      <div style="display:flex; flex-direction:column; gap:8px;">
        ${active("user_profiles").map(profile => `
          <div class="record-title card" style="margin:0; padding:12px 14px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
            <div>
              <strong style="font-size:14px;">${esc(profile.email)}</strong>
              <div class="meta" style="margin-top:2px;">
                <span class="tag ${profile.role === 'admin' ? 'good' : 'warn'}">${esc(profile.role.toUpperCase())}</span>
                 -  <span style="color:${profile.enabled ? 'var(--good)' : 'var(--muted)'}; font-weight:600;">${profile.enabled ? ' Enabled' : ' Disabled'}</span>
              </div>
            </div>
            <div style="display:flex; gap:6px; align-items:center;">
              ${profile.id !== state.user?.id ? `
                <button type="button" data-profile="${esc(profile.id)}" class="secondary" style="font-size:13px; padding:6px 12px; min-height:36px;">
                  ${profile.enabled ? 'Disable' : 'Enable'}
                </button>
                <button type="button" data-delete-user="${esc(profile.id)}" data-user-email="${esc(profile.email)}" class="danger" style="font-size:13px; padding:6px 10px; min-height:36px;" title="Delete account completely" aria-label="Delete user">
                  
                </button>
              ` : `<span class="tag good" style="font-weight:700;">Active Session</span>`}
            </div>
          </div>
        `).join("") || '<p class="empty">No user profiles.</p>'}
      </div>
    </div>
  </section>` : "";
  const configured = !String(config.supabaseUrl || "").includes("PASTE") && config.supabaseAnonKey && !String(config.supabaseAnonKey).includes("PASTE");

  $("#page-data").innerHTML = `<h2>More</h2>
    <section class="card">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <h3 style="margin:0;"> Free Cloud Database (Supabase Sync)</h3>
        <span class="tag ${configured ? 'good' : 'warn'}">${configured ? 'OK Cloud Connected' : ' Offline Phone Mode'}</span>
      </div>
      <p class="meta" style="margin:6px 0 12px;">Connect a free Supabase Postgres database. Your records replicate automatically across all devices and can NEVER be lost.</p>

      <label>Supabase Project URL
        <input id="cloud-url-input" type="url" placeholder="https://xyzcompany.supabase.co" value="${esc(config.supabaseUrl || "")}">
      </label>
      <label>Supabase Anon Public Key
        <input id="cloud-key-input" type="password" placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6..." value="${esc(config.supabaseAnonKey || "")}">
      </label>

      <div class="button-row" style="margin-top:10px;">
        <button type="button" id="btn-save-cloud-config" class="primary"> Connect &amp; Sync Cloud</button>
        ${configured ? `<button type="button" id="btn-push-all-cloud" class="secondary"> Push All Local Records</button>` : ""}
        <button id="sync-now" class="secondary"> Sync Now (${state.pending.size})</button>
      </div>

      <div class="meta" style="font-size:12px; margin-top:10px; line-height:1.5;">
        ${state.lastSync ? `OK Last cloud sync: <b>${new Date(state.lastSync).toLocaleString()}</b>` : "No cloud sync performed yet."}
        ${state.pending.size ? ` -  <b style="color:var(--amber);">${state.pending.size} change(s)</b> queued on phone to sync.` : ""}
      </div>

      <details style="margin-top:12px; font-size:12px; border-top:1px dashed var(--line); padding-top:8px;">
        <summary style="cursor:pointer; font-weight:600; color:var(--green);"> How to get your free database in 2 minutes (Step by Step)</summary>
        <ol style="padding-left:18px; margin:8px 0; line-height:1.6; color:var(--muted);">
          <li>Go to <a href="https://supabase.com" target="_blank" style="color:var(--green); font-weight:bold;">supabase.com</a> and sign up for a 100% free account.</li>
          <li>Click <b>New Project</b> (e.g. name it <i>passport-desk</i>).</li>
          <li>Go to <b>SQL Editor</b> on the left sidebar, paste the contents of <code>schema.sql</code>, and click <b>Run</b>.</li>
          <li>Go to <b>Project Settings -> API</b>. Copy the <b>Project URL</b> and <b>anon public key</b>.</li>
          <li>Paste them above and tap <b>Connect &amp; Sync Cloud</b>. Done!</li>
        </ol>
      </details>
    </section>

    <section class="card"><h3>Backup and restore</h3><p class="meta">Backups include cloud and local records, including trash and history. They contain sensitive passport data; store them privately. Last backup: ${state.lastBackup ? new Date(state.lastBackup).toLocaleDateString() : "never"}.</p><p class="meta">Spreadsheet backup downloads an .xlsx snapshot for manual upload to a private Google Drive; it is not automatic sync and cannot be restored here.</p><div class="button-row"><button id="backup-button" class="primary">Download full backup</button><button id="sheet-backup-button" class="secondary">Spreadsheet backup (.xlsx)</button></div><div class="button-row"><button id="restore-button">Restore JSON backup</button></div>${Date.now() - state.lastBackup > 7 * 86400000 ? '<p class="warning">Weekly reminder: download and store a backup securely.</p>' : ""}</section>
    <section class="card"><h3>Trash (${trash.length})</h3>${trash.slice(0, 50).map(({ table, row }) => `<div class="record-title card"><span>${esc(table)}  -  ${esc(row.name || row.wid || row.id)}</span><button data-restore="${esc(table)}:${esc(row.id)}">Restore</button></div>`).join("") || '<p class="empty">Trash is empty.</p>'}</section>
    <section class="card">
      <h3> Sample Testing Data</h3>
      <p class="meta">Load synthetic demo records (with zero personal data) to preview dashboard stats, agency manifests, passport returns, and PDF downloads.</p>
      <div class="button-row">
        <button type="button" id="btn-seed-sample-data" class="secondary"> Load Synthetic Sample Records</button>
      </div>
    </section>

    <section class="card"><h3>Session</h3><p class="meta">Role: ${esc(state.role || "none")}  -  App data is stored in this browser and synced to Supabase when online.</p><button id="sign-out-secondary">Sign out</button></section>${adminPanel}`;
  
  $("#btn-save-cloud-config")?.addEventListener("click", async () => {
    const url = $("#cloud-url-input")?.value?.trim() || "";
    const key = $("#cloud-key-input")?.value?.trim() || "";

    if (!url || !key) {
      return toast("Please enter both Supabase Project URL and Anon Key.");
    }
    if (!url.startsWith("https://")) {
      return toast("Supabase URL must start with https://");
    }

    storageWrite("passport-desk-cloud-url", url);
    storageWrite("passport-desk-cloud-key", key);
    config = getCloudConfig();

    if (window.supabase) {
      try {
        state.supabase = window.supabase.createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true } });
        toast("Cloud database configured. Testing sync...");
        await syncNow();
        toast("OK Connected to Supabase! All records synced successfully.");
        render();
      } catch (err) {
        toast(`Connected with notice: ${err.message}`);
        render();
      }
    } else {
      toast("Credentials saved. Reloading app to initialize Supabase...");
      location.reload();
    }
  });

  $("#btn-push-all-cloud")?.addEventListener("click", pushAllToCloud);
  $("#sync-now").onclick = syncNow;
  $("#sign-out-secondary").onclick = signOut;
  $("#backup-button").onclick = downloadBackup;
  $("#sheet-backup-button").onclick = downloadSpreadsheetBackup;
  $("#restore-button").onclick = () => $("#restore-input").click();
  $("#btn-seed-sample-data")?.addEventListener("click", async () => {
    if (!window.confirm("Load synthetic sample records for testing? This will populate sample candidates, companies, and agent pairs.")) return;
    await seedDemoData();
    toast("Synthetic sample records loaded.");
    render();
  });
  $("#create-user")?.addEventListener("click", async () => {
    const email = $("#new-user-email").value.trim().toLowerCase();
    const password = $("#new-user-password").value;
    const role = $("#new-user-role").value;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return toast("Enter a valid email address (e.g. staff@agency.com).");
    if (password.length < 8) return toast("Password must be at least 8 characters.");
    if (!state.supabase) return toast("Cloud database not connected. Connect Supabase first.");

    const button = $("#create-user");
    button.disabled = true;
    button.textContent = "Creating account...";
    try {
      // Direct Postgres RPC: Bypasses email rate limits and creates confirmed user + profile instantly
      const { data, error } = await state.supabase.rpc("admin_create_user", {
        p_email: email,
        p_password: password,
        p_role: role
      });
      if (error) throw error;

      const profile = Array.isArray(data) ? data[0] : data;
      if (!profile?.id) throw new Error("Could not create user on cloud database.");

      await saveLocal("user_profiles", {
        id: profile.id,
        email: profile.email || email,
        role: profile.role || role,
        enabled: true,
        created_at: profile.created_at || new Date().toISOString(),
        updated_at: new Date().toISOString()
      }, false);

      toast(`OK Account created for ${email} (${role}).`);
      $("#new-user-email").value = "";
      $("#new-user-password").value = "";
      renderData();
    } catch (error) {
      const msg = error?.message || String(error);
      if (msg.includes("already exists") || msg.includes("duplicate key")) {
        toast(`An account for ${email} already exists.`);
      } else if (msg.includes("Only administrators")) {
        toast("Permission denied: only admin accounts can create users.");
      } else {
        toast(`Could not create account: ${msg}`);
      }
    } finally {
      button.disabled = false;
      button.textContent = "Create account";
    }
  });

  document.querySelectorAll("[data-delete-user]").forEach(button => {
    button.onclick = async () => {
      const userId = button.dataset.deleteUser;
      const userEmail = button.dataset.userEmail || "this user";
      if (!userId) return;
      if (userId === state.user?.id) return toast("You cannot delete your own active administrator account.");

      if (!window.confirm(`Permanently delete account for "${userEmail}"?\nThis cannot be undone.`)) {
        return;
      }

      button.disabled = true;
      try {
        if (state.supabase) {
          const { error } = await state.supabase.rpc("admin_delete_user", { p_user_id: userId });
          if (error) throw error;
        }

        // Delete from in-memory state
        state.rows.user_profiles = state.rows.user_profiles.filter(p => p.id !== userId);

        // Delete from local IndexedDB
        if (state.db) {
          try {
            const tx = state.db.transaction("user_profiles", "readwrite");
            tx.objectStore("user_profiles").delete(userId);
            await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
          } catch (_) {}
        }

        toast(`OK User ${userEmail} permanently deleted.`);
        renderData();
      } catch (err) {
        toast(`Could not delete user: ${err.message || "Failed"}`);
        button.disabled = false;
      }
    };
  });

  document.querySelectorAll("[data-restore]").forEach(button => button.onclick = async () => {
    const [table, id] = button.dataset.restore.split(":");
    const row = rowById(table, id);
    if (row) await saveLocal(table, { ...row, deleted_at: null, updated_at: new Date().toISOString() });
  });
  document.querySelectorAll("[data-profile]").forEach(button => button.onclick = async () => {
    const profile = rowById("user_profiles", button.dataset.profile);
    if (profile?.id === state.user.id) return toast("You cannot disable your own account.");
    if (profile) await saveLocal("user_profiles", { ...profile, enabled: !profile.enabled, updated_at: new Date().toISOString() });
  });
}

function render() {
  updateSyncPill();
  if (!$("#app-view").hidden) {
    renderDashboard();
    renderWorkers();
    renderSimpleTable("agents", "#page-agents");
    renderSimpleTable("companies", "#page-companies");
    renderFinance();
    renderData();
    document.querySelectorAll(".page").forEach(page => page.hidden = page.id !== `page-${state.page}`);
    document.querySelectorAll(".bottom-nav button").forEach(button => button.classList.toggle("active", button.dataset.page === state.page));
    $("#app-view").hidden = !state.user || !state.role;
  }
}

function setPage(page) {
  state.page = page;
  if (page === "workers") state.pageIndex = 0;
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function navigateToWorkers(filters = {}) {
  state.workerFilterPresets = filters;
  setPage("workers");
}

function exportCsv(rows, table = "workers") {
  const columns = (FIELDS[table] || []).map(item => item[0]);
  const header = ["id", ...(table === "workers" ? ["wid"] : []), ...columns];
  const quote = value => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const csv = [header, ...rows.map(row => header.map(key => row[key]))].map(row => row.map(quote).join(",")).join("\r\n");
  download(`${table}-${today()}.csv`, `\ufeff${csv}`, "text/csv;charset=utf-8");
}

function download(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src; script.onload = resolve; script.onerror = () => reject(new Error("Could not load export library. Check your connection."));
    document.head.append(script);
  });
}

async function exportExcel(rows) {
  try {
    if (!window.XLSX) await loadScript("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js");
    const sheet = window.XLSX.utils.json_to_sheet(rows.map(row => ({ ...row })));
    const book = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(book, sheet, "Workers");
    window.XLSX.writeFile(book, `workers-${today()}.xlsx`);
  } catch (error) { toast(error.message); }
}

async function downloadSpreadsheetBackup() {
  try {
    if (!window.XLSX) await loadScript("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js");
    const book = window.XLSX.utils.book_new();
    const info = [
      ["Passport Desk backup", "Sensitive personal data - restrict access"],
      ["Created at", new Date().toISOString()],
      ["Table", "Record count"],
      ...TABLES.map(table => [table, state.rows[table].length])
    ];
    window.XLSX.utils.book_append_sheet(book, window.XLSX.utils.aoa_to_sheet(info), "Backup info");
    for (const table of TABLES) {
      const rows = state.rows[table];
      const fallbackColumns = table === "history"
        ? ["id", "table_name", "row_id", "old_row", "changed_at", "changed_by"]
        : ["id", ...(table === "workers" ? ["wid"] : []), ...(FIELDS[table] || []).map(([name]) => name), "created_at", "updated_at", "deleted_at"];
      const columns = [...new Set(rows.length ? rows.flatMap(row => Object.keys(row)) : fallbackColumns)];
      const values = rows.map(row => columns.map(column => {
        const value = row[column];
        return value && typeof value === "object" ? JSON.stringify(value) : value ?? "";
      }));
      window.XLSX.utils.book_append_sheet(book, window.XLSX.utils.aoa_to_sheet([columns, ...values]), table);
    }
    window.XLSX.writeFile(book, `passport-desk-spreadsheet-backup-${today()}.xlsx`);
    state.lastBackup = Date.now();
    storageWrite("passport-desk-last-backup", String(state.lastBackup));
    renderData();
    toast("Spreadsheet backup downloaded. Upload it to a restricted Google Drive account.");
  } catch (error) {
    toast(`Could not create spreadsheet backup: ${error.message}`);
  }
}

function printWorkers(rows) {
  const activeAgency = $("#agency-filter")?.value || "";
  const activeSubStatus = $("#substatus-filter")?.value || "";
  const activeAgent = $("#agent-filter")?.value || "";
  const activeCompany = $("#company-filter")?.value || "";
  const searchQ = ($("#worker-search")?.value || "").trim();

  const filterTags = [];
  if (activeAgency) filterTags.push(activeAgency === "__none__" ? "In Office (Not Submitted)" : `Agency: ${activeAgency}`);
  if (activeSubStatus) filterTags.push(`Status: ${activeSubStatus}`);
  if (activeAgent) filterTags.push(`Agent: ${activeAgent}  -  ${agentName(activeAgent)}`);
  if (activeCompany) filterTags.push(`Company: ${activeCompany}`);
  if (searchQ) filterTags.push(`Search: "${searchQ}"`);
  
  const filterDesc = filterTags.length ? filterTags.join(" | ") : "All Candidates";
  const docTitle = activeAgency && activeAgency !== "__none__" 
    ? `Passport Submission Manifest - ${activeAgency}` 
    : "Passport Submission & Candidate Handover Manifest";

  const rowsHtml = rows.map((row, idx) => `
    <tr>
      <td style="text-align:center;font-weight:bold;">${idx + 1}</td>
      <td class="mono">${esc(row.wid || "-")}</td>
      <td><b>${esc(row.name)}</b></td>
      <td class="mono" style="font-size:12px;letter-spacing:0.5px;"><b>${esc(row.passport_no || "No Passport")}</b></td>
      <td>${esc(row.passport_expiry || "-")}</td>
      <td><b>${esc(row.submission_agency || "In Office")}</b></td>
      <td>${esc(row.submission_date || "-")}</td>
      <td>${esc(row.company || "-")}</td>
      <td>${esc(agentName(row.agent_id))}</td>
      <td><span class="status-pill">${esc(row.submission_status || row.passenger_status || "-")}</span></td>
    </tr>
  `).join("");

  const content = `
    <div class="print-manifest-wrap">
      <div class="print-header">
        <div class="header-title">
          <h1>PASSPORT DESK  -  RECRUITMENT OFFICE</h1>
          <h2>${esc(docTitle)}</h2>
        </div>
        <div class="header-meta">
          <div><b>Date:</b> ${today()}</div>
          <div><b>Time:</b> ${new Date().toLocaleTimeString()}</div>
          <div><b>Manifest ID:</b> MAN-${Date.now().toString().slice(-6)}</div>
        </div>
      </div>

      <div class="filter-summary">
        <div>
          <b>Active Filter Criteria:</b> ${esc(filterDesc)}
        </div>
        <div class="count-badge">
          Total Passports: ${rows.length}
        </div>
      </div>

      <table>
        <thead>
          <tr>
            <th style="width:32px;text-align:center;">#</th>
            <th style="width:75px;">ID</th>
            <th>Candidate Name</th>
            <th style="width:105px;">Passport No.</th>
            <th style="width:85px;">Expiry</th>
            <th>Submission Agency</th>
            <th style="width:85px;">Sub. Date</th>
            <th>Destination Co.</th>
            <th>Agent Pair</th>
            <th style="width:95px;">Status</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml || '<tr><td colspan="10" style="text-align:center;padding:24px;font-size:13px;">No candidate passports match this filter.</td></tr>'}
        </tbody>
      </table>

      <div class="signature-section">
        <div class="sign-box">
          <h4>Handed Over By (Office Authorization)</h4>
          <p style="font-size:10px;color:#555;margin:4px 0 28px;">I confirm that the <b>${rows.length}</b> original passport booklet(s) listed above have been verified and dispatched.</p>
          <div class="sign-line"></div>
          <div class="sign-label">Authorized Officer Signature, Name &amp; Office Seal</div>
        </div>

        <div class="sign-box">
          <h4>Received &amp; Acknowledged By (Agency Representative)</h4>
          <p style="font-size:10px;color:#555;margin:4px 0 28px;">I acknowledge receipt of <b>${rows.length}</b> valid passport(s) in good condition for submission/processing.</p>
          <div class="sign-line"></div>
          <div class="sign-label">Agency Representative Signature, Name, Phone &amp; Date Stamp</div>
        </div>
      </div>
    </div>
  `;

  printDocument(docTitle, content);
}

function printDocument(title, content) {
  const win = window.open("", "_blank");
  if (!win) return toast("Allow pop-ups to print or download PDF.");
  win.document.write(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(title)}</title>
  <style>
    @page { size: A4 landscape; margin: 10mm; }
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; font-size: 11px; color: #172116; margin: 0; padding: 18px; background: #fff; }
    .print-header { border-bottom: 2px solid #14532d; padding-bottom: 10px; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: flex-start; }
    .header-title h1 { margin: 0; font-size: 18px; color: #14532d; text-transform: uppercase; letter-spacing: 0.5px; }
    .header-title h2 { margin: 4px 0 0; font-size: 13px; font-weight: 700; color: #1f2937; }
    .header-meta { text-align: right; font-size: 11px; color: #4b5563; line-height: 1.5; }
    .filter-summary { background: #f0fdf4; border: 1px solid #86efac; border-radius: 6px; padding: 10px 14px; margin-bottom: 14px; display: flex; justify-content: space-between; align-items: center; }
    .filter-summary b { color: #14532d; font-size: 12px; }
    .count-badge { background: #14532d; color: white; padding: 4px 10px; border-radius: 6px; font-weight: 700; font-size: 12px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 11px; }
    th { background: #14532d; color: white; font-weight: 600; text-align: left; padding: 8px 10px; border: 1px solid #0e3b20; text-transform: uppercase; font-size: 10px; }
    td { padding: 8px 10px; border: 1px solid #d1d5db; vertical-align: middle; }
    tr:nth-child(even) { background: #f9fafb; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-weight: 700; }
    .status-pill { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 700; background: #e5e7eb; border: 1px solid #d1d5db; }
    .signature-section { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-top: 24px; page-break-inside: avoid; }
    .sign-box { border: 1px solid #9ca3af; border-radius: 8px; padding: 14px; min-height: 110px; background: #fff; }
    .sign-box h4 { margin: 0 0 6px; font-size: 11px; text-transform: uppercase; color: #1f2937; border-bottom: 1px dashed #d1d5db; padding-bottom: 4px; }
    .sign-line { border-bottom: 1px solid #111; margin-top: 44px; }
    .sign-label { font-size: 10px; color: #6b7280; margin-top: 4px; text-align: center; }
    .no-print { position: fixed; top: 14px; right: 14px; z-index: 999; display: flex; gap: 10px; }
    .print-btn { background: #14532d; color: #fff; border: 0; padding: 12px 20px; border-radius: 8px; font-size: 14px; font-weight: 700; cursor: pointer; box-shadow: 0 4px 12px rgba(0,0,0,0.25); display: flex; align-items: center; gap: 6px; }
    @media print {
      .no-print { display: none !important; }
      body { padding: 0; }
      @page { size: A4 landscape; margin: 10mm; }
    }
  </style>
</head>
<body>
  <div class="no-print">
    <button class="print-btn" onclick="window.print()"> Download as PDF / Print Manifest</button>
  </div>
  ${content}
</body>
</html>`);
  win.document.close();
}

function printReceipt(payment) {
  const worker = rowById("workers", payment?.worker_id) || {};
  printDocument("Payment receipt", `<p><b>Receipt:</b> ${esc(payment?.receipt_no || payment?.id || "-")}</p><p><b>Candidate:</b> ${esc(worker.name || "-")}  -  ${esc(worker.wid || "")}</p><p><b>Passport:</b> ${esc(worker.passport_no || "-")}</p><p><b>Stage:</b> ${esc(payment?.stage || "-")}</p><p><b>Amount:</b> ${esc(money(payment?.amount))}</p><p><b>Date:</b> ${esc(payment?.paid_at || "-")}</p><p><b>Method:</b> ${esc(payment?.method || "-")}</p><p><b>Received by:</b> ${esc(payment?.collector || "-")}</p>`);
}

function workerDossier(worker) {
  const agent = rowById("agents", worker.agent_id) || {};
  const payments = workerPayments(worker.id);
  return `<p><b>Worker ID:</b> ${esc(worker.wid || "Assigned on sync")}</p><p><b>Full name:</b> ${esc(worker.name)}</p><p><b>Passport:</b> ${esc(worker.passport_no || "-")}  -  Expiry ${esc(worker.passport_expiry || "-")}</p><p><b>Date of birth / sex:</b> ${esc(worker.dob || "-")} / ${esc(worker.sex || "-")}</p><p><b>Phone:</b> ${esc(worker.phone || "-")}</p><p><b>Agent pair:</b> ${esc(agent.ml_name || "-")} / ${esc(agent.bd_name || "-")}</p><p><b>Company:</b> ${esc(worker.company || "-")}  -  ${esc(worker.position || "-")}</p><p><b>Status:</b> ${esc(worker.passenger_status || "-")}</p><p><b>Documents:</b> Passport ${esc(worker.passport_status)}, photo ${esc(worker.photo_status)}, BG/MT ${esc(worker.bgmt_status)}</p><p><b>Medical:</b> ${esc(worker.medical_status)}  -  expiry ${esc(worker.medical_expiry || "-")}</p><p><b>Contract:</b> ${esc(money(worker.contract_fee))}  -  paid ${esc(money(totalPaid(worker.id)))}  -  due ${esc(money(Math.max(0, Number(worker.contract_fee || 0) - totalPaid(worker.id))))}</p><h3>Payment history</h3><ul>${payments.map(payment => `<li>${esc(payment.stage)}  -  ${esc(payment.paid_at)}  -  ${esc(money(payment.amount))}  -  ${esc(payment.receipt_no || "")}</li>`).join("")}</ul><p><b>Notes:</b> ${esc(worker.notes || "-")}</p>`;
}

async function showHistory() {
  const { table, row } = state.form;
  $("#history-list").innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>';
  $("#history-dialog").showModal();
  if (!state.supabase || !state.user) {
    $("#history-list").innerHTML = '<p class="empty">Record history is available after cloud sync.</p>';
    return;
  }
  const { data, error } = await state.supabase.from("history").select("*").eq("row_id", row.id).eq("table_name", table).order("changed_at", { ascending: false }).limit(30);
  if (error) { $("#history-list").textContent = `Could not load history: ${error.message}`; return; }
  $("#history-list").innerHTML = data.length ? data.map((item, index) => `<article class="card"><div class="meta">${esc(new Date(item.changed_at).toLocaleString())}  -  ${esc(item.changed_by || "system")}</div><pre>${esc(JSON.stringify(item.old_row, null, 2))}</pre><button data-history-index="${index}" class="secondary">Restore this version</button></article>`).join("") : '<div class="empty">No previous versions have been recorded.</div>';
  document.querySelectorAll("[data-history-index]").forEach(button => button.onclick = async () => {
    const old = data[Number(button.dataset.historyIndex)].old_row;
    await saveLocal(table, { ...old, id: row.id, updated_at: new Date().toISOString() });
    $("#history-dialog").close(); $("#record-dialog").close(); toast("Previous version restored.");
  });
}

function downloadBackup() {
  const backup = { version: 3, created_at: new Date().toISOString(), records: state.rows };
  download(`passport-desk-backup-${today()}.json`, JSON.stringify(backup, null, 2), "application/json");
  state.lastBackup = Date.now();
  storageWrite("passport-desk-last-backup", String(state.lastBackup));
  renderData();
}

async function restoreBackup(file) {
  let backup;
  try { backup = JSON.parse(await file.text()); } catch { throw new Error("The selected file is not valid JSON."); }
  const records = backup.records || backup.S;
  if (!records || typeof records !== "object") throw new Error("This file is not a Passport Desk backup.");
  for (const table of TABLES) {
    if (table === "user_profiles") continue;
    for (const row of records[table] || []) {
      if (!row.id) continue;
      const local = rowById(table, row.id);
      if (table === "history") {
        if (!local) await saveLocal(table, { ...row }, false);
      } else if (!local || String(row.updated_at || "") >= String(local.updated_at || "")) {
        await saveLocal(table, { ...row });
      }
    }
  }
  await syncNow();
  toast("Backup restored. Changes are queued for sync.");
}

function ensureMrzWorker() {
  if (state.mrzWorker) return state.mrzWorker;
  navigator.serviceWorker?.controller?.postMessage("CACHE_MRZ");
  const worker = new Worker("./vendor/mrz-scanner/worker.js", { type: "module" });
  worker.addEventListener("message", event => {
    const message = event.data || {};
    const pending = state.mrzRequests.get(message.id);
    if (!pending) return;
    if (message.type === "progress") {
      pending.onProgress?.(message.stage);
    } else if (message.type === "result") {
      state.mrzRequests.delete(message.id);
      pending.resolve(message.result || {});
    }
  });
  worker.addEventListener("error", event => {
    const error = new Error(event.message || "MRZ scanner worker failed to load.");
    for (const pending of state.mrzRequests.values()) pending.reject(error);
    state.mrzRequests.clear();
    state.mrzWorker = null;
    worker.terminate();
  });
  state.mrzWorker = worker;
  return worker;
}

async function runMrzScan(blob, onProgress) {
  const worker = ensureMrzWorker();
  const id = ++state.mrzRequestId;
  const bytes = await blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      state.mrzRequests.delete(id);
      reject(new Error("MRZ scan timed out. Try a sharper, closer view."));
    }, 20000);
    state.mrzRequests.set(id, {
      onProgress,
      resolve: result => { clearTimeout(timeout); resolve(result); },
      reject: error => { clearTimeout(timeout); reject(error); }
    });
    worker.postMessage({ type: "scan", id, bytes }, [bytes]);
  });
}

function releaseCanvas(canvas) {
  if (!canvas) return;
  try { canvas.width = 0; canvas.height = 0; } catch (_) {}
}

async function sourceToJpeg(source, maxWidth = 1280) {
  const sourceWidth = source.videoWidth || source.naturalWidth || source.width;
  const sourceHeight = source.videoHeight || source.naturalHeight || source.height;
  if (!sourceWidth || !sourceHeight) throw new Error("Camera frame is not ready.");
  const scale = Math.min(1, maxWidth / sourceWidth);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(sourceWidth * scale));
  canvas.height = Math.max(1, Math.round(sourceHeight * scale));
  const context = canvas.getContext("2d", { alpha: false });
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  try {
    return await new Promise((resolve, reject) => {
      canvas.toBlob(
        blob => blob ? resolve(blob) : reject(new Error("Could not capture passport image.")),
        "image/jpeg",
        0.92
      );
    });
  } finally {
    releaseCanvas(canvas);
  }
}

function mrzDateToIso(value, kind) {
  const raw = String(value || "").replace(/</g, "");
  if (!/^\d{6}$/.test(raw)) return "";
  const yy = Number(raw.slice(0, 2));
  const month = Number(raw.slice(2, 4));
  const day = Number(raw.slice(4, 6));
  const currentYear = new Date().getFullYear();
  const candidates = [1900 + yy, 2000 + yy, 2100 + yy];
  let year;
  if (kind === "birth") {
    const valid = candidates.filter(candidate => candidate <= currentYear && candidate >= currentYear - 120);
    year = valid.length ? Math.max(...valid) : 1900 + yy;
  } else {
    year = candidates.reduce((best, candidate) =>
      Math.abs(candidate - currentYear) < Math.abs(best - currentYear) ? candidate : best
    );
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return "";
  return `${year.toString().padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parsedCheck(parsed, field) {
  return parsed.details?.find(detail => detail.field === field)?.valid === true;
}

function normalizeMrzResult(result) {
  const parsed = result?.parsed;
  if (!parsed?.valid || parsed.format !== "TD3") return null;
  const fields = parsed.fields || {};
  const surname = String(fields.lastName || "").trim().toUpperCase();
  const givenNames = String(fields.firstName || "").trim().toUpperCase();
  const sexValue = String(fields.sex || "").toLowerCase();
  return {
    surname,
    given_names: givenNames,
    name: [givenNames, surname].filter(Boolean).join(" "),
    passport_no: String(parsed.documentNumber || fields.documentNumber || "").replace(/</g, "").trim().toUpperCase(),
    nationality: String(fields.nationality || "").trim().toUpperCase(),
    issuing_state: String(fields.issuingState || "").trim().toUpperCase(),
    dob: mrzDateToIso(fields.birthDate, "birth"),
    passport_expiry: mrzDateToIso(fields.expirationDate, "expiry"),
    sex: sexValue === "male" ? "M" : sexValue === "female" ? "F" : "",
    name_truncated: false,
    checks: {
      passport: parsedCheck(parsed, "documentNumberCheckDigit"),
      dob: parsedCheck(parsed, "birthDateCheckDigit"),
      expiry: parsedCheck(parsed, "expirationDateCheckDigit"),
      personal: parsedCheck(parsed, "personalNumberCheckDigit"),
      composite: parsedCheck(parsed, "compositeCheckDigit")
    }
  };
}

function scanProgress(stage) {
  const labels = {
    detecting: "Finding MRZ anywhere in view...",
    ocr: "Reading passport characters...",
    parsing: "Validating ICAO check digits..."
  };
  const text = labels[stage] || "Scanning passport...";
  $("#scanner-status").textContent = text;
  updateConsensusUi(stage === "parsing" ? 2 : 1, text);
}

async function scanImageSource(source) {
  const blob = await sourceToJpeg(source);
  const result = await runMrzScan(blob, scanProgress);
  const data = normalizeMrzResult(result);
  if (data) return { data, error: null };
  return {
    data: null,
    error: result.error || "No valid TD3 passport MRZ found. Move closer and keep the two MRZ lines sharp."
  };
}

function updateConsensusUi(count, label) {
  for (let i = 1; i <= 2; i += 1) {
    const dot = $(`#cdot-${i}`);
    if (dot) dot.classList.toggle("filled", i <= count);
  }
  const labelEl = $("#consensus-label");
  if (labelEl) labelEl.textContent = label;
}

function updateScanReviewAcceptButton() {
  const acceptBtn = $("#btn-accept-scan");
  if (!acceptBtn) return;
  const pp = ($("#rev-passport-no")?.value || "").trim().toUpperCase();
  const isDup = pp && active("workers").some(row => row.passport_no && row.passport_no.toUpperCase() === pp);

  if (isDup) {
    acceptBtn.disabled = true;
    acceptBtn.textContent = "Duplicate Passport - Blocked";
  } else {
    acceptBtn.disabled = false;
    acceptBtn.textContent = "Confirm & Register Candidate";
  }
}

async function startScanner() {
  $("#scanner-dialog").showModal();
  state.scannerActive = true;
  state.scanBusy = false;
  updateConsensusUi(0, "Point camera at the open passport");
  $("#scanner-status").textContent = "Starting camera...";

  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Live camera requires HTTPS. Tap Pick Photo below.");
    }
    state.camera = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920, min: 1280 },
        height: { ideal: 1080, min: 720 }
      }
    });
    const video = $("#camera-video");
    video.srcObject = state.camera;
    await video.play();

    const track = state.camera.getVideoTracks()[0];
    const capabilities = track.getCapabilities?.() || {};
    if (capabilities.focusMode?.includes("continuous")) {
      track.applyConstraints({ advanced: [{ focusMode: "continuous" }] }).catch(() => {});
    }
    $("#torch-button").hidden = !capabilities.torch;
    let torch = false;
    $("#torch-button").onclick = async () => {
      torch = !torch;
      try {
        await track.applyConstraints({ advanced: [{ torch }] });
        $("#torch-button").textContent = torch ? "Torch off" : "Torch on";
      } catch {
        toast("Torch is not available on this camera.");
      }
    };

    $("#capture-now-button").disabled = false;
    $("#scanner-status").textContent = "Show the open passport anywhere in view. Scanning starts automatically.";
    updateConsensusUi(1, "Searching the full camera view...");
    scannerTick();
  } catch (error) {
    $("#capture-now-button").disabled = true;
    const isDenied = error.name === "NotAllowedError";
    $("#scanner-status").textContent = isDenied
      ? "Camera permission denied. Allow camera access or pick a photo."
      : "Live camera unavailable. Pick a passport photo instead.";
  }
}

async function scannerTick() {
  if (!state.scannerActive || state.scanBusy) return;
  const video = $("#camera-video");
  if (!video || video.readyState < 2 || !video.videoWidth) {
    setTimeout(scannerTick, 150);
    return;
  }

  state.scanBusy = true;
  try {
    const { data, error } = await scanImageSource(video);
    if (!state.scannerActive) return;
    if (data) {
      updateConsensusUi(2, "Passport verified");
      showScanReview(data);
      return;
    }
    updateConsensusUi(0, "Keep the passport sharp and move closer");
    $("#scanner-status").textContent = error;
  } catch (error) {
    if (state.scannerActive) $("#scanner-status").textContent = error.message || "Scanning...";
  } finally {
    state.scanBusy = false;
  }

  if (state.scannerActive) setTimeout(scannerTick, 120);
}

async function captureNowFromVideo() {
  const video = $("#camera-video");
  if (!video || video.readyState < 2 || !video.videoWidth) {
    return toast("Camera is not ready yet. Use Pick Photo instead.");
  }
  if (state.scanBusy) return toast("A scan is already running.");

  const button = $("#capture-now-button");
  button.disabled = true;
  button.textContent = "Scanning...";
  state.scanBusy = true;
  try {
    const { data, error } = await scanImageSource(video);
    if (data) {
      updateConsensusUi(2, "Passport verified");
      showScanReview(data);
      return;
    }
    updateConsensusUi(0, "Try again");
    $("#scanner-status").textContent = error;
    toast("MRZ not verified. Move closer, avoid glare, and try again.");
  } catch (error) {
    $("#scanner-status").textContent = `Scan failed: ${error.message || "Try again"}`;
  } finally {
    state.scanBusy = false;
    button.disabled = false;
    button.textContent = "Scan Now";
  }
}

function stopScanner() {
  state.scannerActive = false;
  state.scanBusy = false;
  state.camera?.getTracks().forEach(track => track.stop());
  state.camera = null;
  const video = $("#camera-video");
  if (video) video.srcObject = null;
  if ($("#scanner-dialog").open) $("#scanner-dialog").close();
}

function triggerScanSuccessFeedback() {
  try {
    if (navigator.vibrate) navigator.vibrate([60, 40, 80]);
  } catch (_) {}
  const flash = $("#scan-success-flash");
  if (flash) {
    flash.classList.add("active");
    setTimeout(() => flash.classList.remove("active"), 220);
  }
}

function showScanReview(result) {
  triggerScanSuccessFeedback();
  stopScanner();

  state.scannedMrz = { ...result };

  const duplicate = result.passport_no
    ? active("workers").find(row => row.passport_no && row.passport_no.toUpperCase() === result.passport_no.toUpperCase())
    : null;

  const checks = result.checks || {};
  const expiryStatus = result.passport_expiry ? expiryBucket(result.passport_expiry) : "Unknown";
  const expiryTag = expiryStatus === "Expired" ? "bad" : expiryStatus.startsWith("Within") ? "warn" : "good";

  const truncatedHtml = result.name_truncated
    ? `<div class="warning" style="margin:0; font-size:12.5px;">
         <strong> 39-Character ICAO Limit Reached:</strong> Long name may be cut off in the MRZ. Complete any missing letters below.
       </div>`
    : "";

  const duplicateHtml = duplicate
    ? `<div class="error" style="margin:0; font-size:13px; line-height:1.45;">
         <strong> DUPLICATE PASSPORT DETECTED</strong><br>
         Passport <b>${esc(result.passport_no)}</b> is already registered to <b>${esc(duplicate.name)}</b> (${esc(duplicate.wid || duplicate.id)}). Duplicate registration is blocked.
       </div>`
    : "";

  const lastAssignment = safeJson(storageRead(`passport-desk-last-assignment-${state.user?.id || "local"}`, "{}"));
  const companyOptions = active("companies").map(c => `<option value="${esc(c.name)}" ${c.name === lastAssignment.company ? "selected" : ""}>${esc(c.name)}</option>`).join("");
  const agentOptions = active("agents").map(a => `<option value="${esc(a.id)}" ${a.id === lastAssignment.agent_id ? "selected" : ""}>${esc(a.id)}  -  ${esc(agentName(a.id))}</option>`).join("");

  const reviewHtml = `
    ${truncatedHtml}
    ${duplicateHtml}

    <div class="scan-review-card">
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:6px; margin-bottom:2px;">
        <span style="font-size:12px; font-weight:750; color:var(--green-text); text-transform:uppercase; letter-spacing:0.5px;">
          Candidate Details (TD3  -  ${esc(result.issuing_state || "-")})
        </span>
        ${statusTag(expiryStatus, expiryTag)}
      </div>

      <div class="scan-review-edit-grid two-col">
        <label>Surname (Last Name)
          <input id="rev-surname" type="text" value="${esc(result.surname || "")}" autocomplete="off" required>
        </label>
        <label>Given Names (First / Middle)
          <input id="rev-given" type="text" value="${esc(result.given_names || "")}" autocomplete="off">
        </label>
      </div>

      <div class="review-row" style="padding-top:4px;">
        <span class="review-label">Saved Full Name</span>
        <span class="review-value" id="rev-full-preview" style="font-size:15px; color:var(--green); font-weight:750;">${esc(result.name || "-")}</span>
      </div>

      <div class="scan-review-edit-grid two-col">
        <label>Passport Number
          <input id="rev-passport-no" type="text" value="${esc(result.passport_no || "")}" style="font-family:ui-monospace, monospace;" autocomplete="off" required>
        </label>
        <label>Nationality
          <input id="rev-nationality" type="text" value="${esc(result.nationality || "")}" autocomplete="off">
        </label>
        <label>Date of Birth
          <input id="rev-dob" type="date" value="${esc(result.dob || "")}" style="text-transform:none;">
        </label>
        <label>Passport Expiry
          <input id="rev-expiry" type="date" value="${esc(result.passport_expiry || "")}" style="text-transform:none;">
        </label>
        <label>Sex
          <select id="rev-sex" style="text-transform:none;">
            <option value="" ${!result.sex ? "selected" : ""}>Unspecified</option>
            <option value="M" ${result.sex === "M" ? "selected" : ""}>M (Male)</option>
            <option value="F" ${result.sex === "F" ? "selected" : ""}>F (Female)</option>
          </select>
        </label>
        <label>Phone Number (Optional)
          <input id="rev-phone" type="tel" placeholder="e.g. 01700000000" autocomplete="off" style="text-transform:none;">
        </label>
      </div>
    </div>

    <div class="scan-review-card" style="background:var(--panel); border:1px solid var(--line);">
      <span style="font-size:12px; font-weight:750; color:var(--green-text); text-transform:uppercase; letter-spacing:0.5px;">
         Company &amp; Agent Placement
      </span>

      <div class="scan-review-edit-grid two-col">
        <div class="searchable-field-wrap">
          <label for="rev-company" style="font-weight:600; display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
            <span>Company</span>
            <span id="rev-company-count" style="font-size:11px; color:var(--muted); font-weight:normal;"></span>
          </label>
          <div class="search-input-box" style="margin-bottom:6px;">
            <input type="text" id="rev-company-search" class="search-filter-input" placeholder=" Search company name..." autocomplete="off">
            <button type="button" id="rev-company-clear" class="search-clear-inline" style="display:none;">x</button>
          </div>
          <select id="rev-company">
            <option value="">- Unassigned (Select Company) -</option>
            ${companyOptions}
          </select>
        </div>

        <div class="searchable-field-wrap">
          <label for="rev-agent" style="font-weight:600; display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
            <span>Agent Pair</span>
            <span id="rev-agent-count" style="font-size:11px; color:var(--muted); font-weight:normal;"></span>
          </label>
          <div class="search-input-box" style="margin-bottom:6px;">
            <input type="text" id="rev-agent-search" class="search-filter-input" placeholder=" Search agent (Dhaka/KL or ID)..." autocomplete="off">
            <button type="button" id="rev-agent-clear" class="search-clear-inline" style="display:none;">x</button>
          </div>
          <select id="rev-agent">
            <option value="">- Unassigned (No Agent) -</option>
            ${agentOptions}
          </select>
        </div>
      </div>

      <span style="font-size:12px; font-weight:750; color:var(--green-text); text-transform:uppercase; letter-spacing:0.5px; margin-top:6px;">
         Related Papers &amp; Documents
      </span>
      <div class="scan-review-edit-grid" style="grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap:8px;">
        <label>Passport Document
          <select id="rev-passport-status">
            <option value="Received" selected>Received (Physical)</option>
            <option value="Pending">Pending</option>
          </select>
        </label>
        <label>Photo
          <select id="rev-photo-status">
            <option value="Pending" selected>Pending</option>
            <option value="Received">Received</option>
          </select>
        </label>
        <label>BG/MT Documents
          <select id="rev-bgmt-status">
            <option value="Pending" selected>Pending</option>
            <option value="Received">Received</option>
          </select>
        </label>
        <label>Medical Status
          <select id="rev-medical-status">
            <option value="Pending" selected>Pending</option>
            <option value="Fit">Fit</option>
            <option value="Failed/Issue">Failed/Issue</option>
            <option value="Not Required">Not Required</option>
          </select>
        </label>
      </div>
    </div>

    <div>
      <span style="font-size:11.5px; font-weight:700; color:var(--muted); text-transform:uppercase; letter-spacing:0.5px;">ICAO Doc 9303 Checksums:</span>
      <div class="review-checks-grid">
        <div class="check-badge ${checks.passport ? "pass" : "fail"}">${checks.passport ? "OK Passport No." : "x Passport No."}</div>
        <div class="check-badge ${checks.dob ? "pass" : "fail"}">${checks.dob ? "OK Date of Birth" : "x Date of Birth"}</div>
        <div class="check-badge ${checks.expiry ? "pass" : "fail"}">${checks.expiry ? "OK Expiry Date" : "x Expiry Date"}</div>
        <div class="check-badge ${checks.personal ? "pass" : "fail"}">${checks.personal ? "OK Personal No." : "x Personal No."}</div>
        <div class="check-badge ${checks.composite ? "pass" : "fail"}" style="grid-column: 1 / -1;">${checks.composite ? "OK Composite Check Digit Verified" : "x Composite Check Digit"}</div>
      </div>
    </div>
  `;

  $("#scan-review-content").innerHTML = reviewHtml;

  // Initialize searchable selects for Company and Agent in review dialog
  setupSearchableSelect($("#rev-company"), $("#rev-company-search"), $("#rev-company-clear"), $("#rev-company-count"));
  setupSearchableSelect($("#rev-agent"), $("#rev-agent-search"), $("#rev-agent-clear"), $("#rev-agent-count"));

  const updateFullPreview = () => {
    const sur = ($("#rev-surname")?.value || "").trim().replace(/\s+/g, " ").toUpperCase();
    const giv = ($("#rev-given")?.value || "").trim().replace(/\s+/g, " ").toUpperCase();
    const combined = giv ? `${giv} ${sur}`.trim() : sur;
    const previewEl = $("#rev-full-preview");
    if (previewEl) previewEl.textContent = combined || "-";
  };
  $("#rev-surname")?.addEventListener("input", updateFullPreview);
  $("#rev-given")?.addEventListener("input", updateFullPreview);
  $("#rev-passport-no")?.addEventListener("input", updateScanReviewAcceptButton);
  updateScanReviewAcceptButton();

  $("#scan-review-dialog").showModal();
}

async function confirmScanReview() {
  if (!state.scannedMrz) return;
  const surname = ($("#rev-surname")?.value || "").trim().replace(/\s+/g, " ").toUpperCase();
  const givenNames = ($("#rev-given")?.value || "").trim().replace(/\s+/g, " ").toUpperCase();
  const resolvedName = givenNames ? `${givenNames} ${surname}`.trim() : surname;
  const passportNo = ($("#rev-passport-no")?.value || "").trim().toUpperCase();
  const dob = $("#rev-dob")?.value || "";
  const expiry = $("#rev-expiry")?.value || "";
  const sex = $("#rev-sex")?.value || "";
  const nationality = ($("#rev-nationality")?.value || "").trim();
  const phone = ($("#rev-phone")?.value || "").trim();
  const company = $("#rev-company")?.value || "";
  const agentId = $("#rev-agent")?.value || "";
  const passportStatus = $("#rev-passport-status")?.value || "Received";
  const photoStatus = $("#rev-photo-status")?.value || "Pending";
  const bgmtStatus = $("#rev-bgmt-status")?.value || "Pending";
  const medicalStatus = $("#rev-medical-status")?.value || "Pending";
  if (!resolvedName) {
    toast("Candidate name cannot be empty.");
    return;
  }
  if (!passportNo) {
    toast("Passport number cannot be empty.");
    return;
  }
  const duplicate = active("workers").find(row => row.passport_no?.toUpperCase() === passportNo);
  if (duplicate) {
    toast(`Duplicate passport already saved for ${duplicate.wid || duplicate.name}.`);
    return;
  }

  const workerRecord = {
    id: uuid(),
    name: resolvedName,
    surname: surname || null,
    given_names: givenNames || null,
    passport_no: passportNo,
    phone: phone || null,
    dob,
    passport_expiry: expiry,
    sex,
    nationality: nationality || "Bangladeshi",
    company: company || null,
    agent_id: agentId || null,
    passport_status: passportStatus,
    photo_status: photoStatus,
    bgmt_status: bgmtStatus,
    medical_status: medicalStatus,
    passenger_status: "New",
    submission_status: "In Office (Not Submitted)",
    submission_agency: null,
    contract_fee: 700000,
    received: today(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  if (agentId || company) {
    storageWrite(`passport-desk-last-assignment-${state.user?.id || "local"}`, JSON.stringify({ agent_id: agentId || null, company: company || null }));
  }

  state.scannedMrz = null;
  $("#scan-review-dialog")?.close();
  await saveLocal("workers", workerRecord);
  toast(`OK Candidate ${resolvedName} (${passportNo}) registered successfully!`);
  syncNow();
}

async function readPhoto(file) {
  $("#scanner-status").textContent = "Scanning passport photo...";
  updateConsensusUi(1, "Reading MRZ lines...");
  let bitmap = null;
  try {
    bitmap = await createImageBitmap(file);
    const { data, error } = await scanImageSource(bitmap);
    if (data) {
      updateConsensusUi(2, "OK Passport scanned!");
      showScanReview(data);
    } else {
      updateConsensusUi(0, "Rescan required");
      $("#scanner-status").textContent = error || "Could not detect valid passport MRZ lines.";
      toast("Could not read passport MRZ from photo. Please ensure the bottom lines are sharp and clear.");
    }
  } catch (error) {
    updateConsensusUi(0, "Photo read failed");
    $("#scanner-status").textContent = `Could not read photo: ${error.message || "Try again or use Manual Entry."}`;
  } finally {
    try { bitmap?.close?.(); } catch (_) {}
  }
}

async function seedDemoData() {
  const sampleAgents = [
    { id: "AGT-001", ml_name: "Kuala Lumpur Partner A", ml_phone: "60120000001", bd_name: "Dhaka Agent A", bd_phone: "01700000001", status: "Active" },
    { id: "AGT-002", ml_name: "Penang Partner B", ml_phone: "60120000002", bd_name: "Chittagong Agent B", bd_phone: "01700000002", status: "Active" },
    { id: "AGT-003", ml_name: "Johor Partner C", ml_phone: "60120000003", bd_name: "Sylhet Agent C", bd_phone: "01700000003", status: "Active" }
  ];
  for (const ag of sampleAgents) {
    if (!state.rows.agents.some(a => a.id === ag.id)) {
      await saveLocal("agents", { ...ag, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }, false);
    }
  }

  const sampleCompanies = [
    { name: "Apex Manufacturing Ltd", vacancy: 50, fee: 700000, status: "Active" },
    { name: "Global Logistics Berhad", vacancy: 40, fee: 700000, status: "Active" },
    { name: "Crest Engineering Works", vacancy: 25, fee: 700000, status: "Active" }
  ];
  for (const co of sampleCompanies) {
    if (!state.rows.companies.some(c => c.name === co.name)) {
      await saveLocal("companies", { ...co, id: uniqueId("companies"), created_at: new Date().toISOString(), updated_at: new Date().toISOString() }, false);
    }
  }

  const sampleWorkers = [
    { wid: "WRK-001", name: "SAMPLE CANDIDATE ALAM", phone: "01700000001", passport_no: "A00000001", passport_expiry: "2034-01-01", agent_id: "AGT-001", company: "Apex Manufacturing Ltd", passenger_status: "In Processing", passport_status: "Received", photo_status: "Received", bgmt_status: "Pending", medical_status: "Fit", submission_agency: "Eastern Agency", submission_status: "Submitted to Agency", submission_date: "2026-11-10", contract_fee: 700000, notes: "Sample test record" },
    { wid: "WRK-002", name: "SAMPLE CANDIDATE HASAN", phone: "01700000002", passport_no: "A00000002", passport_expiry: "2033-05-15", agent_id: "AGT-001", company: "Global Logistics Berhad", passenger_status: "New", passport_status: "Received", photo_status: "Pending", bgmt_status: "Pending", medical_status: "Pending", submission_status: "In Office (Not Submitted)", contract_fee: 700000, notes: "Passport in office safe" },
    { wid: "WRK-003", name: "SAMPLE CANDIDATE RAHMAN", phone: "01700000003", passport_no: "A00000003", passport_expiry: "2035-09-20", agent_id: "AGT-002", company: "Crest Engineering Works", passenger_status: "Completed / Deployed", passport_status: "Received", photo_status: "Received", bgmt_status: "Received", medical_status: "Fit", submission_agency: "Skyline Travels & Tours", submission_status: "Visa Stamped", submission_date: "2026-10-25", contract_fee: 700000, notes: "Visa stamped demo" },
    { wid: "WRK-004", name: "SAMPLE CANDIDATE KABIR", phone: "01700000004", passport_no: "A00000004", passport_expiry: "2032-11-12", agent_id: "AGT-003", company: "Apex Manufacturing Ltd", passenger_status: "New", passport_status: "Pending", photo_status: "Pending", bgmt_status: "Pending", medical_status: "Pending", submission_status: "Taken Back by Agent", passport_withdrawn_date: "2026-11-16", passport_withdrawn_by: "Dhaka Agent A (AGT-001)", passport_withdrawn_reason: "Outside Medical / Gamca Test", passport_withdrawn_notes: "Expected return next week", contract_fee: 700000, notes: "Withdrawn passport demo" }
  ];

  for (const w of sampleWorkers) {
    if (!state.rows.workers.some(item => item.passport_no === w.passport_no)) {
      const id = uniqueId("workers");
      await saveLocal("workers", { ...w, id, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }, false);
    }
  }
}

async function signOut() {
  storageWrite("passport-desk-auth-user", "");
  storageWrite("passport-desk-auth-role", "");
  storageWrite("passport-desk-demo-mode", "false");
  state.user = null;
  state.role = null;
  if (state.supabase) {
    try { await state.supabase.auth.signOut(); } catch (error) { toast(error.message); }
  }
  showAuth();
  toast("Signed out successfully");
}

function showAuth() {
  const configured = !String(config.supabaseUrl || "").includes("PASTE") && config.supabaseAnonKey && !String(config.supabaseAnonKey).includes("PASTE");
  const isLoggedIn = !!state.user && !!state.role;
  $("#login-view").hidden = isLoggedIn;
  $("#setup-view").hidden = true;
  $("#app-view").hidden = !isLoggedIn;
  if (isLoggedIn) {
    $("#sync-pill").textContent = configured ? "Cloud Connected" : " Ready (Admin)";
  } else {
    $("#sync-pill").textContent = "Sign in";
  }
}

async function loadProfile() {
  const { data, error } = await state.supabase.from("user_profiles").select("*").eq("id", state.user.id).maybeSingle();
  if (error) throw error;
  if (!data?.enabled) { state.role = null; return; }
  state.role = data.role;
  await saveLocal("user_profiles", data, false);
}

async function onSession(session) {
  state.user = session?.user || null;
  state.role = null;
  if (!state.user) { showAuth(); updateSyncPill(); return; }
  try {
    await loadProfile();
    showAuth();
    if (state.role) { render(); syncNow(); }
  } catch (error) {
    state.errors.set("account", error.message);
    showAuth();
    toast(`Could not load account permissions: ${error.message}`);
  }
}

async function changeUserSession(session) {
  const nextId = session?.user?.id || null;
  if (state.dbUser === nextId) return onSession(session);
  state.db?.close();
  state.rows = Object.fromEntries(TABLES.map(table => [table, []]));
  state.pending = new Map();
  state.errors.clear();
  state.dbUser = nextId;
  try {
    state.db = await openDatabase(nextId);
    await loadLocal();
    await onSession(session);
  } catch (error) {
    state.errors.set("storage", error.message);
    showAuth();
    toast(`Could not open this account's offline records: ${error.message}`);
  }
}

async function boot() {
  const configured = !String(config.supabaseUrl || "").includes("PASTE") && config.supabaseAnonKey && !String(config.supabaseAnonKey).includes("PASTE");
  let initialSession = null;
  if (configured && window.supabase) {
    try {
      state.supabase = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true } });
      const { data, error } = await state.supabase.auth.getSession();
      if (error) throw error;
      initialSession = data.session;
      state.dbUser = initialSession?.user?.id || null;
    } catch (error) {
      state.errors.set("auth", error.message || "Could not connect to Supabase.");
    }
  }
  try {
    state.db = await openDatabase(state.dbUser);
    await loadLocal();
  } catch (error) {
    $("#setup-view").hidden = false;
    $("#setup-view").innerHTML = `<h2>Offline storage unavailable</h2><p class="error">${esc(error.message)} Use a current browser with IndexedDB enabled.</p>`;
    return;
  }
  const storedTheme = storageRead("passport-desk-theme");
  if (storedTheme) document.documentElement.dataset.theme = storedTheme;
  const updateThemeToggle = () => {
    const button = $("#theme-toggle");
    if (button) button.textContent = document.documentElement.dataset.theme === "dark" ? "Light" : "Dark";
  };
  updateThemeToggle();
  $("#theme-toggle").onclick = () => {
    const theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = theme;
    storageWrite("passport-desk-theme", theme);
    updateThemeToggle();
  };
  document.querySelectorAll(".bottom-nav button").forEach(button => button.onclick = () => setPage(button.dataset.page));
  $("#login-button").onclick = async () => {
    const button = $("#login-button");
    if (button.disabled) return;
    button.disabled = true;
    const errorP = $("#login-error");
    if (errorP) { errorP.textContent = ""; errorP.style.display = "none"; }
    const email = $("#login-email").value.trim() || "admin@office.local";
    const password = $("#login-password").value;
    try {
      if (configured && state.supabase) {
        if (!email) throw new Error("Please enter your account email.");
        const { error } = await state.supabase.auth.signInWithPassword({ email, password });
        if (error) {
          if (errorP) { errorP.textContent = error.message; errorP.style.display = "block"; }
          return;
        }
      } else {
        const localUser = { id: "admin-user", email };
        state.user = localUser;
        state.role = "admin";
        storageWrite("passport-desk-auth-user", JSON.stringify(localUser));
        storageWrite("passport-desk-auth-role", "admin");

        if (navigator.storage?.persist) {
          try { await navigator.storage.persist(); } catch (_) {}
        }

        showAuth();
        render();
        toast(`Signed in as ${email} (Full Permissions)`);
      }
    } catch (error) {
      if (errorP) { errorP.textContent = error.message || "Sign-in failed."; errorP.style.display = "block"; }
    } finally {
      button.disabled = false;
    }
  };
  $("#save-button").onclick = () => submitForm(false);
  $("#save-next-button").onclick = () => submitForm(true);
  $("#delete-button").onclick = softDeleteCurrent;
  $("#history-button").onclick = showHistory;
  document.querySelectorAll("[data-close]").forEach(button => button.onclick = () => button.closest("dialog").close());
  setupAgencyDialog();
  setupTakebackDialog();
  $("#capture-now-button")?.addEventListener("click", captureNowFromVideo);
  $("#scanner-manual-btn")?.addEventListener("click", () => {
    stopScanner();
    openForm("workers");
  });
  $("#btn-accept-scan")?.addEventListener("click", () => {
    confirmScanReview();
  });
  $("#btn-rescan")?.addEventListener("click", () => {
    $("#scan-review-dialog")?.close();
    startScanner();
  });
  $("#btn-manual-from-review")?.addEventListener("click", () => {
    if (state.scannedMrz) {
      const surname = ($("#rev-surname")?.value || "").trim().replace(/\s+/g, " ").toUpperCase();
      const givenNames = ($("#rev-given")?.value || "").trim().replace(/\s+/g, " ").toUpperCase();
      const fullName = givenNames ? `${givenNames} ${surname}`.trim() : surname;
      const passportNo = ($("#rev-passport-no")?.value || "").trim().toUpperCase();
      const dob = $("#rev-dob")?.value || "";
      const expiry = $("#rev-expiry")?.value || "";
      const sex = $("#rev-sex")?.value || "";
      const nationality = ($("#rev-nationality")?.value || "").trim();
      const phone = ($("#rev-phone")?.value || "").trim();
      const company = $("#rev-company")?.value || "";
      const agentId = $("#rev-agent")?.value || "";
      const passportStatus = $("#rev-passport-status")?.value || "Received";
      const photoStatus = $("#rev-photo-status")?.value || "Pending";
      const bgmtStatus = $("#rev-bgmt-status")?.value || "Pending";
      const medicalStatus = $("#rev-medical-status")?.value || "Pending";

      const fields = {
        name: fullName,
        surname: surname || null,
        given_names: givenNames || null,
        passport_no: passportNo,
        phone,
        dob,
        passport_expiry: expiry,
        sex,
        nationality,
        company: company || null,
        agent_id: agentId || null,
        passport_status: passportStatus,
        photo_status: photoStatus,
        bgmt_status: bgmtStatus,
        medical_status: medicalStatus
      };
      state.scannedMrz = null;
      $("#scan-review-dialog")?.close();
      openForm("workers", null, { defaults: fields });
    } else {
      $("#scan-review-dialog")?.close();
      openForm("workers");
    }
  });
  $("#photo-button").onclick = () => $("#photo-input").click();
  $("#photo-input").onchange = event => { const file = event.target.files[0]; event.target.value = ""; if (file) readPhoto(file); };
  $("#restore-input").onchange = async event => {
    const file = event.target.files[0]; event.target.value = "";
    if (!file) return;
    try { await restoreBackup(file); } catch (error) { toast(error.message); }
  };
  const savedUserJson = storageRead("passport-desk-auth-user");
  const savedRole = storageRead("passport-desk-auth-role");
  if (savedUserJson && savedRole && !state.user) {
    state.user = safeJson(savedUserJson);
    state.role = savedRole;
  }
  document.addEventListener("click", async event => {
    const toggleMaskBtn = event.target.closest("[data-toggle-mask]");
    if (toggleMaskBtn) {
      event.stopPropagation();
      const id = toggleMaskBtn.dataset.toggleMask;
      const textEl = document.querySelector(`.pp-text[data-passport-id="${id}"]`);
      if (textEl) {
        const isMasked = textEl.textContent.includes("*");
        textEl.textContent = isMasked ? textEl.dataset.full : textEl.dataset.masked;
        toggleMaskBtn.textContent = isMasked ? "Hide" : "Show";
        toggleMaskBtn.setAttribute("aria-label", isMasked ? "Hide passport number" : "Show full passport");
        toggleMaskBtn.title = isMasked ? "Hide passport number" : "Show full passport number";
      }
      return;
    }
    const copyBtn = event.target.closest("[data-copy]");
    if (copyBtn) {
      event.stopPropagation();
      copyText(copyBtn.dataset.copy);
      return;
    }
    const deleteBtn = event.target.closest("[data-delete-worker]");
    if (deleteBtn) {
      event.stopPropagation();
      const id = deleteBtn.dataset.deleteWorker;
      const worker = rowById("workers", id);
      if (worker) {
        if (window.confirm(`Move candidate "${worker.name || worker.wid}" (${worker.passport_no || "No passport"}) to trash?`)) {
          await saveLocal("workers", { ...worker, deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() });
          toast(`Moved "${worker.name || worker.wid}" to trash.`);
        }
      }
      return;
    }
    const dossier = event.target.closest("[data-dossier]");
    if (dossier) {
      event.stopPropagation();
      const worker = rowById("workers", dossier.dataset.dossier);
      if (worker) printDocument("Worker dossier", workerDossier(worker));
      return;
    }
    const takeBackBtn = event.target.closest("[data-take-back]");
    if (takeBackBtn) {
      event.stopPropagation();
      const worker = rowById("workers", takeBackBtn.dataset.takeBack);
      if (worker) openTakebackDialog(worker);
      return;
    }
    const receiveBackBtn = event.target.closest("[data-receive-back]");
    if (receiveBackBtn) {
      event.stopPropagation();
      const worker = rowById("workers", receiveBackBtn.dataset.receiveBack);
      if (worker) markPassportReceivedBack(worker);
      return;
    }
    const printSlipBtn = event.target.closest("[data-print-slip]");
    if (printSlipBtn) {
      event.stopPropagation();
      const worker = rowById("workers", printSlipBtn.dataset.printSlip);
      if (worker) printPassportReturnSlip(worker);
      return;
    }
    const card = event.target.closest("[data-open]");
    if (!card || event.target.closest("[data-receipt]") || event.target.closest("[data-copy]") || event.target.closest("[data-delete-worker]") || event.target.closest("[data-take-back]") || event.target.closest("[data-receive-back]") || event.target.closest("[data-print-slip]") || event.target.closest(".phone-action-btn")) return;
    const table = card.dataset.open;
    const row = rowById(table, card.dataset.id);
    if (row) openForm(table, row);
  });
  $("#record-dialog").addEventListener("close", () => { state.form = null; });
  $("#scanner-dialog").addEventListener("close", () => {
    state.scannerActive = false;
    state.camera?.getTracks().forEach(track => track.stop());
    state.camera = null;
    $("#camera-video").srcObject = null;
  });
  window.addEventListener("online", syncNow);
  window.addEventListener("offline", updateSyncPill);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) syncNow(); });
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker.register("./sw.js")
      .then(() => navigator.serviceWorker.ready)
      .then(registration => (navigator.serviceWorker.controller || registration.active)?.postMessage("CACHE_MRZ"))
      .catch(error => console.warn("Service worker registration failed", error));
  }
  showAuth();
  if (configured && state.supabase) {
    try {
      await onSession(initialSession);
      state.supabase.auth.onAuthStateChange((_event, session) => { queueMicrotask(() => changeUserSession(session)); });
    } catch (error) {
      state.errors.set("auth", error.message || "Could not connect to Supabase.");
      toast(`Cloud setup error: ${error.message}`);
    }
  } else if (configured) {
    $("#login-error").textContent = "Supabase client could not load. Check your internet connection, then reload.";
  }
  if (state.errors.has("auth")) $("#login-error").textContent = `Cloud sign-in setup issue: ${state.errors.get("auth")}`;
  setInterval(syncNow, 60000);
  if (state.pending.size) updateSyncPill();
}

boot();
