/**
 * LandXML Alignment Visualizer for Trimble Connect
 * Direction: region-aware file loading, recursive discovery, correct profiles,
 * optional N/E swap, Trimble-native panel; Power BI tab removed.
 */
const VERSION = "v1.1.0";
console.log(`Alignment Visualizer ${VERSION} loaded.`);

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

let TC_API = null;
let apiBaseUrl = null;
let projectInfo = null;
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
    drawAlignments: document.getElementById("draw-alignments"),
    drawStationing: document.getElementById("draw-stationing"),
    drawText: document.getElementById("draw-text"),
    swapNE: document.getElementById("swap-ne"),
    stationInterval: document.getElementById("station-interval"),
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

async function fetchJson(url, token, range) {
    const headers = authHeaders(token);
    if (range) headers.Range = range;
    const response = await fetch(url, { headers });
    if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`API ${response.status}: ${body.slice(0, 160) || response.statusText}`);
    }
    return response.json();
}

async function resolveApiContext(project) {
    const preferred = baseUrlForLocation(project.location);
    const candidates = preferred
        ? [preferred, ...FALLBACK_BASES.filter((u) => u !== preferred)]
        : [...FALLBACK_BASES];

    const token = await getAccessToken();
    let lastError = null;

    for (const base of candidates) {
        try {
            const data = await fetchJson(`${base}/projects/${project.id}`, token);
            const rootId = data.rootId || data.rootFolderId || project.id;
            return { baseUrl: base, rootId, project: data };
        } catch (err) {
            lastError = err;
        }
    }

    // Last resort: list projects on each region and match by id
    for (const base of candidates) {
        try {
            const projects = await fetchJson(`${base}/projects`, token, "items=0-500");
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
        const chunk = await fetchJson(
            `${baseUrl}/folders/${folderId}/items`,
            token,
            `items=${start}-${end}`
        );
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

async function findLandXmlFiles(baseUrl, rootId, token) {
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
            if (isLandXmlFile(item)) {
                found.push({
                    id: item.id,
                    name: item.name,
                    path: path ? `${path}/${item.name}` : item.name
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

        TC_API = await ApiObject.connect(window.parent, () => {}, 30000);
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
    updateStatus("Scanning project for LandXML files…", "info");
    els.projectFiles.innerHTML = '<option value="">Loading…</option>';

    try {
        if (!projectInfo) projectInfo = await TC_API.project.getProject();
        const token = await getAccessToken();
        const ctx = await resolveApiContext(projectInfo);
        apiBaseUrl = ctx.baseUrl;
        projectInfo = { ...projectInfo, ...ctx.project, rootId: ctx.rootId };

        const files = await findLandXmlFiles(apiBaseUrl, ctx.rootId, token);
        if (files.length === 0) {
            els.projectFiles.innerHTML = '<option value="">No LandXML files found</option>';
            updateStatus("No .xml / .landxml files found in this project.", "warn");
        } else {
            els.projectFiles.innerHTML = '<option value="">Select a LandXML file…</option>';
            for (const file of files) {
                const opt = document.createElement("option");
                opt.value = file.id;
                opt.textContent = file.path;
                opt.title = file.path;
                els.projectFiles.appendChild(opt);
            }
            updateStatus(`Found ${files.length} LandXML file${files.length === 1 ? "" : "s"}.`, "success");
        }
    } catch (e) {
        console.error("Load files error:", e);
        updateStatus(`Could not list files: ${e.message}`, "error");
        els.projectFiles.innerHTML = '<option value="">-- Error loading files --</option>';
    } finally {
        setBusy(false);
    }
}

async function resolveDownloadUrl(fileId, token) {
    const endpoints = [
        `${apiBaseUrl}/files/${fileId}/downloadUrl`,
        `${apiBaseUrl}/files/${fileId}/downloadurl`
    ];
    let lastError = null;
    for (const endpoint of endpoints) {
        try {
            const dlData = await fetchJson(endpoint, token);
            const url = typeof dlData === "string" ? dlData : dlData.url || dlData.downloadUrl;
            if (url) return url;
            lastError = new Error("Download URL missing in response.");
        } catch (err) {
            lastError = err;
        }
    }
    throw lastError || new Error("Could not resolve download URL.");
}

async function handleFileSelection() {
    const fileId = els.projectFiles.value;
    if (!fileId || !apiBaseUrl) return;

    setBusy(true);
    updateStatus("Downloading LandXML…", "info");
    alignments = [];
    els.listItems.innerHTML = "";
    els.alignmentSection.classList.add("hidden");

    try {
        const token = await getAccessToken();
        const url = await resolveDownloadUrl(fileId, token);
        const contentResponse = await fetch(url);
        if (!contentResponse.ok) throw new Error(`Download failed (${contentResponse.status}).`);
        parseLandXML(await contentResponse.text());
    } catch (e) {
        console.error("Download error:", e);
        updateStatus(`Download failed: ${e.message}`, "error");
    } finally {
        setBusy(false);
        syncActionButtons();
    }
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
        syncActionButtons();
        return;
    }

    for (let i = 0; i < alignmentNodes.length; i++) {
        const node = alignmentNodes[i];
        const name = node.getAttribute("name") || `Alignment ${i + 1}`;
        const profile = findProfileForAlignment(node, name, xmlDoc);
        const lengthAttr = node.getAttribute("length");
        const staStart = node.getAttribute("staStart");

        alignments.push({ id: i, name, node, profile });

        const div = document.createElement("div");
        div.className = "alignment-item";
        const metaParts = [];
        if (staStart != null) metaParts.push(`Start ${formatStation(parseFloat(staStart) || 0)}`);
        if (lengthAttr != null) metaParts.push(`${Number(lengthAttr).toFixed(1)} m`);
        if (profile) metaParts.push("profile");

        div.innerHTML = `
            <input type="checkbox" id="align-${i}" value="${i}" checked>
            <label for="align-${i}">
                ${escapeHtml(name)}
                ${metaParts.length ? `<span class="alignment-meta">${escapeHtml(metaParts.join(" · "))}</span>` : ""}
            </label>
        `;
        els.listItems.appendChild(div);
    }

    els.alignmentCount.textContent = `(${alignments.length})`;
    els.alignmentSection.classList.remove("hidden");
    updateStatus(`Loaded ${alignments.length} alignment${alignments.length === 1 ? "" : "s"}.`, "success");
    syncActionButtons();
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
        drawAlign: els.drawAlignments.checked,
        drawSta: els.drawStationing.checked,
        drawText: els.drawText.checked,
        interval: Math.max(1, parseFloat(els.stationInterval.value) || 100),
        swap: els.swapNE.checked
    };

    if (!settings.drawAlign && !settings.drawSta && !settings.drawText) {
        updateStatus("Enable at least one display option.", "warn");
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
            `Drawn ${selectedIds.length} alignment${selectedIds.length === 1 ? "" : "s"} (${lines.length} segments).`,
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

    if (settings.drawAlign) {
        for (let i = 0; i < points.length - 1; i++) {
            const p1 = points[i];
            const p2 = points[i + 1];
            if (dist(p1, p2) < 0.001) continue;
            lines.push({
                id: idCounter++,
                color: { r: 255, g: 214, b: 0, a: 1 },
                start: {
                    positionX: p1.x * MM,
                    positionY: p1.y * MM,
                    positionZ: getEl(p1.sta) * MM
                },
                end: {
                    positionX: p2.x * MM,
                    positionY: p2.y * MM,
                    positionZ: getEl(p2.sta) * MM
                }
            });
        }
    }

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
