/**
 * LandXML Alignment Visualizer for Trimble Connect
 */

let TC_API = null;
let alignments = [];
let allProjectFiles = [];
let activeMarkupIds = JSON.parse(sessionStorage.getItem('tc_markup_ids') || '[]'); 
let idCounter = Date.now(); 

// UI Elements
const statusText = document.getElementById('status');
const alignmentList = document.getElementById('alignment-list');
const listItems = document.getElementById('list-items');
const drawBtn = document.getElementById('draw-btn');
const clearBtn = document.getElementById('clear-btn');
const projectFilesDropdown = document.getElementById('project-files');
const reloadFilesBtn = document.getElementById('reload-files-btn');
const fileSearchInput = document.getElementById('file-search');
const selectAllBtn = document.getElementById('select-all');
const selectNoneBtn = document.getElementById('select-none');

const drawAlignmentsCheck = document.getElementById('draw-alignments');
const drawStationingCheck = document.getElementById('draw-stationing');
const drawTextCheck = document.getElementById('draw-text');
const zoomToSelectionCheck = document.getElementById('zoom-to-selection');
const stationIntervalInput = document.getElementById('station-interval');

// Initialize
async function initTC() {
    loadSettings();
    try {
        const getApi = () => (typeof TrimbleConnectWorkspace !== 'undefined' ? TrimbleConnectWorkspace : 
                             (typeof TrimbleConnectWorkspaceApi !== 'undefined' ? TrimbleConnectWorkspaceApi : undefined));
        if (!getApi()) {
            let attempts = 0;
            while (!getApi() && attempts < 50) { await new Promise(r => setTimeout(r, 100)); attempts++; }
        }
        const ApiObject = getApi();
        if (!ApiObject) throw new Error("SDK not loaded.");
        TC_API = await ApiObject.connect(window.parent, (event, data) => {}, 30000);
        updateStatus("Connected to Trimble Connect.");
        await loadProjectFiles();
    } catch (e) {
        updateStatus("Error: " + e.message);
    }
}

// Event Listeners
reloadFilesBtn.addEventListener('click', loadProjectFiles);
projectFilesDropdown.addEventListener('change', handleFileSelection);
fileSearchInput.addEventListener('input', filterFiles);
drawBtn.addEventListener('click', async () => {
    saveSettings();
    updateStatus("Preparing viewer...");
    await clearMarkups();
    await new Promise(r => setTimeout(r, 200)); 
    await drawSelectedAlignments();
});
clearBtn.addEventListener('click', clearMarkups);
selectAllBtn.addEventListener('click', () => toggleCheckboxes(true));
selectNoneBtn.addEventListener('click', () => toggleCheckboxes(false));

function updateStatus(text) { statusText.innerText = text; }

function toggleCheckboxes(state) {
    const cbs = listItems.querySelectorAll('input[type="checkbox"]');
    cbs.forEach(cb => cb.checked = state);
}

function saveSettings() {
    localStorage.setItem('tc_alignment_settings', JSON.stringify({
        align: drawAlignmentsCheck.checked,
        sta: drawStationingCheck.checked,
        text: drawTextCheck.checked,
        zoom: zoomToSelectionCheck.checked,
        interval: stationIntervalInput.value
    }));
}

function loadSettings() {
    const saved = localStorage.getItem('tc_alignment_settings');
    if (saved) {
        const s = JSON.parse(saved);
        drawAlignmentsCheck.checked = s.align;
        drawStationingCheck.checked = s.sta;
        drawTextCheck.checked = s.text;
        zoomToSelectionCheck.checked = s.zoom !== undefined ? s.zoom : true;
        stationIntervalInput.value = s.interval;
    }
}

async function loadProjectFiles() {
    if (!TC_API) return;
    updateStatus("Scanning project...");
    projectFilesDropdown.innerHTML = '<option value="">-- Scanning... --</option>';
    try {
        const projectMetadata = await TC_API.project.getCurrentProject();
        const token = await TC_API.extension.requestPermission("accesstoken");
        let baseUrl = "https://app.connect.trimble.com/tc/api/2.0";
        if (projectMetadata.location.includes("europe")) baseUrl = "https://app21.connect.trimble.com/tc/api/2.0";
        else if (projectMetadata.location.includes("asia")) baseUrl = "https://app31.connect.trimble.com/tc/api/2.0";

        const projRes = await fetch(`${baseUrl}/projects/${projectMetadata.id}`, { headers: { 'Authorization': `Bearer ${token}` } });
        const projectDetails = await projRes.json();
        const rootFolderId = projectDetails.rootFolderId || projectMetadata.id;

        allProjectFiles = [];
        const foldersToScan = [rootFolderId];
        let scannedCount = 0;
        while (foldersToScan.length > 0 && scannedCount < 100) {
            const folderId = foldersToScan.shift();
            updateStatus(`Scanning (${allProjectFiles.length} files found)...`);
            const res = await fetch(`${baseUrl}/folders/${folderId}/items`, { headers: { 'Authorization': `Bearer ${token}` } });
            if (res.ok) {
                (await res.json()).forEach(item => {
                    if (item.type === 'FILE' && (item.name.toLowerCase().endsWith('.xml') || item.name.toLowerCase().endsWith('.landxml'))) allProjectFiles.push({ ...item, baseUrl });
                    else if (item.type === 'FOLDER') foldersToScan.push(item.id);
                });
            }
            scannedCount++;
        }
        renderFileDropdown(allProjectFiles);
        updateStatus(`Found ${allProjectFiles.length} LandXML files.`);
    } catch (e) { updateStatus("Error loading files."); }
}

function renderFileDropdown(files) {
    projectFilesDropdown.innerHTML = '<option value="">-- Select LandXML --</option>';
    files.forEach(file => {
        const opt = document.createElement('option');
        opt.value = file.id; opt.textContent = file.name; opt.dataset.baseUrl = file.baseUrl;
        projectFilesDropdown.appendChild(opt);
    });
}

function filterFiles() {
    const q = fileSearchInput.value.toLowerCase();
    renderFileDropdown(allProjectFiles.filter(f => f.name.toLowerCase().includes(q)));
}

async function handleFileSelection() {
    const fileId = projectFilesDropdown.value;
    if (!fileId) return;
    const selectedOption = projectFilesDropdown.selectedOptions[0];
    updateStatus(`Opening ${selectedOption.textContent}...`);
    try {
        const token = await TC_API.extension.requestPermission("accesstoken");
        const dlRes = await fetch(`${selectedOption.dataset.baseUrl}/files/${fileId}/downloadUrl`, { headers: { 'Authorization': `Bearer ${token}` } });
        const dlData = await dlRes.json();
        const xmlText = await (await fetch(dlData.url)).text();
        parseLandXML(xmlText, selectedOption.textContent);
    } catch (e) { updateStatus("Error opening file."); }
}

function parseLandXML(xmlText, fileName) {
    const xmlDoc = new DOMParser().parseFromString(xmlText, "text/xml");
    const nodes = xmlDoc.getElementsByTagName('Alignment');
    if (nodes.length === 0) { updateStatus("No alignments in " + fileName); return; }
    for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i], name = node.getAttribute('name') || `Alignment ${i+1}`;
        let len = 0, cGeom = node.getElementsByTagName('CoordGeom')[0];
        if (cGeom) Array.from(cGeom.children).forEach(c => len += parseFloat(c.getAttribute('length')) || 0);
        const alignment = { id: alignments.length, name: `${name} (${fileName})`, node, length: len, profile: null };
        const profiles = xmlDoc.getElementsByTagName('Profile');
        for (let j = 0; j < profiles.length; j++) { if (profiles[j].getAttribute('name') === name) { alignment.profile = profiles[j]; break; } }
        alignments.push(alignment);
        const div = document.createElement('div');
        div.className = 'alignment-item';
        div.innerHTML = `<input type="checkbox" id="align-${alignment.id}" value="${alignment.id}" checked><label for="align-${alignment.id}">${alignment.name} <span class="meta">${len.toFixed(0)}m</span></label>`;
        listItems.appendChild(div);
    }
    alignmentList.classList.remove('hidden');
    updateStatus(`Alignments: ${alignments.length}`);
}

async function clearMarkups() {
    if (!TC_API || !TC_API.markup || activeMarkupIds.length === 0) return;
    updateStatus("Clearing viewer...");
    try {
        const batchSize = 100, removeFn = TC_API.markup.removeMarkups || TC_API.markup.removeLineMarkups;
        for (let i = 0; i < activeMarkupIds.length; i += batchSize) {
            const batch = activeMarkupIds.slice(i, i + batchSize);
            if (removeFn) await removeFn.call(TC_API.markup, batch);
        }
        activeMarkupIds = []; sessionStorage.removeItem('tc_markup_ids');
        updateStatus("Viewer cleared.");
    } catch (e) { activeMarkupIds = []; }
}

async function drawSelectedAlignments() {
    if (!TC_API) return;
    const selectedIds = Array.from(listItems.querySelectorAll('input:checked')).map(cb => parseInt(cb.value));
    if (selectedIds.length === 0) { alert("Select an alignment."); return; }
    const settings = {
        drawAlign: drawAlignmentsCheck.checked, drawSta: drawStationingCheck.checked, drawText: drawTextCheck.checked,
        interval: parseFloat(stationIntervalInput.value) || 100, swap: true 
    };
    updateStatus("Generating geometry...");
    const lineMarkups = [], textMarkups = [];
    let minP = {x:Infinity, y:Infinity, z:Infinity}, maxP = {x:-Infinity, y:-Infinity, z:-Infinity};
    for (const id of selectedIds) {
        const geom = processAlignment(alignments[id], settings);
        lineMarkups.push(...geom.lines); textMarkups.push(...geom.texts);
        geom.lines.forEach(l => [l.start, l.end].forEach(p => {
            minP.x = Math.min(minP.x, p.positionX); maxP.x = Math.max(maxP.x, p.positionX);
            minP.y = Math.min(minP.y, p.positionY); maxP.y = Math.max(maxP.y, p.positionY);
            minP.z = Math.min(minP.z, p.positionZ); maxP.z = Math.max(maxP.z, p.positionZ);
        }));
    }
    updateStatus(`Drawing ${lineMarkups.length + textMarkups.length} elements...`);
    try {
        const batchSize = 50;
        const addItems = async (items, singularFn, pluralFn) => {
            for (let i = 0; i < items.length; i += batchSize) {
                const batch = items.slice(i, i + batchSize);
                if (pluralFn) await pluralFn.call(TC_API.markup, batch);
                else { for (const item of batch) await singularFn.call(TC_API.markup, item); }
                batch.forEach(item => { if (item.id) activeMarkupIds.push(item.id); });
            }
        };
        if (lineMarkups.length > 0) await addItems(lineMarkups, TC_API.markup.addLineMarkup, TC_API.markup.addLineMarkups);
        if (textMarkups.length > 0) await addItems(textMarkups, TC_API.markup.addTextMarkup, TC_API.markup.addTextMarkups);
        sessionStorage.setItem('tc_markup_ids', JSON.stringify(activeMarkupIds));
        if (zoomToSelectionCheck.checked && minP.x !== Infinity) {
            await TC_API.viewer.setCamera({ target: { x: (minP.x + maxP.x)/2, y: (minP.y + maxP.y)/2, z: (minP.z + maxP.z)/2 }, distance: dist(minP, maxP) * 1.2 });
        }
        updateStatus("Drawing complete.");
    } catch (e) { updateStatus("Error: " + e.message); }
}

function formatStation(s) {
    const km = Math.floor(s / 1000), m = (s % 1000).toFixed(3);
    const mParts = m.split('.'), paddedM = mParts[0].padStart(3, '0');
    return `${km}+${paddedM}${mParts[1] !== '000' ? '.' + mParts[1] : ''}`;
}

function processAlignment(align, settings) {
    const lines = [], texts = [], points = [], toMM = 1000, labelHeightM = 1.5;
    const coordGeom = align.node.getElementsByTagName('CoordGeom')[0];
    if (!coordGeom) return { lines, texts };
    for (const child of coordGeom.children) {
        if (child.tagName === 'Line') {
            const start = parseCoord(child.getElementsByTagName('Start')[0]?.textContent, settings.swap), end = parseCoord(child.getElementsByTagName('End')[0]?.textContent, settings.swap);
            const sStart = parseFloat(child.getAttribute('staStart')), len = parseFloat(child.getAttribute('length'));
            if (isValid(start) && isValid(end)) { points.push({ ...start, sta: sStart }); points.push({ ...end, sta: sStart + len }); }
        } else if (child.tagName === 'Curve') {
            const start = parseCoord(child.getElementsByTagName('Start')[0]?.textContent, settings.swap), center = parseCoord(child.getElementsByTagName('Center')[0]?.textContent, settings.swap), end = parseCoord(child.getElementsByTagName('End')[0]?.textContent, settings.swap);
            const sStart = parseFloat(child.getAttribute('staStart')), len = parseFloat(child.getAttribute('length')), rad = parseFloat(child.getAttribute('radius')), rot = child.getAttribute('rot');
            if (isValid(start) && isValid(center) && isValid(end)) {
                const segs = Math.max(2, Math.ceil(len / 10)), sAng = Math.atan2(start.y - center.y, start.x - center.x);
                let eAng = Math.atan2(end.y - center.y, end.x - center.x);
                if (rot === 'cw' && eAng > sAng) eAng -= 2 * Math.PI;
                if (rot === 'ccw' && eAng < sAng) eAng += 2 * Math.PI;
                for (let i = 0; i <= segs; i++) { const t = i / segs, a = sAng + t * (eAng - sAng); points.push({ x: center.x + rad * Math.cos(a), y: center.y + rad * Math.sin(a), sta: sStart + t * len }); }
            }
        }
    }
    const pvis = [];
    if (align.profile) {
        const nodes = align.profile.getElementsByTagName('PVI');
        for (let i = 0; i < nodes.length; i++) {
            const parts = nodes[i].textContent.trim().split(/\s+/);
            if (parts.length >= 2) pvis.push({ sta: parseFloat(parts[0]), elev: parseFloat(parts[1]) });
        }
    }
    const getElev = (s) => {
        if (!pvis.length) return 0;
        if (s <= pvis[0].sta) return pvis[0].elev;
        if (s >= pvis[pvis.length-1].sta) return pvis[pvis.length-1].elev;
        for (let i = 0; i < pvis.length - 1; i++) { if (s >= pvis[i].sta && s <= pvis[i+1].sta) { const t = (s - pvis[i].sta) / (pvis[i+1].sta - pvis[i].sta); return pvis[i].elev + t * (pvis[i+1].elev - pvis[i].elev); } }
        return 0;
    };
    if (settings.drawAlign) {
        for (let i = 0; i < points.length - 1; i++) {
            const p1 = points[i], p2 = points[i+1];
            if (dist(p1, p2) < 0.001) continue;
            lines.push({ id: idCounter++, color: { r: 255, g: 255, b: 0, a: 1 }, start: { positionX: p1.x * toMM, positionY: p1.y * toMM, positionZ: getElev(p1.sta) * toMM }, end: { positionX: p2.x * toMM, positionY: p2.y * toMM, positionZ: getElev(p2.sta) * toMM } });
        }
    }
    if (settings.drawSta || settings.drawText) {
        const sSta = points[0]?.sta || 0, eSta = points[points.length-1]?.sta || 0, stations = [sSta];
        for (let s = Math.ceil(sSta / settings.interval) * settings.interval; s < eSta; s += settings.interval) { if (s > sSta + 0.01) stations.push(s); }
        if (eSta > sSta + 0.01) stations.push(eSta);
        for (const s of stations) {
            const p = interpolate(points, s); if (!p) continue;
            const el = getElev(s), pos = { positionX: p.x * toMM, positionY: p.y * toMM, positionZ: el * toMM };
            if (settings.drawText) {
                const ext = (s === sSta || s === eSta);
                texts.push({ id: idCounter++, text: ext ? (s === sSta ? `START KM ${formatStation(s)}` : `END KM ${formatStation(s)}`) : `KM ${formatStation(s)}`, color: ext ? { r: 255, g: 100, b: 0, a: 1 } : { r: 0, g: 255, b: 255, a: 1 }, start: pos, end: { ...pos, positionZ: (el + labelHeightM) * toMM } });
            }
            if (settings.drawSta) {
                const pN = interpolate(points, s + 0.1) || interpolate(points, s - 0.1);
                if (pN) {
                    const dx = pN.x - p.x, dy = pN.y - p.y, l = Math.sqrt(dx*dx + dy*dy);
                    if (l > 0.0001) {
                        const nx = -dy/l, ny = dx/l, tL = (s === sSta || s === eSta) ? 1.5 : 0.8;
                        lines.push({ id: idCounter++, color: (s === sSta || s === eSta) ? { r: 255, g: 100, b: 0, a: 1 } : { r: 0, g: 255, b: 255, a: 1 }, start: { positionX: (p.x - nx*tL)*toMM, positionY: (p.y - ny*tL)*toMM, positionZ: el*toMM }, end: { positionX: (p.x + nx*tL)*toMM, positionY: (p.y + ny*tL)*toMM, positionZ: el*toMM } });
                    }
                }
            }
        }
    }
    return { lines, texts };
}

function isValid(p) { return p && !isNaN(p.x) && !isNaN(p.y); }
function dist(p1, p2) { return Math.sqrt(Math.pow(p1.x-(p2.positionX||p2.x), 2) + Math.pow(p1.y-(p2.positionY||p2.y), 2)); }
function parseCoord(str, swap) {
    if (!str) return null;
    const pts = str.trim().split(/\s+/), v1 = parseFloat(pts[0]), v2 = parseFloat(pts[1]);
    return swap ? { x: v2, y: v1 } : { x: v1, y: v2 };
}
function interpolate(pts, s) {
    if (!pts.length) return null;
    if (s <= pts[0].sta + 0.001) return pts[0];
    if (s >= pts[pts.length-1].sta - 0.001) return pts[pts.length-1];
    for (let i = 0; i < pts.length - 1; i++) { if (s >= pts[i].sta && s <= pts[i+1].sta) { const t = (s - pts[i].sta) / (pts[i+1].sta - pts[i].sta); return { x: pts[i].x + t*(pts[i+1].x-pts[i].x), y: pts[i].y + t*(pts[i+1].y-pts[i].y) }; } }
    return null;
}

initTC();
