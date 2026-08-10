/**
 * LandXML Alignment Stationing for Trimble Connect
 * Station ticks/labels from LandXML; alignment names resolved from IFC SBG_STATION_REF.
 */
const VERSION = "v1.2.1";
console.log(`Alignment Stationing ${VERSION} loaded.`);

const REGION_BASES = {
    northamerica: "https://app.connect.trimble.com/tc/api/2.0",
    northAmerica: "https://app.connect.trimble.com/tc/api/2.0",
    us: "https://app.connect.trimble.com/tc/api/2.0",
    europe: "https://app21.connect.trimble.com/tc/api/2.0",
    eu: "https://app21.connect.trimble.com/tc/api/2.0",
    asia: "https://app31.connect.trimble.com/tc/api/2.0",
    ap: "https://app31.connect.trimble.com/tc/api/2.0",
    australia: "https://app32.connect.trimble.com/tc/api/2.0",
    apau: "https://app32.connect.trimble.com/tc/api/2.0",
    "ap-au": "https://app32.connect.trimble.com/tc/api/2.0"
};

const FALLBACK_BASES = [
    "https://app21.connect.trimble.com/tc/api/2.0",
    "https://app.connect.trimble.com/tc/api/2.0",
    "https://app31.connect.trimble.com/tc/api/2.0",
    "https://app32.connect.trimble.com/tc/api/2.0"
];

const MM = 1000;
const BATCH = 40;
const MAX_FOLDER_DEPTH = 8;
const MAX_FOLDERS = 200;

const SWAP_NE = true;

let TC_API = null;
let apiBaseUrl = null;
let apiBaseCandidates = [];
let projectInfo = null;
let fileCatalog = new Map();
let ifcCatalog = new Map();
let selectedIfcIds = new Set();
let alignmentNameMap = new Map();
let alignments = [];
let activeMarkupIds = [];
let idCounter = 1;
let busy = false;

const els = {
    status: document.getElementById("status"),
    statusBar: document.getElementById("status-bar"),
    alignmentSection: document.getElementById("alignment-section"),
    alignmentCount: document.getElementById("alignment-count"),
    listItems: document.getElementById("list-items"),
    drawBtn: document.getElementById("draw-btn"),
    clearBtn: document.getElementById("clear-btn"),
    projectFiles: document.getElementById("project-files"),
    reloadBtn: document.getElementById("reload-files-btn"),
    selectAllBtn: document.getElementById("select-all-btn"),
    selectNoneBtn: document.getElementById("select-none-btn"),
    drawStationing: document.getElementById("draw-stationing"),
    drawText: document.getElementById("draw-text"),
    stationInterval: document.getElementById("station-interval"),
    ifcList: document.getElementById("ifc-list"),
    ifcMatchCount: document.getElementById("ifc-match-count"),
    version: document.getElementById("version-display")
};

if (els.version) els.version.textContent = VERSION;

function updateStatus(text, tone = "info") {
    els.status.textContent = text;
    els.statusBar.dataset.tone = tone;
}

function setBusy(isBusy) {
    busy = isBusy;
    els.reloadBtn.classList.toggle("is-busy", isBusy);
    els.reloadBtn.disabled = isBusy || !TC_API;
    els.projectFiles.disabled = isBusy || !TC_API;
    els.ifcList?.querySelectorAll("input[type=checkbox]").forEach((cb) => {
        cb.disabled = isBusy || !TC_API;
    });
    syncActionButtons();
}

function syncActionButtons() {
    const hasSelection = els.listItems.querySelectorAll("input:checked").length > 0;
    els.drawBtn.disabled = busy || !TC_API || !hasSelection;
    els.clearBtn.disabled = busy || !TC_API;
}

function authHeaders(token) {
    return {
        Authorization: `Bearer ${token}`,
        Accept: "application/json"
    };
}

async function getAccessToken() {
    const token = await TC_API.extension.requestPermission("accesstoken");
    if (!token || token === "denied" || token === "error") {
        throw new Error("Access token was denied. Check extension permissions.");
    }
    return token;
}

function normalizeLocation(location) {
    if (!location) return "";
    return String(location).trim().toLowerCase().replace(/[\s_]/g, "");
}

function baseUrlForLocation(location) {
    const key = normalizeLocation(location);
    if (!key) return null;
    if (REGION_BASES[key]) return REGION_BASES[key];
    if (REGION_BASES[location]) return REGION_BASES[location];
    // Loose match: "europe", "northamerica", etc.
    for (const [k, url] of Object.entries(REGION_BASES)) {
        if (normalizeLocation(k) === key) return url;
    }
    return null;
}

function getConnectHostBase() {
    const origins = [];
    try {
        if (document.referrer) origins.push(new URL(document.referrer).origin);
    } catch (e) {
        /* ignore */
    }
    if (window.location.ancestorOrigins) {
        for (let i = 0; i < window.location.ancestorOrigins.length; i++) {
            origins.push(window.location.ancestorOrigins[i]);
        }
    }
    for (const origin of origins) {
        try {
            const host = new URL(origin).hostname;
            if (host === "connect.trimble.com" || host.endsWith(".connect.trimble.com")) {
                return `${origin}/tc/api/2.0`;
            }
        } catch (e) {
            /* ignore */
        }
    }
    return null;
}

function isWebConnectHost(base) {
    try {
        const host = new URL(base).hostname.toLowerCase();
        return host === "web.connect.trimble.com" || host === "connect.trimble.com";
    } catch (e) {
        return false;
    }
}

function buildApiBaseCandidates(project) {
    const bases = [];
    // Prefer regional appXX hosts. web.connect.trimble.com rejects CORS from GitHub Pages,
    // so it only produces console noise when tried first (downloads still succeed via fallback).
    const regional = baseUrlForLocation(project?.location);
    if (regional) bases.push(regional);

    for (const base of FALLBACK_BASES) {
        if (!bases.includes(base)) bases.push(base);
    }

    const connectHost = getConnectHostBase();
    if (connectHost && !bases.includes(connectHost) && !isWebConnectHost(connectHost)) {
        bases.push(connectHost);
    }
    return bases;
}

function uniqueBases(bases) {
    return [...new Set(bases.filter(Boolean))];
}

async function tcFetch(path, token, options = {}) {
    const preferred = options.bases && options.bases.length
        ? options.bases
        : apiBaseCandidates.length
          ? apiBaseCandidates
          : [apiBaseUrl];
    const bases = uniqueBases(preferred).filter((base) => !isWebConnectHost(base));
    let lastError = null;

    for (const base of bases) {
        const url = path.startsWith("http") ? path : `${base}${path.startsWith("/") ? path : `/${path}`}`;
        const headers = { Accept: "application/json", ...(options.headers || {}) };
        if (token) headers.Authorization = `Bearer ${token}`;
        if (options.range) headers.Range = options.range;

        try {
            const response = await fetch(url, { method: options.method || "GET", headers });
            if (!response.ok) {
                const body = await response.text().catch(() => "");
                throw new Error(`API ${response.status}: ${body.slice(0, 160) || response.statusText}`);
            }
            if (options.raw) return response;
            const contentType = response.headers.get("content-type") || "";
            if (contentType.includes("json")) return response.json();
            return response.text();
        } catch (err) {
            lastError = err;
            const msg = String(err.message || err);
            if (msg.includes("Failed to fetch") || err.name === "TypeError") continue;
            throw err;
        }
    }

    throw lastError || new Error("Request failed on all API hosts.");
}

async function fetchJson(url, token, range) {
    if (url.startsWith("http")) {
        const headers = authHeaders(token);
        if (range) headers.Range = range;
        const response = await fetch(url, { headers });
        if (!response.ok) {
            const body = await response.text().catch(() => "");
            throw new Error(`API ${response.status}: ${body.slice(0, 160) || response.statusText}`);
        }
        return response.json();
    }
    return tcFetch(url, token, { range });
}

async function resolveApiContext(project) {
    apiBaseCandidates = buildApiBaseCandidates(project);
    const token = await getAccessToken();
    let lastError = null;

    for (const base of apiBaseCandidates) {
        try {
            const data = await tcFetch(`/projects/${project.id}`, token, { bases: [base] });
            const rootId = data.rootId || data.rootFolderId || project.id;
            return { baseUrl: base, rootId, project: data };
        } catch (err) {
            lastError = err;
        }
    }

    for (const base of apiBaseCandidates) {
        try {
            const projects = await tcFetch("/projects", token, { bases: [base], range: "items=0-500" });
            const list = Array.isArray(projects) ? projects : projects.items || [];
            const match = list.find((p) => p.id === project.id);
            if (match) {
                return {
                    baseUrl: base,
                    rootId: match.rootId || match.rootFolderId || project.id,
                    project: match
                };
            }
        } catch (err) {
            lastError = err;
        }
    }

    throw lastError || new Error("Could not resolve project region / root folder.");
}

async function listFolderItems(baseUrl, folderId, token) {
    const items = [];
    let start = 0;
    const page = 500;

    while (true) {
        const end = start + page - 1;
        const chunk = await tcFetch(`/folders/${folderId}/items`, token, {
            bases: [baseUrl],
            range: `items=${start}-${end}`
        });
        const list = Array.isArray(chunk) ? chunk : chunk.items || [];
        items.push(...list);
        if (list.length < page) break;
        start += page;
        if (start > 5000) break;
    }

    return items;
}

function isLandXmlFile(item) {
    if (!item || item.type !== "FILE" || !item.name) return false;
    const name = item.name.toLowerCase();
    return name.endsWith(".xml") || name.endsWith(".landxml");
}

function isIfcFile(item) {
    if (!item || item.type !== "FILE" || !item.name) return false;
    return item.name.toLowerCase().endsWith(".ifc");
}

async function findProjectFiles(baseUrl, rootId, token, filterFn) {
    const found = [];
    const queue = [{ id: rootId, path: "" }];
    let foldersVisited = 0;

    while (queue.length && foldersVisited < MAX_FOLDERS) {
        const { id, path, depth = 0 } = queue.shift();
        foldersVisited += 1;

        let items;
        try {
            items = await listFolderItems(baseUrl, id, token);
        } catch (err) {
            console.warn(`Skipping folder ${id}:`, err);
            continue;
        }

        for (const item of items) {
            if (filterFn(item)) {
                found.push({
                    id: item.id,
                    name: item.name,
                    path: path ? `${path}/${item.name}` : item.name,
                    link: item.link,
                    versionId: item.versionId
                });
            } else if (item.type === "FOLDER" && depth < MAX_FOLDER_DEPTH) {
                queue.push({
                    id: item.id,
                    path: path ? `${path}/${item.name}` : item.name,
                    depth: depth + 1
                });
            }
        }
    }

    found.sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: "base" }));
    return found;
}

async function findLandXmlFiles(baseUrl, rootId, token) {
    return findProjectFiles(baseUrl, rootId, token, isLandXmlFile);
}

async function findIfcFiles(baseUrl, rootId, token) {
    return findProjectFiles(baseUrl, rootId, token, isIfcFile);
}

async function initTC() {
    try {
        const getApi = () =>
            typeof TrimbleConnectWorkspace !== "undefined"
                ? TrimbleConnectWorkspace
                : typeof TrimbleConnectWorkspaceApi !== "undefined"
                  ? TrimbleConnectWorkspaceApi
                  : undefined;

        if (!getApi()) {
            let attempts = 0;
            while (!getApi() && attempts < 50) {
                await new Promise((r) => setTimeout(r, 100));
                attempts += 1;
            }
        }

        const ApiObject = getApi();
        if (!ApiObject) throw new Error("Trimble Connect SDK not loaded.");

        TC_API = await ApiObject.connect(
            window.parent,
            (event, data) => {
                if (event === "extension.fileSelected" && data?.data?.file) {
                    handleConnectFileSelected(data.data.file).catch((err) => {
                        console.error("File selection event failed:", err);
                    });
                }
            },
            30000
        );
        projectInfo = await TC_API.project.getProject();
        updateStatus(`Connected · ${projectInfo.name || "project"}`, "success");
        els.clearBtn.disabled = false;
        await loadProjectFiles();
    } catch (e) {
        console.error("Failed to connect to TC:", e);
        updateStatus(`Connection failed: ${e.message}`, "error");
        els.projectFiles.innerHTML = '<option value="">-- Not connected --</option>';
        els.projectFiles.disabled = true;
        els.reloadBtn.disabled = true;
    }
}

async function loadProjectFiles() {
    if (!TC_API || busy) return;
    setBusy(true);
    updateStatus("Scanning project for LandXML and IFC files…", "info");
    els.projectFiles.innerHTML = '<option value="">Loading…</option>';

    try {
        if (!projectInfo) projectInfo = await TC_API.project.getProject();
        const token = await getAccessToken();
        const ctx = await resolveApiContext(projectInfo);
        apiBaseUrl = ctx.baseUrl;
        apiBaseCandidates = uniqueBases([ctx.baseUrl, ...apiBaseCandidates]);
        projectInfo = { ...projectInfo, ...ctx.project, rootId: ctx.rootId };

        const [files, ifcFiles] = await Promise.all([
            findLandXmlFiles(apiBaseUrl, ctx.rootId, token),
            findIfcFiles(apiBaseUrl, ctx.rootId, token)
        ]);

        fileCatalog = new Map();
        ifcCatalog = new Map();
        selectedIfcIds = new Set([...selectedIfcIds].filter((id) => ifcFiles.some((f) => f.id === id)));

        for (const file of ifcFiles) ifcCatalog.set(file.id, file);
        renderIfcList(ifcFiles);

        if (files.length === 0) {
            els.projectFiles.innerHTML = '<option value="">No LandXML files found</option>';
            updateStatus(
                ifcFiles.length
                    ? `No LandXML files found. ${ifcFiles.length} IFC file${ifcFiles.length === 1 ? "" : "s"} available for naming.`
                    : "No .xml / .landxml files found in this project.",
                "warn"
            );
        } else {
            els.projectFiles.innerHTML = '<option value="">Select a LandXML file…</option>';
            for (const file of files) {
                fileCatalog.set(file.id, file);
                const opt = document.createElement("option");
                opt.value = file.id;
                opt.textContent = file.path;
                opt.title = file.path;
                els.projectFiles.appendChild(opt);
            }
            const ifcPart = ifcFiles.length ? ` · ${ifcFiles.length} IFC` : "";
            updateStatus(`Found ${files.length} LandXML${ifcPart}.`, "success");
        }

        if (alignments.length && selectedIfcIds.size) await refreshAlignmentNames(false);
        else updateIfcMatchCount();
    } catch (e) {
        console.error("Load files error:", e);
        updateStatus(`Could not list files: ${e.message}`, "error");
        els.projectFiles.innerHTML = '<option value="">-- Error loading files --</option>';
        renderIfcList([]);
    } finally {
        setBusy(false);
    }
}

function extractDownloadUrl(data) {
    if (!data) return null;
    if (typeof data === "string" && /^https?:\/\//i.test(data)) return data;
    if (typeof data === "string") return null;
    return data.url || data.downloadUrl || data.link || null;
}

async function fetchFileText(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Download failed (${response.status}).`);
    return response.text();
}

async function resolveDownloadUrl(fileMeta, token) {
    const fileId = fileMeta.id;
    const versionQuery = fileMeta.versionId ? `?versionId=${encodeURIComponent(fileMeta.versionId)}` : "";
    const paths = [
        `/files/fs/${fileId}/downloadurl${versionQuery}`,
        `/files/${fileId}/downloadurl${versionQuery}`,
        `/files/${fileId}/downloadUrl${versionQuery}`
    ];

    if (fileMeta.link && /^https?:\/\//i.test(fileMeta.link)) {
        return fileMeta.link;
    }

    let lastError = null;
    for (const path of paths) {
        try {
            const dlData = await tcFetch(path, token);
            const url = extractDownloadUrl(dlData);
            if (url) return url;
            lastError = new Error("Download URL missing in response.");
        } catch (err) {
            lastError = err;
        }
    }

    try {
        const meta = await tcFetch(`/files/${fileId}`, token);
        const url = extractDownloadUrl(meta);
        if (url) return url;
    } catch (err) {
        lastError = err;
    }

    throw lastError || new Error("Could not resolve download URL.");
}

async function downloadProjectFileText(fileMeta) {
    const token = await getAccessToken();
    const url = await resolveDownloadUrl(fileMeta, token);
    return fetchFileText(url);
}

async function downloadLandXml(fileMeta) {
    return downloadProjectFileText(fileMeta);
}

async function handleConnectFileSelected(file) {
    if (!file?.id) return;
    const meta = {
        id: file.id,
        name: file.name,
        path: file.name,
        link: file.link,
        versionId: file.versionId
    };
    fileCatalog.set(file.id, meta);
    els.projectFiles.value = file.id;
    await loadLandXmlFromProject(meta);
}

async function loadLandXmlFromProject(fileMeta) {
    setBusy(true);
    updateStatus("Downloading LandXML…", "info");
    alignments = [];
    els.listItems.innerHTML = "";
    els.alignmentSection.classList.add("hidden");

    try {
        const xmlText = await downloadLandXml(fileMeta);
        parseLandXML(xmlText);
    } catch (e) {
        console.error("Download error:", e);
        const corsHint =
            String(e.message || "").includes("Failed to fetch")
                ? " Open the extension from Trimble Connect so project files can be accessed."
                : "";
        updateStatus(`Download failed: ${e.message}${corsHint}`, "error");
    } finally {
        setBusy(false);
        syncActionButtons();
    }
}

async function handleFileSelection() {
    const fileId = els.projectFiles.value;
    if (!fileId || !apiBaseUrl) return;
    const fileMeta = fileCatalog.get(fileId) || { id: fileId };
    await loadLandXmlFromProject(fileMeta);
}

function renderIfcList(files) {
    if (!els.ifcList) return;
    if (!files.length) {
        els.ifcList.innerHTML = '<p class="placeholder-text">No IFC files found in this project.</p>';
        return;
    }

    els.ifcList.innerHTML = "";
    for (const file of files) {
        const row = document.createElement("label");
        row.className = "ifc-item check-row";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.value = file.id;
        cb.checked = selectedIfcIds.has(file.id);
        cb.addEventListener("change", () => {
            if (cb.checked) selectedIfcIds.add(file.id);
            else selectedIfcIds.delete(file.id);
            refreshAlignmentNames();
        });
        const span = document.createElement("span");
        span.textContent = file.path;
        span.title = file.path;
        row.appendChild(cb);
        row.appendChild(span);
        els.ifcList.appendChild(row);
    }
}

/** Normalize codes so A10000A, 10000A, Alignment 10000A all share one key. */
function coreAlignmentCode(value) {
    let s = String(value || "")
        .trim()
        .toUpperCase()
        .replace(/^ALIGNMENT[\s:_-]*/, "");
    if (!s) return "";

    // Prefer the station-style token (A10000A / 10000A), even inside longer names
    const token = s.match(/(?:^|[^A-Z0-9])(A?\d{3,}[A-Z]?)(?:[^A-Z0-9]|$)/) || s.match(/(A?\d{3,}[A-Z]?)/);
    if (token) {
        let code = token[1];
        if (/^A\d/.test(code)) code = code.slice(1);
        return code;
    }

    s = s.replace(/[^A-Z0-9]/g, "");
    if (/^A\d/.test(s)) s = s.slice(1);
    return s;
}

function storeAlignmentName(map, codeRaw, label) {
    const name = String(label || "").trim();
    if (!name) return;
    const core = coreAlignmentCode(codeRaw);
    if (!core) return;
    if (!map.has(core)) map.set(core, name);
    // Also keep exact uppercase token for rare non-numeric names
    const exact = String(codeRaw || "")
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "");
    if (exact && !map.has(exact)) map.set(exact, name);
}

function addStationRefMatch(map, raw) {
    const text = String(raw || "").trim();
    if (!text) return;

    let match =
        text.match(/Alignment\s+([A-Za-z0-9_-]+)\s*\(([^)]+)\)/i) ||
        text.match(/\b(A?\d+[A-Za-z]?)\b\s*\(([^)]+)\)/) ||
        text.match(/\b(A?\d+[A-Za-z]?)\b\s*[-–:]\s*(.+)$/);

    if (match) {
        storeAlignmentName(map, match[1], match[2]);
        return;
    }

    // Fallback: "SBG_STATION_REF = Main Road" without code — ignore
}

function parseAlignmentNamesFromIfc(text) {
    const map = new Map();
    const patterns = [
        /Alignment\s+([A-Za-z0-9_-]+)\s*\(([^)]+)\)/gi,
        /\b(A?\d{3,}[A-Za-z]?)\b\s*\(([^)]+)\)/g
    ];

    for (const broad of patterns) {
        let m;
        while ((m = broad.exec(text)) !== null) {
            storeAlignmentName(map, m[1], m[2]);
        }
    }

    // IFC STEP: IFCPROPERTYSINGLEVALUE('SBG_STATION_REF',$,IFCLABEL('...'),$)
    const propPattern =
        /SBG_STATION_REF[\s\S]{0,120}?IFC(?:LABEL|TEXT|IDENTIFIER)\s*\(\s*'([^']+)'\s*\)/gi;
    let m;
    while ((m = propPattern.exec(text)) !== null) addStationRefMatch(map, m[1]);

    const quotedProp = /SBG_STATION_REF[^'"]{0,80}['"]([^'"]+)['"]/gi;
    while ((m = quotedProp.exec(text)) !== null) addStationRefMatch(map, m[1]);

    return map;
}

function resolveAlignmentDisplayName(landXmlName) {
    const core = coreAlignmentCode(landXmlName);
    if (core && alignmentNameMap.has(core)) return alignmentNameMap.get(core);

    const exact = String(landXmlName || "")
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "");
    if (exact && alignmentNameMap.has(exact)) return alignmentNameMap.get(exact);

    // Last resort: one side may still carry a leading A in the map key
    if (core) {
        for (const [key, label] of alignmentNameMap) {
            if (coreAlignmentCode(key) === core) return label;
        }
    }
    return null;
}

function updateIfcMatchCount() {
    if (!els.ifcMatchCount) return;
    if (!alignments.length) {
        els.ifcMatchCount.textContent = alignmentNameMap.size ? `${alignmentNameMap.size} names` : "";
        return;
    }
    let matched = 0;
    for (const align of alignments) {
        if (resolveAlignmentDisplayName(align.name)) matched += 1;
    }
    if (matched) els.ifcMatchCount.textContent = `${matched}/${alignments.length} named`;
    else if (alignmentNameMap.size) els.ifcMatchCount.textContent = `${alignmentNameMap.size} names`;
    else els.ifcMatchCount.textContent = "";
}

async function refreshAlignmentNames(updateStatusBar = true) {
    if (!selectedIfcIds.size) {
        alignmentNameMap = new Map();
        updateIfcMatchCount();
        if (alignments.length) renderAlignmentList();
        return;
    }

    if (updateStatusBar) updateStatus("Reading IFC name sources…", "info");
    try {
        const merged = new Map();
        for (const id of selectedIfcIds) {
            const meta = ifcCatalog.get(id);
            if (!meta) continue;
            try {
                const text = await downloadProjectFileText(meta);
                const map = parseAlignmentNamesFromIfc(text);
                for (const [code, label] of map) {
                    if (!merged.has(code)) merged.set(code, label);
                }
            } catch (err) {
                console.warn(`IFC parse failed for ${meta.path}:`, err);
            }
        }
        alignmentNameMap = merged;
        updateIfcMatchCount();
        if (alignments.length) renderAlignmentList();
        if (updateStatusBar) {
            let matched = 0;
            for (const align of alignments) {
                if (resolveAlignmentDisplayName(align.name)) matched += 1;
            }
            if (alignments.length) {
                updateStatus(
                    `IFC names: ${alignmentNameMap.size} found, ${matched}/${alignments.length} matched.`,
                    matched ? "success" : alignmentNameMap.size ? "warn" : "info"
                );
            } else {
                updateStatus(
                    `Loaded ${alignmentNameMap.size} alignment name${alignmentNameMap.size === 1 ? "" : "s"} from IFC.`,
                    "success"
                );
            }
        }
    } catch (e) {
        console.error("IFC name refresh failed:", e);
        if (updateStatusBar) updateStatus(`Could not read IFC names: ${e.message}`, "error");
    }
}

function buildAlignmentLabelHtml(align) {
    const name = align.name;
    const displayName = resolveAlignmentDisplayName(name);
    const node = align.node;
    const lengthAttr = node.getAttribute("length");
    const staStart = node.getAttribute("staStart");
    const metaParts = [];
    if (staStart != null) metaParts.push(`Start ${formatStation(parseFloat(staStart) || 0)}`);
    if (lengthAttr != null) metaParts.push(`${Number(lengthAttr).toFixed(1)} m`);
    if (align.profile) metaParts.push("profile");

    if (displayName) {
        return `
            <span class="alignment-title">${escapeHtml(displayName)}</span>
            <span class="alignment-code">${escapeHtml(name)}</span>
            ${metaParts.length ? `<span class="alignment-meta">${escapeHtml(metaParts.join(" · "))}</span>` : ""}
        `;
    }
    return `
        ${escapeHtml(name)}
        ${metaParts.length ? `<span class="alignment-meta">${escapeHtml(metaParts.join(" · "))}</span>` : ""}
    `;
}

function renderAlignmentList() {
    const previouslyChecked = new Set(
        Array.from(els.listItems.querySelectorAll("input:checked")).map((cb) => cb.value)
    );
    const hadChecks = els.listItems.querySelectorAll("input[type=checkbox]").length > 0;

    els.listItems.innerHTML = "";
    for (const align of alignments) {
        const div = document.createElement("div");
        div.className = "alignment-item";
        const checked = !hadChecks || previouslyChecked.has(String(align.id));
        div.innerHTML = `
            <input type="checkbox" id="align-${align.id}" value="${align.id}" ${checked ? "checked" : ""}>
            <label for="align-${align.id}">${buildAlignmentLabelHtml(align)}</label>
        `;
        els.listItems.appendChild(div);
    }
    els.alignmentCount.textContent = `(${alignments.length})`;
    els.alignmentSection.classList.toggle("hidden", alignments.length === 0);
    syncActionButtons();
}

function localName(node) {
    return (node.localName || node.tagName || "").replace(/^.*:/, "");
}

function childrenByName(parent, name) {
    return Array.from(parent.children || []).filter((c) => localName(c) === name);
}

function firstByName(parent, name) {
    return childrenByName(parent, name)[0] || null;
}

function findProfileForAlignment(alignNode, alignName, xmlDoc) {
    const nested = childrenByName(alignNode, "Profile");
    if (nested.length) return nested[0];

    const all = xmlDoc.getElementsByTagNameNS("*", "Profile");
    for (let i = 0; i < all.length; i++) {
        if (all[i].getAttribute("name") === alignName) return all[i];
    }
    return null;
}

function parseLandXML(xmlText) {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlText, "text/xml");
    const parseError = xmlDoc.querySelector("parsererror");
    if (parseError) {
        updateStatus("Invalid XML file.", "error");
        return;
    }

    const alignmentNodes = xmlDoc.getElementsByTagNameNS("*", "Alignment");
    alignments = [];
    els.listItems.innerHTML = "";

    if (alignmentNodes.length === 0) {
        updateStatus("No <Alignment> elements found in this file.", "warn");
        els.alignmentSection.classList.add("hidden");
        updateIfcMatchCount();
        syncActionButtons();
        return;
    }

    for (let i = 0; i < alignmentNodes.length; i++) {
        const node = alignmentNodes[i];
        const name = node.getAttribute("name") || `Alignment ${i + 1}`;
        const profile = findProfileForAlignment(node, name, xmlDoc);

        alignments.push({ id: i, name, node, profile });
    }

    renderAlignmentList();
    updateIfcMatchCount();
    if (selectedIfcIds.size) refreshAlignmentNames(false);
    updateStatus(`Loaded ${alignments.length} alignment${alignments.length === 1 ? "" : "s"}.`, "success");
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function setAllChecks(checked) {
    els.listItems.querySelectorAll("input[type=checkbox]").forEach((cb) => {
        cb.checked = checked;
    });
    syncActionButtons();
}

async function clearMarkups() {
    if (!TC_API || !TC_API.markup) return;
    setBusy(true);
    try {
        await clearMarkupsInternal();
        updateStatus("Viewer markups cleared.", "success");
    } catch (e) {
        console.error("Clear failed:", e);
        activeMarkupIds = [];
        updateStatus(`Clear failed: ${e.message}`, "error");
    } finally {
        setBusy(false);
    }
}

async function drawSelectedAlignments() {
    const selectedIds = Array.from(els.listItems.querySelectorAll("input:checked")).map((cb) =>
        parseInt(cb.value, 10)
    );
    if (selectedIds.length === 0) {
        updateStatus("Select at least one alignment.", "warn");
        return;
    }

    const settings = {
        drawSta: els.drawStationing.checked,
        drawText: els.drawText.checked,
        interval: Math.max(1, parseFloat(els.stationInterval.value) || 100),
        swap: SWAP_NE
    };

    if (!settings.drawSta && !settings.drawText) {
        updateStatus("Enable station ticks or labels.", "warn");
        return;
    }

    setBusy(true);
    updateStatus("Clearing previous markups…", "info");
    try {
        try {
            await clearMarkupsInternal();
        } catch (e) {
            console.warn("Pre-draw clear warning:", e);
            activeMarkupIds = [];
        }
        await new Promise((r) => setTimeout(r, 150));

        updateStatus("Building geometry…", "info");
        const lines = [];
        const texts = [];
        for (const id of selectedIds) {
            const geom = processAlignment(alignments[id], settings);
            lines.push(...geom.lines);
            texts.push(...geom.texts);
        }

        if (lines.length === 0 && texts.length === 0) {
            updateStatus("No drawable geometry found for the selection.", "warn");
            return;
        }

        updateStatus(`Drawing ${lines.length} lines, ${texts.length} labels…`, "info");
        await addMarkups(lines, texts);
        updateStatus(
            `Applied stationing to ${selectedIds.length} alignment${selectedIds.length === 1 ? "" : "s"} (${texts.length} labels).`,
            "success"
        );
    } catch (e) {
        console.error("Draw failed:", e);
        updateStatus(`Draw failed: ${e.message}`, "error");
    } finally {
        setBusy(false);
    }
}

async function clearMarkupsInternal() {
    if (!TC_API?.markup) return;
    const removeFn = TC_API.markup.removeMarkups || TC_API.markup.removeLineMarkups;
    if (!removeFn) throw new Error("Clear is not supported by this viewer API.");

    if (activeMarkupIds.length > 0) {
        for (let i = 0; i < activeMarkupIds.length; i += 100) {
            await removeFn.call(TC_API.markup, activeMarkupIds.slice(i, i + 100));
        }
    } else if (TC_API.markup.removeMarkups) {
        // Ids were lost — clear all viewer markups as a fallback
        await TC_API.markup.removeMarkups(undefined);
    }
    activeMarkupIds = [];
}

async function addMarkups(lines, texts) {
    const addBatch = async (items, singular, plural) => {
        for (let i = 0; i < items.length; i += BATCH) {
            const batch = items.slice(i, i + BATCH);
            let res;
            if (typeof plural === "function") {
                res = await plural.call(TC_API.markup, batch);
            } else if (typeof singular === "function") {
                res = [];
                for (const item of batch) {
                    const one = await singular.call(TC_API.markup, item);
                    if (Array.isArray(one)) res.push(...one);
                    else if (one) res.push(one);
                }
            }
            if (Array.isArray(res)) {
                res.forEach((r) => activeMarkupIds.push(r.id ?? r.markupId ?? r));
            } else if (res) {
                activeMarkupIds.push(res.id ?? res.markupId ?? res);
            }
        }
    };

    await addBatch(lines, TC_API.markup.addLineMarkup, TC_API.markup.addLineMarkups);
    // Workspace API documents addTextMarkup taking an array
    await addBatch(texts, null, TC_API.markup.addTextMarkup || TC_API.markup.addTextMarkups);
}

function formatStation(s) {
    if (!isFinite(s)) return "0+000";
    const sign = s < 0 ? "-" : "";
    const abs = Math.abs(s);
    const km = Math.floor(abs / 1000);
    const meters = abs - km * 1000;
    const whole = Math.floor(meters);
    const frac = Math.round((meters - whole) * 1000);
    const base = `${km}+${String(whole).padStart(3, "0")}`;
    return sign + (frac ? `${base}.${String(frac).padStart(3, "0")}` : base);
}

function parseCoord(str, swap) {
    if (!str) return null;
    const pts = str.trim().split(/\s+/);
    if (pts.length < 2) return null;
    const a = parseFloat(pts[0]);
    const b = parseFloat(pts[1]);
    if (!isFinite(a) || !isFinite(b)) return null;
    return swap ? { x: b, y: a } : { x: a, y: b };
}

function dist(p1, p2) {
    return Math.hypot(p1.x - p2.x, p1.y - p2.y);
}

function interpolate(pts, s) {
    if (!pts.length) return null;
    if (s <= pts[0].sta + 0.001) return pts[0];
    if (s >= pts[pts.length - 1].sta - 0.001) return pts[pts.length - 1];
    for (let i = 0; i < pts.length - 1; i++) {
        if (s >= pts[i].sta && s <= pts[i + 1].sta) {
            const span = pts[i + 1].sta - pts[i].sta || 1;
            const t = (s - pts[i].sta) / span;
            return {
                x: pts[i].x + t * (pts[i + 1].x - pts[i].x),
                y: pts[i].y + t * (pts[i + 1].y - pts[i].y)
            };
        }
    }
    return null;
}

function sampleArc(center, start, end, radius, rot, sta, len, points) {
    const segs = Math.max(2, Math.ceil(Math.abs(len) / 10));
    let sA = Math.atan2(start.y - center.y, start.x - center.x);
    let eA = Math.atan2(end.y - center.y, end.x - center.x);
    if (rot === "cw" && eA > sA) eA -= 2 * Math.PI;
    if (rot === "ccw" && eA < sA) eA += 2 * Math.PI;
    // If rotation unknown, pick the shorter arc
    if (rot !== "cw" && rot !== "ccw") {
        let d = eA - sA;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        eA = sA + d;
    }
    const rad = isFinite(radius) && radius > 0 ? radius : dist(center, start);
    for (let i = 0; i <= segs; i++) {
        const t = i / segs;
        const a = sA + t * (eA - sA);
        points.push({
            x: center.x + rad * Math.cos(a),
            y: center.y + rad * Math.sin(a),
            sta: sta + t * len
        });
    }
}

function sampleSpiral(start, end, center, radiusStart, radiusEnd, rot, sta, len, points) {
    // Clothoid-lite: interpolate curvature and walk the tangent
    const segs = Math.max(4, Math.ceil(Math.abs(len) / 5));
    const k0 = radiusStart > 0 ? 1 / radiusStart : 0;
    const k1 = radiusEnd > 0 ? 1 / radiusEnd : 0;
    const dir = rot === "cw" ? -1 : 1;

    // Initial heading from start toward PI/end if available
    let heading = Math.atan2(end.y - start.y, end.x - start.x);
    if (center) {
        const radial = Math.atan2(start.y - center.y, start.x - center.x);
        heading = radial + (dir > 0 ? Math.PI / 2 : -Math.PI / 2);
    }

    let x = start.x;
    let y = start.y;
    points.push({ x, y, sta });
    const ds = len / segs;
    for (let i = 1; i <= segs; i++) {
        const t0 = (i - 1) / segs;
        const k = k0 + (k1 - k0) * t0;
        heading += dir * k * ds;
        x += Math.cos(heading) * ds;
        y += Math.sin(heading) * ds;
        points.push({ x, y, sta: sta + i * ds });
    }

    // Soft snap end toward published End coordinate
    const last = points[points.length - 1];
    if (end && dist(last, end) > 0.05) {
        points[points.length - 1] = { x: end.x, y: end.y, sta: sta + len };
    }
}

function collectGeomPoints(align, swap) {
    const points = [];
    const cg =
        firstByName(align.node, "CoordGeom") ||
        align.node.getElementsByTagNameNS("*", "CoordGeom")[0];
    if (!cg) return points;

    for (const child of Array.from(cg.children)) {
        const tag = localName(child);
        const sta = parseFloat(child.getAttribute("staStart")) || (points.length ? points[points.length - 1].sta : 0);
        const len = parseFloat(child.getAttribute("length")) || 0;
        const rot = (child.getAttribute("rot") || "").toLowerCase();

        if (tag === "Line") {
            const s = parseCoord(firstByName(child, "Start")?.textContent, swap);
            const e = parseCoord(firstByName(child, "End")?.textContent, swap);
            if (s && e) {
                points.push({ ...s, sta });
                points.push({ ...e, sta: sta + (len || dist(s, e)) });
            }
        } else if (tag === "Curve") {
            const s = parseCoord(firstByName(child, "Start")?.textContent, swap);
            const c = parseCoord(firstByName(child, "Center")?.textContent, swap);
            const e = parseCoord(firstByName(child, "End")?.textContent, swap);
            const rad = parseFloat(child.getAttribute("radius"));
            if (s && c && e) sampleArc(c, s, e, rad, rot, sta, len || 0, points);
            else if (s && e) {
                points.push({ ...s, sta });
                points.push({ ...e, sta: sta + (len || dist(s, e)) });
            }
        } else if (tag === "Spiral") {
            const s = parseCoord(firstByName(child, "Start")?.textContent, swap);
            const e = parseCoord(firstByName(child, "End")?.textContent, swap);
            const c = parseCoord(firstByName(child, "Center")?.textContent, swap);
            const r0 = parseFloat(child.getAttribute("radiusStart"));
            const r1 = parseFloat(child.getAttribute("radiusEnd"));
            if (s && e) sampleSpiral(s, e, c, r0, r1, rot, sta, len || dist(s, e), points);
        } else if (tag === "IrregularLine") {
            const start = parseCoord(firstByName(child, "Start")?.textContent, swap);
            const end = parseCoord(firstByName(child, "End")?.textContent, swap);
            const pntList =
                firstByName(child, "PntList2D") ||
                firstByName(child, "PntList3D") ||
                child.getElementsByTagNameNS("*", "PntList2D")[0] ||
                child.getElementsByTagNameNS("*", "PntList3D")[0];
            const pts = [];
            if (start) pts.push(start);
            if (pntList?.textContent) {
                const nums = pntList.textContent.trim().split(/\s+/).map(Number);
                const is3d = localName(pntList) === "PntList3D";
                const stride = is3d ? 3 : 2;
                for (let i = 0; i + 1 < nums.length; i += stride) {
                    const raw = is3d
                        ? `${nums[i]} ${nums[i + 1]}`
                        : `${nums[i]} ${nums[i + 1]}`;
                    const p = parseCoord(raw, swap);
                    if (p) pts.push(p);
                }
            }
            if (end) pts.push(end);
            if (pts.length) {
                const total = pts.reduce((acc, p, i) => (i ? acc + dist(pts[i - 1], p) : 0), 0) || len || 1;
                let traveled = 0;
                pts.forEach((p, i) => {
                    if (i) traveled += dist(pts[i - 1], p);
                    points.push({ ...p, sta: sta + (traveled / total) * (len || total) });
                });
            }
        }
    }

    return points;
}

function extractPvis(profile) {
    const pvis = [];
    if (!profile) return pvis;

    const pviNodes = profile.getElementsByTagNameNS("*", "PVI");
    for (let i = 0; i < pviNodes.length; i++) {
        const text = pviNodes[i].textContent.trim().split(/\s+/);
        if (text.length >= 2) {
            const sta = parseFloat(text[0]);
            const elev = parseFloat(text[1]);
            if (isFinite(sta) && isFinite(elev)) pvis.push({ sta, elev });
        }
    }

    // Some files use CircCurve / ParaCurve with attributes
    if (!pvis.length) {
        const candidates = profile.getElementsByTagNameNS("*", "*");
        for (let i = 0; i < candidates.length; i++) {
            const n = candidates[i];
            const tag = localName(n);
            if (tag !== "CircCurve" && tag !== "ParaCurve" && tag !== "PVI") continue;
            const sta = parseFloat(n.getAttribute("sta") || n.getAttribute("station"));
            const elev = parseFloat(n.getAttribute("elev") || n.getAttribute("elevation"));
            if (isFinite(sta) && isFinite(elev)) pvis.push({ sta, elev });
        }
    }

    pvis.sort((a, b) => a.sta - b.sta);
    return pvis;
}

function makeElevFn(pvis) {
    return (s) => {
        if (!pvis.length) return 0;
        if (s <= pvis[0].sta) return pvis[0].elev;
        if (s >= pvis[pvis.length - 1].sta) return pvis[pvis.length - 1].elev;
        for (let i = 0; i < pvis.length - 1; i++) {
            if (s >= pvis[i].sta && s <= pvis[i + 1].sta) {
                const t = (s - pvis[i].sta) / (pvis[i + 1].sta - pvis[i].sta || 1);
                return pvis[i].elev + t * (pvis[i + 1].elev - pvis[i].elev);
            }
        }
        return 0;
    };
}

function processAlignment(align, settings) {
    const lines = [];
    const texts = [];
    const points = collectGeomPoints(align, settings.swap);
    if (points.length < 2) return { lines, texts };

    const getEl = makeElevFn(extractPvis(align.profile));

    if (settings.drawSta || settings.drawText) {
        const sSta = points[0].sta || 0;
        const eSta = points[points.length - 1].sta || 0;
        const stations = [sSta];
        const startTick = Math.ceil((sSta + 0.001) / settings.interval) * settings.interval;
        for (let s = startTick; s < eSta - 0.001; s += settings.interval) stations.push(s);
        if (eSta > sSta + 0.01) stations.push(eSta);

        for (const s of stations) {
            const p = interpolate(points, s);
            if (!p) continue;
            const el = getEl(s);
            const pos = { positionX: p.x * MM, positionY: p.y * MM, positionZ: el * MM };
            const isEnd = s === sSta || s === eSta;
            const color = isEnd
                ? { r: 255, g: 120, b: 0, a: 1 }
                : { r: 0, g: 200, b: 220, a: 1 };

            if (settings.drawText) {
                const label = isEnd
                    ? s === sSta
                        ? `START ${formatStation(s)}`
                        : `END ${formatStation(s)}`
                    : formatStation(s);
                texts.push({
                    id: idCounter++,
                    text: label,
                    color,
                    start: pos,
                    end: { ...pos, positionZ: (el + 1.5) * MM }
                });
            }

            if (settings.drawSta) {
                const pN = interpolate(points, s + 0.1) || interpolate(points, s - 0.1);
                if (pN) {
                    const dx = pN.x - p.x;
                    const dy = pN.y - p.y;
                    const l = Math.hypot(dx, dy);
                    if (l > 0.0001) {
                        const nx = -dy / l;
                        const ny = dx / l;
                        const tL = isEnd ? 1.5 : 0.8;
                        lines.push({
                            id: idCounter++,
                            color,
                            start: {
                                positionX: (p.x - nx * tL) * MM,
                                positionY: (p.y - ny * tL) * MM,
                                positionZ: el * MM
                            },
                            end: {
                                positionX: (p.x + nx * tL) * MM,
                                positionY: (p.y + ny * tL) * MM,
                                positionZ: el * MM
                            }
                        });
                    }
                }
            }
        }
    }

    return { lines, texts };
}

// Events
els.reloadBtn.addEventListener("click", loadProjectFiles);
els.projectFiles.addEventListener("change", handleFileSelection);
els.drawBtn.addEventListener("click", drawSelectedAlignments);
els.clearBtn.addEventListener("click", clearMarkups);
els.selectAllBtn.addEventListener("click", () => setAllChecks(true));
els.selectNoneBtn.addEventListener("click", () => setAllChecks(false));
els.listItems.addEventListener("change", syncActionButtons);

initTC();
